/**
 * Image OCR + Chinese overlay.
 * Quality-focused Tesseract pipeline + optional Gemini vision translate.
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
            if (onProgress && m.status) onProgress(m);
          },
        });
        // Sparse text works better on annotated product specs / diagrams
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: "11",
            tessedit_char_whitelist:
              "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,;:!?\"'()-/&#%@+*",
          });
        } catch (e) {
          /* older API may not support setParameters */
        }
        return worker;
      })();
    }
    return workerPromise;
  }

  function loadFileToCanvas(file, maxSide) {
    maxSide = maxSide || 2200;
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        // Upscale small images a bit for OCR
        let scale = Math.min(1, maxSide / Math.max(w, h));
        if (Math.max(w, h) < 900) scale = Math.min(2, (1200 / Math.max(w, h)));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
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

  /** Grayscale + contrast boost copy for OCR (keeps original canvas for overlay). */
  function makeOcrCanvas(source) {
    const c = document.createElement("canvas");
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    // First pass: luminance
    const lum = new Float32Array(d.length / 4);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    // Percentile stretch
    const sorted = Array.from(lum).sort(function (a, b) {
      return a - b;
    });
    const lo = sorted[Math.floor(sorted.length * 0.05)] || 0;
    const hi = sorted[Math.floor(sorted.length * 0.95)] || 255;
    const range = Math.max(1, hi - lo);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = ((lum[p] - lo) / range) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      // S-curve to push midtones apart
      v = 255 * (v / 255) * (v / 255) * (3 - 2 * (v / 255));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  const GLOSSARY_EXTRA = [
    [/\bSEPARATE PIECE\b/gi, "独立部件"],
    [/\bMATERIAL SPEC\b/gi, "材质规格"],
    [/\bMINI PLUSH\b/gi, "迷你毛绒"],
    [/\bPRINTED GRAPHIC\b/gi, "印花图案"],
    [/\bEMBROIDERY\b/gi, "刺绣"],
    [/\bAPPLIQUE\b/gi, "贴布绣"],
    [/\bHair accessories\b/gi, "发饰"],
    [/\bAll Face Details\b/gi, "全部面部细节"],
    [/\bFront of Hair\b/gi, "前发"],
    [/\bRibbons\/Material\b/gi, "丝带/材质"],
    [/\bPlease use same execution for hair & face embroidery & applique\b/gi,
      "头发与面部刺绣、贴布请使用相同工艺"],
    [/\bKeep away from fire\b/gi, "远离火源"],
    [/\bNot for children under 3 years\b/gi, "不适合3岁以下儿童"],
  ];

  function applyLocalGlossary(text) {
    let out = text;
    for (let i = 0; i < GLOSSARY_EXTRA.length; i++) {
      out = out.replace(GLOSSARY_EXTRA[i][0], GLOSSARY_EXTRA[i][1]);
    }
    return out;
  }

  function cleanOcrText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/^[^\w一-鿿]+|[^\w一-鿿]+$/g, "")
      .trim();
  }

  function isMostlyLetters(s) {
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const others = (s.match(/[^A-Za-z0-9\s.,;:!'\"()\-\/&#%@+*]/g) || []).length;
    return letters >= 2 && others <= Math.max(1, letters * 0.35);
  }

  function looksLikeGarbage(s) {
    if (!s || s.length < 2) return true;
    // Too many random punctuation / mixed scripts
    if (/[^A-Za-z0-9\s.,;:!'\"()\-\/&#%@+*]/.test(s)) return true;
    // Alternating case chaos or symbol soup
    if ((s.match(/[^A-Za-z0-9\s]/g) || []).length > s.length * 0.4) return true;
    // Repeated single chars
    if (/^(.)\1+$/.test(s.replace(/\s/g, ""))) return true;
    return false;
  }

  /** Sample region: light bg? colorful? text-like contrast? */
  function analyzeRegion(ctx, x, y, w, h) {
    const pad = 2;
    x = Math.max(0, Math.round(x - pad));
    y = Math.max(0, Math.round(y - pad));
    w = Math.min(ctx.canvas.width - x, Math.round(w + pad * 2));
    h = Math.min(ctx.canvas.height - y, Math.round(h + pad * 2));
    if (w <= 0 || h <= 0) {
      return { light: true, colorful: false, cover: "#ffffff", textColor: "#111111" };
    }
    // Sample a grid inside the box
    const cols = Math.min(8, Math.max(3, Math.floor(w / 8)));
    const rows = Math.min(6, Math.max(2, Math.floor(h / 6)));
    const pixels = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = Math.min(ctx.canvas.width - 1, x + Math.floor(((c + 0.5) / cols) * w));
        const py = Math.min(ctx.canvas.height - 1, y + Math.floor(((r + 0.5) / rows) * h));
        const d = ctx.getImageData(px, py, 1, 1).data;
        pixels.push([d[0], d[1], d[2]]);
      }
    }
    // Ring samples outside box for cover color
    const ring = [];
    const ringPts = [
      [x - 2, y - 2],
      [x + w + 2, y - 2],
      [x - 2, y + h + 2],
      [x + w + 2, y + h + 2],
      [x + w / 2, y - 3],
      [x + w / 2, y + h + 3],
      [x - 4, y + h / 2],
      [x + w + 4, y + h / 2],
    ];
    for (let i = 0; i < ringPts.length; i++) {
      const px = Math.max(0, Math.min(ctx.canvas.width - 1, Math.round(ringPts[i][0])));
      const py = Math.max(0, Math.min(ctx.canvas.height - 1, Math.round(ringPts[i][1])));
      const d = ctx.getImageData(px, py, 1, 1).data;
      ring.push([d[0], d[1], d[2]]);
    }

    function sat(rgb) {
      return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    }
    function bright(rgb) {
      return (rgb[0] + rgb[1] + rgb[2]) / 3;
    }

    // Interior: count dark text-like pixels vs colorful bg
    let dark = 0;
    let colorful = 0;
    let light = 0;
    let darkest = [255, 255, 255];
    for (let i = 0; i < pixels.length; i++) {
      const b = bright(pixels[i]);
      const s = sat(pixels[i]);
      if (b < 100) {
        dark++;
        if (bright(darkest) > b) darkest = pixels[i];
      }
      if (s > 40 && b > 40) colorful++;
      if (b > 210 && s < 25) light++;
    }
    const n = pixels.length || 1;
    const isColorfulBg = colorful / n > 0.35 && dark / n < 0.45;

    // Pick a uniform cover color from the ring (handles dark headers too)
    let cover = "#ffffff";
    let coverIsDark = false;
    if (ring.length) {
      // Prefer samples that look like flat background (low saturation)
      const flat = ring.filter(function (rgb) {
        return sat(rgb) < 40;
      });
      const pool = flat.length ? flat : ring;
      pool.sort(function (a, b) {
        return a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]);
      });
      const mid = pool[Math.floor(pool.length / 2)];
      cover = "rgb(" + mid[0] + "," + mid[1] + "," + mid[2] + ")";
      coverIsDark = bright(mid) < 90;
    }

    // Text color: light on dark cover; keep colored ink on light cover
    let textColor = coverIsDark ? "#ffffff" : "#111111";
    if (!coverIsDark && dark > 0) {
      const dr = Math.min(255, Math.round(darkest[0] * 0.9));
      const dg = Math.min(255, Math.round(darkest[1] * 0.9));
      const db = Math.min(255, Math.round(darkest[2] * 0.9));
      if (sat(darkest) > 40 && bright(darkest) < 150) {
        textColor = "rgb(" + dr + "," + dg + "," + db + ")";
      }
    }

    return {
      colorful: isColorfulBg,
      light: light / n > 0.4,
      cover: cover,
      textColor: textColor,
      coverIsDark: coverIsDark,
      darkRatio: dark / n,
    };
  }

  /** Group words into lines with tighter thresholds. */
  function wordsToLines(words) {
    const items = [];
    for (let i = 0; i < (words || []).length; i++) {
      const w = words[i];
      const text = cleanOcrText(w.text);
      if (!text || looksLikeGarbage(text) || !isMostlyLetters(text)) continue;
      const conf = typeof w.confidence === "number" ? w.confidence : 100;
      if (conf < 55) continue;
      const b = w.bbox || {};
      const x0 = b.x0 || 0;
      const y0 = b.y0 || 0;
      const x1 = b.x1 || x0;
      const y1 = b.y1 || y0;
      const h = Math.max(1, y1 - y0);
      // Skip absurd boxes (page-sized "words")
      const area = (x1 - x0) * h;
      if (area > 0.25 * (w._pageArea || 1e12) && (x1 - x0) > 800) continue;
      items.push({
        x: x0,
        y: y0,
        w: Math.max(1, x1 - x0),
        h: h,
        fontHeight: Math.max(8, h),
        raw: text,
        conf: conf,
      });
    }

    items.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
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
        const yClose =
          Math.abs(b.y + b.h / 2 - (line.y + line.h / 2)) <
          Math.max(6, Math.min(line.h, b.h) * 0.55);
        // x gap: only merge adjacent words, not distant labels
        const gap = b.x - (line.x + line.w);
        const xNear = gap >= -4 && gap < Math.max(14, line.fontHeight * 1.1);
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

  async function ocrCanvas(canvas, onProgress) {
    const worker = await getWorker(onProgress);
    const ocrInput = makeOcrCanvas(canvas);
    const result = await worker.recognize(ocrInput);
    const data = result && result.data;
    const words = (data && data.words) || [];

    // Attach page area for garbage box filter
    const pageArea = canvas.width * canvas.height;
    for (let i = 0; i < words.length; i++) words[i]._pageArea = pageArea;

    let lines = [];
    if (data && data.lines && data.lines.length) {
      for (let i = 0; i < data.lines.length; i++) {
        const ln = data.lines[i];
        const text = cleanOcrText(ln.text);
        const conf = typeof ln.confidence === "number" ? ln.confidence : 100;
        const b = ln.bbox || {};
        const w = Math.max(1, (b.x1 || 0) - (b.x0 || 0));
        const h = Math.max(1, (b.y1 || 0) - (b.y0 || 0));
        if (!text || text.length < 2) continue;
        if (conf < 55 || looksLikeGarbage(text) || !isMostlyLetters(text)) continue;
        if (w * h > pageArea * 0.2 && w > canvas.width * 0.5) continue;
        lines.push({
          x: b.x0 || 0,
          y: b.y0 || 0,
          w: w,
          h: h,
          fontHeight: Math.max(10, h),
          text: text,
          parts: [],
          conf: conf,
        });
      }
    }
    if (!lines.length) lines = wordsToLines(words);
    return { lines: lines, words: words, text: (data && data.text) || "" };
  }

  function wrapText(ctx, text, maxWidth) {
    if (!text) return [];
    const chars = Array.from(text);
    const out = [];
    let cur = "";
    for (let i = 0; i < chars.length; i++) {
      const trial = cur + chars[i];
      if (ctx.measureText(trial).width > maxWidth && cur) {
        out.push(cur);
        cur = chars[i] === " " ? "" : chars[i];
      } else {
        cur = trial;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Overlay Chinese. Lines use canvas top-left coords. */
  function overlayLines(sourceCanvas, lines, map, options) {
    options = options || {};
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0);

    if (!options.cover || !lines || !lines.length) return canvas;

    const FONT_STACK =
      (global.PdfEngine && global.PdfEngine.FONT_STACK) ||
      '"Microsoft YaHei","PingFang SC","Noto Sans SC",SimHei,sans-serif';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const dst = map[line.text] != null ? map[line.text] : line.text;
      if (!dst || dst === line.text) continue;

      const region = analyzeRegion(ctx, line.x, line.y, line.w, line.h);
      // Don't paint over colorful product art / photos
      if (region.colorful && region.darkRatio < 0.25) continue;

      const pad = Math.max(1, Math.round(line.fontHeight * 0.08));
      const x = line.x - pad;
      const y = line.y - pad;
      const w = line.w + pad * 2;
      const h = line.h + pad * 2;

      ctx.fillStyle = region.cover;
      ctx.fillRect(x, y, w, h);

      // NEVER grow beyond original text height — only shrink if needed
      let fontSize = Math.max(9, Math.floor(line.fontHeight * 0.88));
      ctx.font = "500 " + fontSize + "px " + FONT_STACK;
      let wrapped = wrapText(ctx, dst, line.w);
      let guard = 0;
      while (
        (wrapped.length * fontSize * 1.2 > line.h * 1.35 || fontSize > line.h) &&
        fontSize > 8 &&
        guard < 16
      ) {
        fontSize = Math.floor(fontSize * 0.9);
        ctx.font = "500 " + fontSize + "px " + FONT_STACK;
        wrapped = wrapText(ctx, dst, line.w);
        guard++;
      }

      ctx.fillStyle = region.textColor || "#111111";
      ctx.textBaseline = "top";
      const lineH = fontSize * 1.15;
      const blockH = wrapped.length * lineH;
      const startY = line.y + Math.max(0, (line.h - blockH) / 2);
      // Prefer left-align with original; for very short labels center in box
      const alignCenter = dst.length <= 6 && line.w < 120;
      for (let li = 0; li < wrapped.length; li++) {
        if (alignCenter) {
          ctx.textAlign = "center";
          ctx.fillText(wrapped[li], line.x + line.w / 2, startY + li * lineH);
          ctx.textAlign = "left";
        } else {
          ctx.fillText(wrapped[li], line.x, startY + li * lineH);
        }
      }
    }

    return canvas;
  }

  /**
   * Optional high-quality path: Gemini vision returns cleaner line list + translations.
   * Requires user API key. Falls back to OCR if not configured / fails.
   */
  async function geminiExtractLines(imageCanvas, targetLang, apiKey) {
    if (!apiKey) throw new Error("未配置 Gemini API Key");
    // Downscale for API payload
    const maxSide = 1280;
    let c = imageCanvas;
    if (Math.max(imageCanvas.width, imageCanvas.height) > maxSide) {
      const s = maxSide / Math.max(imageCanvas.width, imageCanvas.height);
      c = document.createElement("canvas");
      c.width = Math.round(imageCanvas.width * s);
      c.height = Math.round(imageCanvas.height * s);
      c.getContext("2d").drawImage(imageCanvas, 0, 0, c.width, c.height);
    }
    const dataUrl = c.toDataURL("image/jpeg", 0.85);
    const b64 = dataUrl.split(",")[1];
    const langLabel = targetLang === "zh-TW" ? "繁體中文" : "简体中文";
    const prompt =
      "你是产品规格图翻译器。识别图中所有可读的英文文字标签（忽略角色插画、logo装饰中不可读的碎片）。" +
      "对每一条文字，返回 JSON 数组，不要 markdown。每项字段：\n" +
      "{\n" +
      '  "text": "原始英文",\n' +
      '  "translation": "' + langLabel + '译文",\n' +
      '  "x0": 数字, "y0": 数字, "x1": 数字, "y1": 数字\n' +
      "}\n" +
      "坐标是相对图片左上角的归一化 0-1000 整数。" +
      "只输出 JSON 数组本身。忽略无法辨认的碎片。";

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      encodeURIComponent(apiKey);
    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: b64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Gemini HTTP " + res.status);
    const json = await res.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ||
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
      "";
    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("Gemini 返回无法解析");
      arr = JSON.parse(m[0]);
    }
    if (!Array.isArray(arr)) throw new Error("Gemini 返回格式错误");

    const W = imageCanvas.width;
    const H = imageCanvas.height;
    const sx = W / 1000;
    const sy = H / 1000;
    const lines = [];
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      const text2 = cleanOcrText(it.text || it.source || "");
      if (!text2 || text2.length < 2) continue;
      const x0 = Math.max(0, Math.min(W - 1, (it.x0 || 0) * sx));
      const y0 = Math.max(0, Math.min(H - 1, (it.y0 || 0) * sy));
      const x1 = Math.max(x0 + 4, Math.min(W, (it.x1 || it.x0 + 20 || 0) * sx));
      const y1 = Math.max(y0 + 4, Math.min(H, (it.y1 || it.y0 + 12 || 0) * sy));
      lines.push({
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
        fontHeight: Math.max(10, y1 - y0),
        text: text2,
        parts: [],
        conf: 90,
        translation: it.translation || "",
      });
    }
    return lines;
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
    geminiExtractLines: geminiExtractLines,
    applyLocalGlossary: applyLocalGlossary,
    terminateWorker: terminateWorker,
  };
})(window);
