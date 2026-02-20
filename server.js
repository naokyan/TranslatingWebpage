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
    "translatedBlocks 要尽量细分为每一行/每一小段，不要给过大的框。",
    "每个框应紧贴原文字区域边界，减少空白边距，优先保证位置精确。",
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
    "summary 要用第二人称“你”，告诉你：这是什么类型内容，以及下一步需要做什么。",
    "summary 禁止出现流程性话术，例如“我已经为你翻译”“我已提供替换文本”“下一步你可以覆盖回原图”等。",
    "summary 只输出内容结论与建议动作，不要描述系统做了什么。",
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

  const textResult = await callGeminiWithFallback(
    uniqueList([MODEL, "gemini-2.5-flash", "gemini-flash-latest"]),
    geminiPayload
  );
  if (textResult.error) {
    sendJson(res, textResult.error.status, {
      error: "Gemini API error",
      detail: textResult.error.detail,
    });
    return;
  }

  let modelJson;
  try {
    const parsed = JSON.parse(textResult.raw || "{}");
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
  const summary = sanitizeSummaryText(String(data?.summary || "").trim(), translatedText);
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
    summary: summary || buildFallbackSummary(translatedText),
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

function sanitizeSummaryText(text, translatedText) {
  let out = String(text || "");

  const splitRegex = /[。！？!?；;\n]/;
  const sentences = out
    .split(splitRegex)
    .map((s) => s.trim())
    .filter(Boolean);

  const bannedKeywords = [
    "翻译",
    "替换",
    "覆盖",
    "原图",
    "文本",
    "识别",
    "提取",
    "模型",
    "我已经",
    "我已",
    "我为你",
    "下一步",
    "这段中文",
    "处理结果",
  ];

  const kept = sentences.filter((s) => !bannedKeywords.some((k) => s.includes(k)));
  out = kept.join("。").trim();
  if (out) out += "。";

  if (!out || out.length < 8) {
    return buildFallbackSummary(translatedText);
  }

  return out;
}

function buildFallbackSummary(translatedText) {
  const t = String(translatedText || "");
  if (!t) {
    return "这是一段图片内容。建议你先确认关键信息，再决定下一步操作。";
  }

  const lower = t.toLowerCase();
  if (hasAny(lower, ["menu", "dish", "price", "套餐", "菜单", "招牌", "价格"])) {
    return "这是一份餐饮菜单信息。建议你重点看招牌菜、价格和是否有套餐。";
  }
  if (hasAny(lower, ["dear", "regards", "subject", "邮件", "收件", "发件", "附件"])) {
    return "这是一条邮件类内容。建议你先看时间、主题和对你的具体要求。";
  }
  if (hasAny(lower, ["delivery", "package", "shipment", "包裹", "物流", "快递"])) {
    return "这是一条物流通知。建议你核对时间、地址和签收要求。";
  }
  if (hasAny(lower, ["contract", "agreement", "条款", "合同", "协议"])) {
    return "这是一份条款或协议内容。建议你重点确认责任、金额和截止时间。";
  }

  return "这是一段说明类内容。建议你关注时间、地点和需要你完成的事项。";
}

function hasAny(text, keywords) {
  return keywords.some((k) => text.includes(String(k).toLowerCase()));
}

async function callGeminiWithFallback(modelCandidates, payload) {
  let raw = "";
  let error = null;

  for (const modelName of modelCandidates) {
    const llmRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    raw = await llmRes.text();
    if (llmRes.ok) {
      return { raw, modelName, error: null };
    }

    const detail = safeJson(raw);
    error = { status: llmRes.status, detail };
    if (!isModelNotFoundError(llmRes.status, detail)) {
      break;
    }
  }

  return { raw, error };
}
