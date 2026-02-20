const pageTitle = document.getElementById("pageTitle");
const pageTitles = {
  "image-translate": "图片翻译",
  "voice-translate": "语音翻译",
  settings: "更多功能",
};

const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const pages = Array.from(document.querySelectorAll(".page"));

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    navButtons.forEach((b) => b.classList.toggle("active", b === btn));
    pages.forEach((p) => p.classList.toggle("active", p.dataset.page === target));
    pageTitle.textContent = pageTitles[target] || "翻译助手";
  });
});

const photoInput = document.getElementById("photoInput");
const sourcePreview = document.getElementById("sourcePreview");
const resultCanvas = document.getElementById("resultCanvas");
const translatedText = document.getElementById("translatedText");
const summaryText = document.getElementById("summaryText");
const statusText = document.getElementById("statusText");
const downloadBtn = document.getElementById("downloadBtn");

const previewCard = document.getElementById("previewCard");
const resultCard = document.getElementById("resultCard");
const textCard = document.getElementById("textCard");
const summaryCard = document.getElementById("summaryCard");
const statusCard = document.getElementById("statusCard");

photoInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  show(statusCard);
  hide(resultCard);
  hide(textCard);
  hide(summaryCard);

  setStatus("正在读取图片...");

  const rawDataUrl = await fileToDataUrl(file);
  setStatus("正在优化图片大小...");
  const optimized = await normalizeImageForUpload(rawDataUrl);

  sourcePreview.src = optimized.previewDataUrl;
  await waitImageLoaded(sourcePreview);
  show(previewCard);

  try {
    setStatus("正在识别文字并翻译...");

    const result = await runImageTranslatePipeline(
      optimized.uploadDataUrl,
      sourcePreview.naturalWidth,
      sourcePreview.naturalHeight
    );

    setStatus("正在生成替换外文后的结果图...");
    drawTranslatedImage(sourcePreview, result);

    translatedText.textContent = result.translatedText;
    summaryText.textContent = result.summary;

    show(resultCard);
    show(textCard);
    show(summaryCard);

    setStatus("完成");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "处理失败，请重试。可在控制台查看错误详情。");
  }
});

function setStatus(text) {
  statusText.textContent = text;
}

function show(el) {
  el.classList.remove("hidden");
}

function hide(el) {
  el.classList.add("hidden");
}

async function runImageTranslatePipeline(imageDataUrl, imageWidth, imageHeight) {
  const res = await fetch("/api/image-translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      imageDataUrl,
      imageWidth,
      imageHeight,
    }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("服务端返回了不可解析的数据");
  }

  if (!res.ok) {
    const detail = data?.detail ? `：${JSON.stringify(data.detail)}` : "";
    throw new Error(`${data?.error || "接口调用失败"}${detail}`);
  }

  return {
    translatedText: String(data.translatedText || "未识别到可翻译文本。"),
    summary: String(data.summary || "未生成总结。"),
    translatedBlocks: Array.isArray(data.translatedBlocks) ? data.translatedBlocks : [],
  };
}

function drawTranslatedImage(imageEl, result) {
  const ctx = resultCanvas.getContext("2d");
  const width = imageEl.naturalWidth;
  const height = imageEl.naturalHeight;

  resultCanvas.width = width;
  resultCanvas.height = height;

  ctx.drawImage(imageEl, 0, 0, width, height);

  result.translatedBlocks.forEach((block) => {
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fillRect(block.x, block.y, block.width, block.height);

    ctx.strokeStyle = "#d3d8e6";
    ctx.strokeRect(block.x, block.y, block.width, block.height);

    const fontSize = calculateFontSize(block.height);
    ctx.fillStyle = "#111827";
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = "top";

    const lines = wrapText(ctx, block.text, Math.max(block.width - 12, 20));
    const lineHeight = Math.round(fontSize * 1.35);
    const maxLines = Math.max(1, Math.floor((block.height - 10) / lineHeight));

    lines.slice(0, maxLines).forEach((line, index) => {
      ctx.fillText(line, block.x + 6, block.y + 6 + index * lineHeight);
    });
  });

  downloadBtn.href = resultCanvas.toDataURL("image/png");
}

function wrapText(ctx, text, maxWidth) {
  const chars = String(text || "").split("");
  const lines = [];
  let current = "";

  chars.forEach((char) => {
    const testLine = current + char;
    if (ctx.measureText(testLine).width > maxWidth && current) {
      lines.push(current);
      current = char;
    } else {
      current = testLine;
    }
  });

  if (current) lines.push(current);
  return lines;
}

function calculateFontSize(blockHeight) {
  const size = Math.round(blockHeight * 0.35);
  return Math.max(14, Math.min(size, 42));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function waitImageLoaded(imgEl) {
  return new Promise((resolve, reject) => {
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      resolve();
      return;
    }

    imgEl.onload = () => resolve();
    imgEl.onerror = () => reject(new Error("图片加载失败"));
  });
}

async function normalizeImageForUpload(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("图片加载失败"));
  });

  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const uploadDataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return {
    uploadDataUrl,
    previewDataUrl: uploadDataUrl,
  };
}
