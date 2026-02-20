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
const resultPreview = document.getElementById("resultPreview");
const translatedText = document.getElementById("translatedText");
const summaryText = document.getElementById("summaryText");
const downloadBtn = document.getElementById("downloadBtn");

const previewCard = document.getElementById("previewCard");
const resultCard = document.getElementById("resultCard");
const textCard = document.getElementById("textCard");
const summaryCard = document.getElementById("summaryCard");

photoInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  hide(resultCard);
  hide(textCard);
  hide(summaryCard);

  const rawDataUrl = await fileToDataUrl(file);
  const optimized = await normalizeImageForUpload(rawDataUrl);

  sourcePreview.src = optimized.previewDataUrl;
  await waitImageLoaded(sourcePreview);
  show(previewCard);

  const defaultTitle = pageTitles["image-translate"];
  pageTitle.textContent = `${defaultTitle}（处理中）`;

  try {
    const result = await runImageTranslatePipeline(
      optimized.uploadDataUrl,
      sourcePreview.naturalWidth,
      sourcePreview.naturalHeight
    );

    translatedText.textContent = result.translatedText;
    summaryText.textContent = normalizeSummaryText(result.summary);

    const finalImageDataUrl = getResultImageDataUrl(sourcePreview, result);
    if (!result.translatedBlocks.length) {
      translatedText.textContent = `${translatedText.textContent}\n\n（未检测到需要替换的外文，结果图显示为原图）`;
    }

    resultPreview.src = finalImageDataUrl;
    downloadBtn.href = finalImageDataUrl;

    show(resultCard);
    show(textCard);
    show(summaryCard);
  } catch (error) {
    console.error(error);
    alert(error.message || "处理失败，请重试");
  } finally {
    pageTitle.textContent = defaultTitle;
  }
});

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

function getResultImageDataUrl(sourceImageEl, result) {
  if (!result.translatedBlocks.length) {
    return sourceImageEl.currentSrc || sourceImageEl.src || "";
  }

  return drawOverlayToDataUrl(sourceImageEl, result.translatedBlocks);
}

function drawOverlayToDataUrl(imageEl, blocks) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const width = imageEl.naturalWidth;
  const height = imageEl.naturalHeight;

  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(imageEl, 0, 0, width, height);

  blocks.forEach((rawBlock) => {
    const block = normalizeBlock(rawBlock, width, height);
    if (!block) return;

    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fillRect(block.x, block.y, block.width, block.height);

    const pad = getBlockPadding(block.height);
    const textAreaWidth = Math.max(10, block.width - pad * 2);
    const textAreaHeight = Math.max(10, block.height - pad * 2);
    const layout = fitTextToBox(ctx, block.text, textAreaWidth, textAreaHeight);

    ctx.fillStyle = "#111827";
    ctx.font = `${layout.fontSize}px sans-serif`;
    ctx.textBaseline = "top";

    const totalTextHeight = layout.lines.length * layout.lineHeight;
    const startY = block.y + pad + Math.max(0, Math.floor((textAreaHeight - totalTextHeight) / 2));

    layout.lines.forEach((line, index) => {
      const lineWidth = ctx.measureText(line).width;
      const startX = block.x + pad + Math.max(0, Math.floor((textAreaWidth - lineWidth) / 2));
      ctx.fillText(line, startX, startY + index * layout.lineHeight);
    });
  });

  return canvas.toDataURL("image/png");
}

function wrapText(ctx, text, maxWidth) {
  const chars = String(text || "").replace(/\s+/g, " ").trim().split("");
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

function normalizeSummaryText(text) {
  return String(text || "")
    .replaceAll("用户", "你")
    .replaceAll("使用者", "你")
    .replaceAll("读者", "你");
}

function fitTextToBox(ctx, text, boxWidth, boxHeight) {
  const maxFont = Math.max(16, Math.min(58, Math.floor(boxHeight * 0.7)));
  const minFont = 12;
  let best = null;

  for (let size = maxFont; size >= minFont; size -= 1) {
    ctx.font = `${size}px sans-serif`;
    const lineHeight = Math.max(16, Math.round(size * 1.28));
    const lines = wrapText(ctx, text, boxWidth);
    const needHeight = lines.length * lineHeight;
    if (needHeight <= boxHeight) {
      best = { fontSize: size, lineHeight, lines };
      break;
    }
  }

  if (best) return best;

  ctx.font = `${minFont}px sans-serif`;
  const lineHeight = Math.max(16, Math.round(minFont * 1.28));
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  const lines = wrapText(ctx, text, boxWidth).slice(0, maxLines);
  if (lines.length) {
    lines[lines.length - 1] = shrinkLineWithEllipsis(ctx, lines[lines.length - 1], boxWidth);
  }
  return { fontSize: minFont, lineHeight, lines };
}

function shrinkLineWithEllipsis(ctx, line, maxWidth) {
  let out = String(line || "");
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function normalizeBlock(rawBlock, imageWidth, imageHeight) {
  const x = Math.max(0, Math.round(Number(rawBlock?.x) || 0));
  const y = Math.max(0, Math.round(Number(rawBlock?.y) || 0));
  const width = Math.max(1, Math.round(Number(rawBlock?.width) || 0));
  const height = Math.max(1, Math.round(Number(rawBlock?.height) || 0));
  const text = String(rawBlock?.text || "").trim();
  if (!text) return null;

  const fixedWidth = Math.min(width, imageWidth - x);
  const fixedHeight = Math.min(height, imageHeight - y);
  if (fixedWidth <= 0 || fixedHeight <= 0) return null;
  return { x, y, width: fixedWidth, height: fixedHeight, text };
}

function getBlockPadding(blockHeight) {
  return Math.max(4, Math.min(14, Math.round(blockHeight * 0.08)));
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

  const uploadDataUrl = canvas.toDataURL("image/jpeg", 0.88);
  return {
    uploadDataUrl,
    previewDataUrl: uploadDataUrl,
  };
}
