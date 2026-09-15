/**
 * PDF text extraction + Chinese overlay composition using pdf.js + canvas.
 */
(function (global) {
  "use strict";

  const FONT_STACK =
    '"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",SimHei,sans-serif';

  function setWorker() {
    if (!global.pdfjsLib) throw new Error("pdf.js 未加载");
    // CDN worker
    global.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  async function loadDocument(arrayBuffer) {
    setWorker();
    const loadingTask = global.pdfjsLib.getDocument({ data: arrayBuffer });
    return await loadingTask.promise;
  }

  /** pdf.js text item transform → bbox in PDF user space (y from bottom) */
  function cleanPdfText(s) {
    if (!s) return "";
    return String(s)
      // pdf.js / Illustrator ligature placeholders
      .replace(/\/f_/g, "f")
      .replace(/\/_\//g, "")
      .replace(/\/ffl/g, "ffl")
      .replace(/\/ff/g, "ff")
      .replace(/\/fi/g, "fi")
      .replace(/\/fl/g, "fl")
      .replace(/�/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function itemToBox(item) {
    const tx = item.transform || [1, 0, 0, 1, 0, 0];
    const x = tx[4];
    const y = tx[5];
    const fontHeight = Math.abs(tx[3]) || item.height || 10;
    const str = cleanPdfText(item.str);
    const width = item.width || (str ? str.length * fontHeight * 0.5 : 0);
    return {
      x: x,
      y: y - fontHeight * 0.15,
      w: width,
      h: fontHeight * 1.15,
      fontHeight: fontHeight,
      raw: str,
    };
  }

  function boxesOverlap(a, b, pad) {
    pad = pad || 0;
    return !(
      a.x + a.w + pad < b.x ||
      b.x + b.w + pad < a.x ||
      a.y + a.h + pad < b.y ||
      b.y + b.h + pad < a.y
    );
  }

  /** Merge nearby text items into line-like blocks (same-ish baseline). */
  function groupItems(items, pageWidth, pageHeight) {
    const boxes = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const str = (it.str || "").trim();
      if (!str) continue;
      const box = itemToBox(it);
      if (box.w <= 0 || box.h <= 0) continue;
      // Normalize: if y looks like top-space due to flipped matrix, still usable
      boxes.push(box);
    }

    // Sort by y desc (top first in PDF bottom-origin: higher y is upper), then x
    boxes.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
      return a.x - b.x;
    });

    const lines = [];
    const used = new Array(boxes.length).fill(false);

    for (let i = 0; i < boxes.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const line = {
        x: boxes[i].x,
        y: boxes[i].y,
        w: boxes[i].w,
        h: boxes[i].h,
        fontHeight: boxes[i].fontHeight,
        parts: [boxes[i]],
        text: boxes[i].raw,
      };

      for (let j = i + 1; j < boxes.length; j++) {
        if (used[j]) continue;
        const b = boxes[j];
        const yClose = Math.abs(b.y - line.y) < Math.max(3, line.fontHeight * 0.35);
        const xNear =
          b.x < line.x + line.w + Math.max(12, line.fontHeight * 1.2) &&
          b.x + b.w > line.x - Math.max(8, line.fontHeight);
        if (yClose && xNear) {
          used[j] = true;
          line.parts.push(b);
          line.x = Math.min(line.x, b.x);
          line.y = Math.min(line.y, b.y);
          line.w = Math.max(line.x + line.w, b.x + b.w) - line.x;
          line.h = Math.max(line.y + line.h, b.y + b.h) - line.y;
          line.fontHeight = Math.max(line.fontHeight, b.fontHeight);
          // Rebuild text sorted by x
          line.parts.sort(function (p, q) {
            return p.x - q.x;
          });
          line.text = line.parts
            .map(function (p) {
              return p.raw;
            })
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        }
      }

      if (line.text) lines.push(line);
    }

    return { lines: lines, boxes: boxes, pageWidth: pageWidth, pageHeight: pageHeight };
  }

  /**
   * Extract text layout for one page.
   * Returns { lines, textItems, hasText, viewport }
   */
  async function extractPage(pdfPage, scale) {
    scale = scale || 1;
    const viewport = pdfPage.getViewport({ scale: 1 });
    const content = await pdfPage.getTextContent();
    const grouped = groupItems(content.items, viewport.width, viewport.height);
    const hasText = grouped.lines.length > 0 && grouped.boxes.length > 0;
    return {
      page: pdfPage,
      viewport: viewport,
      lines: grouped.lines,
      boxes: grouped.boxes,
      hasText: hasText,
      rawItems: content.items,
    };
  }

  /** Sample cover color from a ring around a canvas-space rect (top-left origin). */
  function sampleBackground(ctx, x, y, w, h, canvasW, canvasH) {
    const pts = [
      [x - 2, y - 2],
      [x + w + 2, y - 2],
      [x - 2, y + h + 2],
      [x + w + 2, y + h + 2],
      [x + w / 2, y - 3],
      [x + w / 2, y + h + 3],
      [x - 4, y + h / 2],
      [x + w + 4, y + h / 2],
    ];
    const light = [];
    for (let i = 0; i < pts.length; i++) {
      const px = Math.max(0, Math.min(canvasW - 1, Math.round(pts[i][0])));
      const py = Math.max(0, Math.min(canvasH - 1, Math.round(pts[i][1])));
      const d = ctx.getImageData(px, py, 1, 1).data;
      const rgb = [d[0], d[1], d[2]];
      const max = Math.max(rgb[0], rgb[1], rgb[2]);
      const min = Math.min(rgb[0], rgb[1], rgb[2]);
      const sat = max - min;
      const bright = (rgb[0] + rgb[1] + rgb[2]) / 3;
      if (bright > 200 && sat < 28) light.push(rgb);
    }
    if (!light.length) return "#ffffff";
    light.sort(function (a, b) {
      return a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]);
    });
    const mid = light[Math.floor(light.length / 2)];
    return "rgb(" + mid[0] + "," + mid[1] + "," + mid[2] + ")";
  }

  function wrapText(ctx, text, maxWidth) {
    if (!text) return [];
    // Prefer breaking on CJK and spaces
    const chars = Array.from(text);
    const lines = [];
    let current = "";
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const trial = current + ch;
      if (ctx.measureText(trial).width > maxWidth && current) {
        lines.push(current);
        current = ch === " " ? "" : ch;
      } else {
        current = trial;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  /**
   * Render a page to canvas, optionally covering source text and drawing Chinese.
   * options: { cover: boolean, items: [{src, dst, line}] }
   */
  async function renderPageComposed(pdfPage, options) {
    options = options || {};
    const scale = options.scale || 2;
    const viewport = pdfPage.getViewport({ scale: scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;

    if (!options.cover || !options.lines || !options.lines.length) {
      return canvas;
    }

    const map = options.map || {};
    for (let i = 0; i < options.lines.length; i++) {
      const line = options.lines[i];
      const dst = map[line.text] != null ? map[line.text] : line.text;
      if (!dst) continue;
      // Leave untouched text as-is (already Chinese, or pure codes kept)
      if (dst === line.text) continue;

      // Convert PDF units to canvas pixels
      const x = line.x * scale;
      const yTop = canvas.height - (line.y + line.h) * scale;
      const w = Math.max(line.w * scale, 4);
      const h = Math.max(line.h * scale, 4);
      const padX = Math.max(2, 1.5 * scale);
      const padY = Math.max(1, 1.0 * scale);

      const bg = sampleBackground(
        ctx,
        x - padX,
        yTop - padY,
        w + padX * 2,
        h + padY * 2,
        canvas.width,
        canvas.height
      );

      // Cover original
      ctx.fillStyle = bg;
      ctx.fillRect(x - padX, yTop - padY, w + padX * 2, h + padY * 2);

      // Fit Chinese font size
      let fontSize = line.fontHeight * scale * 0.92;
      const maxW = w + padX * 0.5;
      ctx.font = "500 " + fontSize + "px " + FONT_STACK;
      let lines = wrapText(ctx, dst, maxW);
      // Shrink if wrapped too much vertically
      let guard = 0;
      while (lines.length * fontSize * 1.25 > h * 1.6 && fontSize > 6 && guard < 12) {
        fontSize *= 0.9;
        ctx.font = "500 " + fontSize + "px " + FONT_STACK;
        lines = wrapText(ctx, dst, maxW);
        guard++;
      }

      ctx.fillStyle = options.textColor || "#111111";
      ctx.textBaseline = "top";
      const lineH = fontSize * 1.2;
      const blockH = lines.length * lineH;
      let startY = yTop + Math.max(0, (h - blockH) / 2);
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], x, startY + li * lineH);
      }
    }

    return canvas;
  }

  /** Render original page only (for compare view). */
  async function renderPageOriginal(pdfPage, scale) {
    return renderPageComposed(pdfPage, { scale: scale || 2, cover: false });
  }

  /** Build a multi-page PDF from canvases using jsPDF. */
  function canvasesToPdf(canvases) {
    if (!canvases.length) throw new Error("没有可导出的页面");
    const { jsPDF } = global.jspdf;
    let pdf = null;
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i];
      const orientation = canvas.width >= canvas.height ? "landscape" : "portrait";
      const pxW = canvas.width;
      const pxH = canvas.height;
      // Use pt units matching aspect; scale so max side ~ 842 or 595
      const maxSide = orientation === "landscape" ? 842 : 595;
      const k = maxSide / Math.max(pxW, pxH);
      const w = pxW * k;
      const h = pxH * k;
      if (i === 0) {
        pdf = new jsPDF({ orientation: orientation, unit: "pt", format: [w, h] });
      } else {
        pdf.addPage([w, h], orientation);
      }
      const data = canvas.toDataURL("image/jpeg", 0.92);
      pdf.addImage(data, "JPEG", 0, 0, w, h, undefined, "FAST");
    }
    return pdf;
  }

  function downloadPdf(pdf, filename) {
    pdf.save(filename || "translated.pdf");
  }

  global.PdfEngine = {
    loadDocument: loadDocument,
    extractPage: extractPage,
    renderPageComposed: renderPageComposed,
    renderPageOriginal: renderPageOriginal,
    canvasesToPdf: canvasesToPdf,
    downloadPdf: downloadPdf,
    FONT_STACK: FONT_STACK,
  };
})(window);
