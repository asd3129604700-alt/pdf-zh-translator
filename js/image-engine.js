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
    maxSide = maxSide || 2800;
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        let scale = Math.min(1, maxSide / Math.max(w, h));
        // Aggressively upscale small/low-res sources so tiny labels become readable
        const long = Math.max(w, h);
        if (long < 1000) scale = Math.min(3, 2200 / long);
        else if (long < 1600) scale = Math.min(2, 2400 / long);
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ canvas: canvas, width: w, height: h, file: file, scale: scale });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取图片：" + (file.name || "")));
      };
      img.src = url;
    });
  }

  function upscaleCanvas(source, factor) {
    const c = document.createElement("canvas");
    c.width = Math.round(source.width * factor);
    c.height = Math.round(source.height * factor);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
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
    // Luminance histogram
    const lum = new Float32Array(d.length / 4);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    const sorted = Array.from(lum).sort(function (a, b) {
      return a - b;
    });
    // Use aggressive low percentile so sparse dark text is captured
    let lo = sorted[Math.floor(sorted.length * 0.005)] || 0;
    let hi = sorted[Math.floor(sorted.length * 0.995)] || 255;
    // White-page documents: 0.5% dark text still leaves lo near 255 — fall back
    if (hi - lo < 24) {
      lo = 0;
      hi = 255;
    }
    // If background is near-white, stretch from 0 so ink stays dark
    if (lo > 180) lo = 0;
    if (hi < 80) hi = 255;
    const range = Math.max(1, hi - lo);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = ((lum[p] - lo) / range) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
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

  function extractLinesFromResult(data, pageW, pageH, confMin) {
    const pageArea = pageW * pageH;
    const words = (data && data.words) || [];
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
        // Small labels often score low confidence; accept longer real English more easily
        let minConf = confMin;
        if (text.length >= 12) minConf = Math.min(confMin, 35);
        else if (text.length >= 8) minConf = Math.min(confMin, 42);
        if (conf < minConf || looksLikeGarbage(text) || !isMostlyLetters(text)) continue;
        if (w * h > pageArea * 0.2 && w > pageW * 0.5) continue;
        lines.push({
          x: b.x0 || 0,
          y: b.y0 || 0,
          w: w,
          h: h,
          fontHeight: Math.max(8, h),
          text: text,
          parts: [],
          conf: conf,
        });
      }
    }
    if (!lines.length) lines = wordsToLines(words);
    return lines;
  }

  function scaleLines(lines, inv) {
    return lines.map(function (l) {
      return {
        x: l.x * inv,
        y: l.y * inv,
        w: l.w * inv,
        h: l.h * inv,
        fontHeight: l.fontHeight * inv,
        text: l.text,
        parts: l.parts || [],
        conf: l.conf,
      };
    });
  }

  function mergeLineLists(a, b) {
    const out = a.slice();
    for (let i = 0; i < b.length; i++) {
      const cand = b[i];
      let dup = false;
      for (let j = 0; j < out.length; j++) {
        const e = out[j];
        const textNear =
          e.text === cand.text ||
          e.text.indexOf(cand.text) >= 0 ||
          cand.text.indexOf(e.text) >= 0;
        const cx1 = e.x + e.w / 2;
        const cy1 = e.y + e.h / 2;
        const cx2 = cand.x + cand.w / 2;
        const cy2 = cand.y + cand.h / 2;
        const boxNear =
          Math.abs(cx1 - cx2) < Math.max(e.w, cand.w) * 0.55 &&
          Math.abs(cy1 - cy2) < Math.max(e.h, cand.h) * 0.8;
        if (textNear && boxNear) {
          // keep the longer / higher-confidence line
          if (cand.text.length > e.text.length || cand.conf > e.conf + 5) {
            out[j] = cand;
          }
          dup = true;
          break;
        }
      }
      if (!dup) out.push(cand);
    }
    return out;
  }

  /**
   * OCR one image canvas.
   * Dual-pass: normal + upscaled (helps small labels).
   */
  async function ocrCanvas(canvas, onProgress) {
    const worker = await getWorker(onProgress);
    if (onProgress) onProgress({ status: "recognizing_base", progress: 0.15 });
    const ocrInput = makeOcrCanvas(canvas);
    const result = await worker.recognize(ocrInput);
    const data = result && result.data;
    let lines = extractLinesFromResult(data, canvas.width, canvas.height, 45);
    const words = (data && data.words) || [];

    // Small-text rescue: upscale and OCR again, then map boxes back
    const avgH =
      lines.length > 0
        ? lines.reduce(function (s, l) {
            return s + l.fontHeight;
          }, 0) / lines.length
        : 0;
    const needZoom = lines.length < 8 || avgH < 16 || avgH === 0;
    if (needZoom) {
      if (onProgress) onProgress({ status: "recognizing_zoom", progress: 0.45 });
      const UP = 1.8;
      const up = upscaleCanvas(canvas, UP);
      const upOcr = makeOcrCanvas(up);
      const result2 = await worker.recognize(upOcr);
      const lines2 = scaleLines(
        extractLinesFromResult(result2 && result2.data, up.width, up.height, 38),
        1 / UP
      );
      lines = mergeLineLists(lines, lines2);
    }

    return { lines: lines, words: words, text: (data && data.text) || "" };
  }

  /**
   * Complex mode: split into 2 or 4 tiles, upscale each, OCR, map boxes back.
   * Vector-style artwork stays sharp when upscaled; small labels get more pixels.
   */
  async function ocrCanvasComplex(canvas, onProgress, opts) {
    opts = opts || {};
    const worker = await getWorker(onProgress);
    const W = canvas.width;
    const H = canvas.height;

    // --- Pass 0: coarse detect where text lives (downscaled) ---
    if (onProgress) onProgress({ status: "detect_text_regions", progress: 0.04 });
    let probeLines = [];
    try {
      const probeScale = Math.min(1, 900 / Math.max(W, H));
      const pw = Math.max(80, Math.round(W * probeScale));
      const ph = Math.max(80, Math.round(H * probeScale));
      const probe = document.createElement("canvas");
      probe.width = pw;
      probe.height = ph;
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = "high";
      pctx.drawImage(canvas, 0, 0, pw, ph);
      const probeOcr = makeOcrCanvas(probe);
      const probeRes = await worker.recognize(probeOcr);
      const inv = 1 / probeScale;
      probeLines = extractLinesFromResult(probeRes && probeRes.data, pw, ph, 35).map(
        function (l) {
          return {
            x: l.x * inv,
            y: l.y * inv,
            w: l.w * inv,
            h: l.h * inv,
            text: l.text,
          };
        }
      );
    } catch (e) {
      probeLines = [];
    }

    // If probe already found a lot of clear text, use those boxes directly
    // (still re-OCR tiles that contain them for better small-text quality)
    const hasProbe = probeLines.length >= 3;

    // Analyze distribution → choose 2 vs 4 tiles
    let cols = 2;
    let rows = 1;
    if (hasProbe) {
      let left = 0;
      let right = 0;
      let top = 0;
      let bottom = 0;
      const midX = W / 2;
      const midY = H / 2;
      for (let i = 0; i < probeLines.length; i++) {
        const cx = probeLines[i].x + probeLines[i].w / 2;
        const cy = probeLines[i].y + probeLines[i].h / 2;
        if (cx < midX) left++;
        else right++;
        if (cy < midY) top++;
        else bottom++;
      }
      const n = probeLines.length;
      const spreadX = Math.min(left, right) / n; // 0.5 = balanced L/R
      const spreadY = Math.min(top, bottom) / n;

      if (spreadX < 0.18 && spreadY < 0.18) {
        // Text clustered in one quadrant → 2 tiles on dominant axis
        if (left + right > 0 && Math.abs(left - right) > Math.abs(top - bottom)) {
          cols = 2;
          rows = 1;
        } else {
          cols = 1;
          rows = 2;
        }
      } else if (spreadX >= 0.18 && spreadY >= 0.18) {
        // Text in multiple quadrants → 2x2
        cols = 2;
        rows = 2;
      } else if (spreadX >= 0.18) {
        cols = 2;
        rows = 1;
      } else {
        cols = 1;
        rows = 2;
      }
      // Dense / many lines → prefer 4 tiles for resolution
      if (n >= 12 || Math.max(W, H) >= 1600) {
        cols = 2;
        rows = 2;
      }
    } else {
      // No probe text: fall back to aspect ratio (original behavior)
      if (W > H * 1.15) {
        cols = 2;
        rows = 1;
      } else if (H > W * 1.15) {
        cols = 1;
        rows = 2;
      } else {
        cols = 2;
        rows = 2;
      }
      if (Math.max(W, H) >= 1600) {
        cols = 2;
        rows = 2;
      }
    }

    if (onProgress) {
      onProgress({
        status: "tile_grid_" + cols + "x" + rows,
        progress: 0.08,
      });
    }

    // Overlap so text at tile borders is not cut
    const overlap = Math.round(Math.min(W / cols, H / rows) * 0.08);
    const tileW = Math.ceil(W / cols);
    const tileH = Math.ceil(H / rows);
    let up = opts.zoom || 2;
    const tileLong = Math.max(tileW, tileH) * up;
    if (tileLong > 2800) up = Math.max(1.2, 2800 / Math.max(tileW, tileH));
    const minUp = 1600 / Math.max(tileW, tileH);
    if (up < minUp && minUp <= 3) up = Math.min(3, minUp);

    // Build tile list; skip tiles with no probe text (save time)
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(0, Math.floor(c * tileW) - (c > 0 ? overlap : 0));
        const y0 = Math.max(0, Math.floor(r * tileH) - (r > 0 ? overlap : 0));
        const x1 = Math.min(
          W,
          Math.floor((c + 1) * tileW) + (c < cols - 1 ? overlap : 0)
        );
        const y1 = Math.min(
          H,
          Math.floor((r + 1) * tileH) + (r < rows - 1 ? overlap : 0)
        );
        const tw = x1 - x0;
        const th = y1 - y0;
        if (tw < 8 || th < 8) continue;

        let hasText = true;
        if (hasProbe) {
          hasText = probeLines.some(function (L) {
            const cx = L.x + L.w / 2;
            const cy = L.y + L.h / 2;
            return cx >= x0 - 4 && cx <= x1 + 4 && cy >= y0 - 4 && cy <= y1 + 4;
          });
        }
        if (hasText) tiles.push({ x0: x0, y0: y0, tw: tw, th: th, c: c, r: r });
      }
    }
    // Safety: if all skipped, process all tiles
    if (!tiles.length) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x0 = Math.max(0, Math.floor(c * tileW) - (c > 0 ? overlap : 0));
          const y0 = Math.max(0, Math.floor(r * tileH) - (r > 0 ? overlap : 0));
          const x1 = Math.min(
            W,
            Math.floor((c + 1) * tileW) + (c < cols - 1 ? overlap : 0)
          );
          const y1 = Math.min(
            H,
            Math.floor((r + 1) * tileH) + (r < rows - 1 ? overlap : 0)
          );
          const tw = x1 - x0;
          const th = y1 - y0;
          if (tw >= 8 && th >= 8) tiles.push({ x0: x0, y0: y0, tw: tw, th: th, c: c, r: r });
        }
      }
    }

    const total = tiles.length;
    let doneTiles = 0;
    let allLines = hasProbe ? probeLines.slice() : [];

    for (let t = 0; t < tiles.length; t++) {
      const tileInfo = tiles[t];
      const x0 = tileInfo.x0;
      const y0 = tileInfo.y0;
      const tw = tileInfo.tw;
      const th = tileInfo.th;

      if (onProgress) {
        onProgress({
          status: "tile_" + (doneTiles + 1) + "_of_" + total,
          progress: 0.1 + (doneTiles / Math.max(1, total)) * 0.8,
        });
      }

      const tile = document.createElement("canvas");
      tile.width = tw;
      tile.height = th;
      const tctx = tile.getContext("2d", { willReadFrequently: true });
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = "high";
      tctx.drawImage(canvas, x0, y0, tw, th, 0, 0, tw, th);

      const upTile = upscaleCanvas(tile, up);
      const ocrIn = makeOcrCanvas(upTile);
      const result = await worker.recognize(ocrIn);
      const tileLines = extractLinesFromResult(
        result && result.data,
        upTile.width,
        upTile.height,
        40
      );

      for (let i = 0; i < tileLines.length; i++) {
        const L = tileLines[i];
        allLines.push({
          x: x0 + L.x / up,
          y: y0 + L.y / up,
          w: L.w / up,
          h: L.h / up,
          fontHeight: L.fontHeight / up,
          text: L.text,
          parts: [],
          conf: L.conf,
        });
      }
      doneTiles++;
    }

    allLines = mergeLineLists([], allLines);
    return {
      lines: allLines,
      words: [],
      text: allLines
        .map(function (l) {
          return l.text;
        })
        .join("\n"),
      grid: cols + "x" + rows,
      tilesProcessed: doneTiles,
    };
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
  async function geminiFetch(apiKey, body) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      encodeURIComponent(apiKey);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(function () {
      return null;
    });
    if (!res.ok) {
      const msg =
        (json && json.error && json.error.message) ||
        "HTTP " + res.status;
      const err = new Error("Gemini API 调用失败：" + msg);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    if (!json) throw new Error("Gemini 返回空响应");
    return json;
  }

  /** Quick key check: tiny generateContent call. Throws with a clear message. */
  async function testGeminiKey(apiKey) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error("未填写 Gemini API Key");
    }
    const key = apiKey.trim();
    if (key.length < 10) {
      throw new Error("Gemini API Key 格式不正确（太短）");
    }
    const json = await geminiFetch(key, {
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 8 },
    });
    const text =
      (json.candidates &&
        json.candidates[0] &&
        json.candidates[0].content &&
        json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] &&
        json.candidates[0].content.parts[0].text) ||
      "";
    if (!json.candidates) {
      throw new Error("Gemini Key 校验失败：响应异常");
    }
    return { ok: true, echo: String(text).slice(0, 40) };
  }

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
    const json = await geminiFetch(apiKey, body);
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ||
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
      "";
    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("Gemini 返回无法解析（请检查 Key 是否有效）");
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

  /**
   * Complex + API: split into 2/4 tiles, call Gemini per tile, map boxes back.
   * Better than whole-image Gemini on dense specs; more API calls (2–4).
   */
  async function geminiExtractLinesTiled(imageCanvas, targetLang, apiKey, onProgress) {
    if (!apiKey) throw new Error("未配置 Gemini API Key");
    const W = imageCanvas.width;
    const H = imageCanvas.height;
    const long = Math.max(W, H);

    let cols = 2;
    let rows = 1;
    if (W > H * 1.15) {
      cols = 2;
      rows = 1;
    } else if (H > W * 1.15) {
      cols = 1;
      rows = 2;
    } else {
      cols = 2;
      rows = 2;
    }
    if (long >= 1400) {
      cols = 2;
      rows = 2;
    }

    const overlap = Math.round(Math.min(W / cols, H / rows) * 0.06);
    const tileW = Math.ceil(W / cols);
    const tileH = Math.ceil(H / rows);
    const total = cols * rows;
    let done = 0;
    let all = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(0, Math.floor(c * tileW) - (c > 0 ? overlap : 0));
        const y0 = Math.max(0, Math.floor(r * tileH) - (r > 0 ? overlap : 0));
        const x1 = Math.min(W, Math.floor((c + 1) * tileW) + (c < cols - 1 ? overlap : 0));
        const y1 = Math.min(H, Math.floor((r + 1) * tileH) + (r < rows - 1 ? overlap : 0));
        const tw = x1 - x0;
        const th = y1 - y0;
        if (tw < 16 || th < 16) continue;

        if (onProgress) {
          onProgress({
            status: "gemini_tile_" + (done + 1) + "_of_" + total,
            progress: 0.05 + (done / total) * 0.9,
          });
        }

        let tile = document.createElement("canvas");
        tile.width = tw;
        tile.height = th;
        tile.getContext("2d").drawImage(imageCanvas, x0, y0, tw, th, 0, 0, tw, th);
        // Mild upscale helps tiny labels in the API payload
        if (Math.max(tw, th) < 900) {
          tile = upscaleCanvas(tile, 1.6);
        }

        let tileLines = [];
        try {
          tileLines = await geminiExtractLines(tile, targetLang, apiKey);
        } catch (err) {
          console.warn("Gemini tile failed", done + 1, err);
          tileLines = [];
        }

        // tile coords → full image (tile may be upscaled)
        const inv = tw / tile.width;
        for (let i = 0; i < tileLines.length; i++) {
          const L = tileLines[i];
          all.push({
            x: x0 + L.x * inv,
            y: y0 + L.y * inv,
            w: L.w * inv,
            h: L.h * inv,
            fontHeight: L.fontHeight * inv,
            text: L.text,
            parts: [],
            conf: 92,
            translation: L.translation || "",
          });
        }
        done++;
      }
    }

    all = mergeLineLists([], all);
    return all;
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
    ocrCanvasComplex: ocrCanvasComplex,
    overlayLines: overlayLines,
    geminiExtractLines: geminiExtractLines,
    geminiExtractLinesTiled: geminiExtractLinesTiled,
    testGeminiKey: testGeminiKey,
    applyLocalGlossary: applyLocalGlossary,
    terminateWorker: terminateWorker,
  };
})(window);
