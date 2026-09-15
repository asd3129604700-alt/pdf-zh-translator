/**
 * Image OCR + Chinese overlay using Tesseract.js (browser-local).
 */
(function (global) {
  "use strict";

  const OCR_LANG = "eng";
  let workerPromise = null;

  function ensureTesseract() {
    if (!global.Tesseract) {
      return Promise.reject(new Error("Tesseract.js 未加载"));
    }
    return Promise.resolve();
  }

  async function getWorker(onProgress) {
    await ensureTesseract();
    if (!workerPromise) {
      workerPromise = (async function () {
        const worker = await global.Tesseract.createWorker(OCR_LANG, 1, {
          logger: function (m) {
            if (onProgress && m.status) {
              onProgress(m);
            }
          },
        });
        return worker;
      })();
    }
    return workerPromise;
  }

  function loadFileToCanvas(file, maxSide) {
    maxSide = maxSide || 1800;
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ canvas: canvas, width: w, height: h, file: file });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取图片：" + (file.name || "")));
      };
      img.src = url;
    });
  }

  function cleanOcrText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/^[^\w一-鿿]+|[^\w一-鿿]+$/g, "")
      .trim();
  }

  /** Group Tesseract words into line-like blocks (canvas coords, top-left). */
  function wordsToLines(words) {
    const items = [];
    for (let i = 0; i < (words || []).length; i++) {
      const w = words[i];
      const text = cleanOcrText(w.text);
      if (!text) continue;
      const conf = typeof w.confidence === "number" ? w.confidence : 100;
      if (conf < 40) continue;
      const b = w.bbox || {};
      const x0 = b.x0 || 0;
      const y0 = b.y0 || 0;
      const x1 = b.x1 || x0;
      const y1 = b.y1 || y0;
      const box = {
        x: x0,
        y: y0,
        w: Math.max(1, x1 - x0),
        h: Math.max(1, y1 - y0),
        fontHeight: Math.max(8, y1 - y0),
        raw: text,
      };
      items.push(box);
    }

    items.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > 6) return a.y - b.y;
      return a.x - b.x;
    });

    const lines = [];
    const used = new Array(items.length).fill(false);
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const line = {
        x: items[i].x,
        y: items[i].y,
        w: items[i].w,
        h: items[i].h,
        fontHeight: items[i].fontHeight,
        parts: [items[i]],
        text: items[i].raw,
      };
      for (let j = i + 1; j < items.length; j++) {
        if (used[j]) continue;
        const b = items[j];
        const yClose = Math.abs(b.y + b.h / 2 - (line.y + line.h / 2)) < Math.max(8, line.h * 0.6);
        const xNear = b.x < line.x + line.w + Math.max(18, line.fontHeight * 1.5);
        if (yClose && xNear) {
          used[j] = true;
          line.parts.push(b);
          line.x = Math.min(line.x, b.x);
          line.y = Math.min(line.y, b.y);
          line.w = Math.max(line.x + line.w, b.x + b.w) - line.x;
          line.h = Math.max(line.y + line.h, b.y + b.h) - line.y;
          line.fontHeight = Math.max(line.fontHeight, b.fontHeight);
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
      if (line.text && line.text.length >= 2) lines.push(line);
    }
    return lines;
  }

  /**
   * OCR one image canvas.
   * onProgress({ status, progress })
   */
  async function ocrCanvas(canvas, onProgress) {
    const worker = await getWorker(onProgress);
    const result = await worker.recognize(canvas);
    const data = result && result.data;
    const words = (data && data.words) || [];
    // Prefer data.lines when available (better grouping)
    let lines = [];
    if (data && data.lines && data.lines.length) {
      for (let i = 0; i < data.lines.length; i++) {
        const ln = data.lines[i];
        const text = cleanOcrText(ln.text);
        const b = ln.bbox || {};
        if (!text || text.length < 2) continue;
        lines.push({
          x: b.x0 || 0,
          y: b.y0 || 0,
          w: Math.max(1, (b.x1 || 0) - (b.x0 || 0)),
          h: Math.max(1, (b.y1 || 0) - (b.y0 || 0)),
          fontHeight: Math.max(10, (b.y1 || 0) - (b.y0 || 0)),
          text: text,
          parts: [],
        });
      }
    }
    if (!lines.length) lines = wordsToLines(words);
    return { lines: lines, words: words, text: (data && data.text) || "" };
  }

  /** Overlay Chinese onto a canvas (mutates and returns same canvas). Lines use canvas coords. */
  function overlayLines(sourceCanvas, lines, map, options) {
    options = options || {};
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0);

    if (!options.cover || !lines || !lines.length) return canvas;

    const helpers = global.PdfEngine;
    const FONT_STACK = (helpers && helpers.FONT_STACK) ||
      '"Microsoft YaHei","PingFang SC","Noto Sans SC",SimHei,sans-serif';

    function sampleLight(x, y, w, h) {
      const pts = [
        [x - 2, y - 2],
        [x + w + 2, y - 2],
        [x - 2, y + h + 2],
        [x + w + 2, y + h + 2],
        [x + w / 2, y - 3],
        [x + w / 2, y + h + 3],
      ];
      const light = [];
      for (let i = 0; i < pts.length; i++) {
        const px = Math.max(0, Math.min(canvas.width - 1, Math.round(pts[i][0])));
        const py = Math.max(0, Math.min(canvas.height - 1, Math.round(pts[i][1])));
        const d = ctx.getImageData(px, py, 1, 1).data;
        const rgb = [d[0], d[1], d[2]];
        const max = Math.max(rgb[0], rgb[1], rgb[2]);
        const min = Math.min(rgb[0], rgb[1], rgb[2]);
        const bright = (rgb[0] + rgb[1] + rgb[2]) / 3;
        if (bright > 200 && max - min < 28) light.push(rgb);
      }
      if (!light.length) return "#ffffff";
      light.sort(function (a, b) {
        return a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]);
      });
      const mid = light[Math.floor(light.length / 2)];
      return "rgb(" + mid[0] + "," + mid[1] + "," + mid[2] + ")";
    }

    function wrap(text, maxW) {
      const chars = Array.from(text || "");
      const out = [];
      let cur = "";
      for (let i = 0; i < chars.length; i++) {
        const trial = cur + chars[i];
        if (ctx.measureText(trial).width > maxW && cur) {
          out.push(cur);
          cur = chars[i] === " " ? "" : chars[i];
        } else {
          cur = trial;
        }
      }
      if (cur) out.push(cur);
      return out;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const dst = map[line.text] != null ? map[line.text] : line.text;
      if (!dst || dst === line.text) continue;

      const pad = Math.max(2, Math.round(line.fontHeight * 0.12));
      const x = line.x - pad;
      const y = line.y - pad;
      const w = line.w + pad * 2;
      const h = line.h + pad * 2;

      ctx.fillStyle = sampleLight(x, y, w, h);
      ctx.fillRect(x, y, w, h);

      let fontSize = Math.max(10, line.fontHeight * 0.92);
      ctx.font = "500 " + fontSize + "px " + FONT_STACK;
      let wrapped = wrap(dst, line.w);
      let guard = 0;
      while (wrapped.length * fontSize * 1.25 > line.h * 1.7 && fontSize > 8 && guard < 14) {
        fontSize *= 0.9;
        ctx.font = "500 " + fontSize + "px " + FONT_STACK;
        wrapped = wrap(dst, line.w);
        guard++;
      }

      ctx.fillStyle = options.textColor || "#111111";
      ctx.textBaseline = "top";
      const lineH = fontSize * 1.2;
      const blockH = wrapped.length * lineH;
      const startY = line.y + Math.max(0, (line.h - blockH) / 2);
      for (let li = 0; li < wrapped.length; li++) {
        ctx.fillText(wrapped[li], line.x, startY + li * lineH);
      }
    }

    return canvas;
  }

  async function terminateWorker() {
    if (workerPromise) {
      try {
        const w = await workerPromise;
        await w.terminate();
      } catch (e) {
        /* ignore */
      }
      workerPromise = null;
    }
  }

  global.ImageEngine = {
    loadFileToCanvas: loadFileToCanvas,
    ocrCanvas: ocrCanvas,
    overlayLines: overlayLines,
    terminateWorker: terminateWorker,
  };
})(window);
