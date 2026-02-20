const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && requestUrl.pathname === "/api/image-translate") {
      await handleImageTranslate(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStaticFile(requestUrl.pathname, res);
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (error) {
    console.error("Unhandled server error:", error);
    sendJson(res, 500, { error: "Server error", detail: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server started: http://${HOST}:${PORT}`);
});

async function handleImageTranslate(req, res) {
  if (!GEMINI_API_KEY) {
    sendJson(res, 500, {
      error: "GEMINI_API_KEY is missing",
      detail: "Please set GEMINI_API_KEY before starting the server.",
    });
    return;
  }

  const body = await readJsonBody(req);
  const imageDataUrl = body?.imageDataUrl;
  const imageWidth = Number(body?.imageWidth);
  const imageHeight = Number(body?.imageHeight);

  if (!imageDataUrl || !String(imageDataUrl).startsWith("data:image/")) {
    sendJson(res, 400, { error: "Invalid imageDataUrl" });
    return;
  }

  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth < 1 || imageHeight < 1) {
    sendJson(res, 400, { error: "Invalid image dimensions" });
    return;
  }

  const parsedImage = parseDataUrl(imageDataUrl);
  if (!parsedImage) {
    sendJson(res, 400, { error: "Invalid image data URL format" });
    return;
  }

  const prompt = [
    "你是图片翻译与信息总结助手。",
    "请识别图片中的外文文本，翻译成简体中文，并用于生成覆盖回原图的替换文本。",
    "必须只返回 JSON，不要返回 Markdown。",
    "返回字段格式：",
    "{",
    '  \"translatedText\": \"string, 全量中文翻译\",',
    '  \"summary\": \"string, 对图片内容做任务导向总结\",',
    '  \"translatedBlocks\": [',
    "    {",
    '      \"x\": number, \"y\": number, \"width\": number, \"height\": number,',
    '      \"text\": \"string, 要覆盖写回去的中文\"',
    "    }",
    "  ]",
    "}",
    `其中 x/y/width/height 必须是像素坐标，基于原图尺寸 ${imageWidth}x${imageHeight}。`,
    "如果图片中没有明显外文，请 translatedBlocks 返回空数组，translatedText 简述原文主要信息，summary 说明无需翻译。",
    "summary 要能告诉用户：这是什么类型内容，以及下一步需要做什么。",
  ].join("\n");

  const geminiPayload = {
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: parsedImage.mimeType,
              data: parsedImage.base64Data,
            },
          },
        ],
      },
    ],
  };

  const modelCandidates = uniqueList([
    MODEL,
    "gemini-2.5-flash",
    "gemini-flash-latest",
  ]);

  let raw = "";
  let llmError = null;
  for (const modelName of modelCandidates) {
    const llmRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(geminiPayload),
      }
    );

    raw = await llmRes.text();
    if (llmRes.ok) {
      llmError = null;
      break;
    }

    const detail = safeJson(raw);
    llmError = { status: llmRes.status, detail };
    if (!isModelNotFoundError(llmRes.status, detail)) {
      break;
    }
  }

  if (llmError) {
    sendJson(res, llmError.status, {
      error: "Gemini API error",
      detail: llmError.detail,
    });
    return;
  }

  let modelJson;
  try {
    const parsed = JSON.parse(raw);
    const content = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    modelJson = parseJsonSafely(content);
  } catch (err) {
    sendJson(res, 500, {
      error: "Invalid model response",
      detail: String(err?.message || err),
    });
    return;
  }

  const cleaned = sanitizeModelOutput(modelJson, imageWidth, imageHeight);
  sendJson(res, 200, cleaned);
}

function sanitizeModelOutput(data, imageWidth, imageHeight) {
  const translatedText = String(data?.translatedText || "").trim();
  const summary = String(data?.summary || "").trim();
  const blocks = Array.isArray(data?.translatedBlocks) ? data.translatedBlocks : [];

  const translatedBlocks = blocks
    .map((b) => ({
      x: clampInt(b?.x, 0, imageWidth),
      y: clampInt(b?.y, 0, imageHeight),
      width: clampInt(b?.width, 1, imageWidth),
      height: clampInt(b?.height, 1, imageHeight),
      text: String(b?.text || "").trim(),
    }))
    .filter((b) => b.text.length > 0)
    .map((b) => ({
      ...b,
      width: Math.min(b.width, imageWidth - b.x),
      height: Math.min(b.height, imageHeight - b.y),
    }))
    .filter((b) => b.width > 0 && b.height > 0);

  return {
    translatedText: translatedText || "未识别到可翻译文本。",
    summary: summary || "未生成总结。",
    translatedBlocks,
  };
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function serveStaticFile(pathname, res) {
  let targetPath = pathname;
  if (targetPath === "/") targetPath = "/index.html";

  // Normalize to workspace-relative path (prevent absolute-path escape on Windows/Unix).
  const normalized = path.posix.normalize(String(targetPath).replace(/\\/g, "/"));
  const relPath = normalized.replace(/^\/+/, "").replace(/^(\.\.\/)+/, "") || "index.html";
  const filePath = path.join(process.cwd(), relPath);

  if (!filePath.startsWith(process.cwd())) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        sendJson(res, 404, { error: "File not found" });
      } else {
        sendJson(res, 500, { error: "Read file error", detail: err.message });
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 15 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseJsonSafely(text) {
  if (typeof text !== "string") return {};

  const trimmed = text.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    const noFence = trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(noFence);
  }
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;

  return {
    mimeType: match[1],
    base64Data: match[2],
  };
}

function isModelNotFoundError(status, detail) {
  if (status !== 404) return false;
  const message = String(detail?.error?.message || "").toLowerCase();
  return message.includes("model") && (message.includes("not found") || message.includes("no longer available"));
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
