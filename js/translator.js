/**
 * Multi-source EN→ZH translator with caching and code preservation.
 */
(function (global) {
  "use strict";

  const CACHE = new Map();
  const OPEN = "⟦";
  const CLOSE = "⟧";

  // Longest / compound phrases first so they win over single words.
  const GLOSSARY = [
    [/\bNot to be distributed or reproduced without permission\b/gi, "未经许可不得分发或复制"],
    [/\bProprietary and Confidential\b/gi, "专有及保密文件"],
    [/\bProprietary and Con\s*fidential\b/gi, "专有及保密文件"],
    [/\bAll rights reserved\b/gi, "保留所有权利"],
    [/\bInflatable costume\b/gi, "充气服饰"],
    [/\bMask\/Body Feathers\b/gi, "面具/身体羽毛"],
    [/\bBeak Hightlight\b/gi, "喙高光"],
    [/\bBeak Highlight\b/gi, "喙高光"],
    [/\bBeak Top\b/gi, "喙顶部"],
    [/\bBeak Inner\b/gi, "喙内侧"],
    [/\bLower Beak\b/gi, "下喙"],
    [/\bWhite-Eyes\b/gi, "白色 — 眼睛"],
    [/\bFeathers\b/gi, "羽毛"],
    [/\bPolyester\b/gi, "聚酯纤维"],
    [/\bMaterials?\b/gi, "材质"],
    [/\bColors?\b/gi, "配色"],
    [/\bPupils?\b/gi, "瞳孔"],
    [/\bCostume\b/gi, "服饰本体"],
    [/\bVisor\b/gi, "面罩/镜片"],
    [/\bJeans\b/gi, "牛仔裤"],
    [/\bShoes?\b/gi, "鞋子"],
    [/\bFeet\b/gi, "脚部"],
    [/\bEyes\b/gi, "眼睛"],
    [/\bBody\b/gi, "身体"],
    [/\bFront\b/gi, "正面"],
    [/\bSide\b/gi, "侧面"],
    [/\bBack\b/gi, "背面"],
  ];

  // Preserve product codes and measurements (ASCII + curly quotes).
  const CODE_TOKEN = new RegExp(
    [
      "PMS\\s*[A-Za-z0-9\\s]{0,20}C",
      "PMS\\s*Yellow\\s*C",
      "\\d+['’]\\d+[\"”]",
      "\\d+\\s*cm",
      "\\d+%",
      "\\b\\d{2,}\\b",
    ].join("|"),
    "g"
  );

  // Brand / legal tokens that should not force an API round-trip after glossary.
  const IGNORE_WORDS = {
    buff: 1, duo: 1, yume: 1, toys: 1, tm: 1, inc: 1, ltd: 1, co: 1,
    pdf: 1, utf: 1, all: 1, rights: 1, reserved: 1,
  };

  function meaningfulLatinLeft(text) {
    const stripped = text
      .replace(/PMS\s*[A-Za-z0-9\s-]{0,24}/g, " ")
      .replace(/[A-Z]{2,}/g, " "); // drop ALL-CAPS codes
    const words = (stripped.toLowerCase().match(/[a-z]{3,}/g) || []).filter(function (w) {
      return !IGNORE_WORDS[w];
    });
    return words.length;
  }

  function isMostlyNonLatin(text) {
    const han = (text.match(/[一-鿿]/g) || []).length;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    return han > letters;
  }

  function applyGlossary(text) {
    let out = text;
    for (const [re, zh] of GLOSSARY) out = out.replace(re, zh);
    return out;
  }

  function extractCodes(text) {
    const codes = [];
    let i = 0;
    const masked = text.replace(CODE_TOKEN, (m) => {
      const id = OPEN + i + CLOSE;
      codes.push(m);
      i += 1;
      return id;
    });
    return { masked, codes };
  }

  function restoreCodes(masked, codes) {
    const re = new RegExp(OPEN + "(\\d+)" + CLOSE, "g");
    return masked.replace(re, (_, n) => codes[Number(n)] ?? "");
  }

  async function fetchJson(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateGoogle(text, target) {
    const q = encodeURIComponent(text);
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
      encodeURIComponent(target) +
      "&dt=t&q=" +
      q;
    const data = await fetchJson(url);
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("bad google payload");
    return data[0]
      .map((seg) => (seg && seg[0]) || "")
      .join("")
      .trim();
  }

  async function translateMyMemory(text, target) {
    const pair = "en|" + (target === "zh-TW" ? "zh-TW" : "zh-CN");
    const q = encodeURIComponent(text.slice(0, 480));
    const url =
      "https://api.mymemory.translated.net/get?q=" +
      q +
      "&langpair=" +
      encodeURIComponent(pair);
    const data = await fetchJson(url);
    const translated = data && data.responseData && data.responseData.translatedText;
    if (!translated || /MYMEMORY WARNING|INVALID/i.test(translated)) {
      throw new Error((data && data.responseDetails) || "mymemory failed");
    }
    return String(translated).trim();
  }

  async function translateOne(text, options) {
    options = options || {};
    const raw = String(text || "").trim();
    if (!raw) return { src: raw, dst: "", service: "skip" };
    if (isMostlyNonLatin(raw)) return { src: raw, dst: raw, service: "already-zh" };

    const target = options.target || "zh-CN";
    const key = target + "::" + raw;
    if (CACHE.has(key)) return CACHE.get(key);

    const preserve = options.preserveCodes !== false;
    const service = options.service || "auto";

    const pre = preserve ? applyGlossary(raw) : raw;
    // Full glossary hit (no leftover meaningful English) → done
    if (pre !== raw && meaningfulLatinLeft(pre) === 0) {
      const result = { src: raw, dst: pre, service: "glossary" };
      CACHE.set(key, result);
      return result;
    }

    let payload = raw;
    let codes = [];
    if (preserve) {
      const masked = extractCodes(raw);
      payload = masked.masked;
      codes = masked.codes;
    }

    const runners = {
      google: function () {
        return translateGoogle(payload, target);
      },
      mymemory: function () {
        return translateMyMemory(payload, target);
      },
    };

    const order =
      service === "auto" ? ["google", "mymemory"] : service === "dict" ? [] : [service];

    let lastErr = null;
    for (let n = 0; n < order.length; n++) {
      const name = order[n];
      try {
        let out = await runners[name]();
        if (preserve && codes.length) out = restoreCodes(out, codes);
        if (preserve) out = applyGlossary(out);
        out = out.replace(/\s+([，。；：！？、])/g, "$1").trim();
        if (out) {
          const result = { src: raw, dst: out, service: name };
          CACHE.set(key, result);
          return result;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    const fallback = preserve ? applyGlossary(raw) : raw;
    const result = {
      src: raw,
      dst: fallback,
      service: order.length
        ? "fallback" + (lastErr ? ":" + lastErr.message : "")
        : "dict",
    };
    CACHE.set(key, result);
    return result;
  }

  async function translateMany(texts, options, onProgress) {
    options = options || {};
    const unique = [];
    const index = new Map();
    for (let i = 0; i < texts.length; i++) {
      const raw = String(texts[i] || "").trim();
      if (!raw) continue;
      if (!index.has(raw)) {
        index.set(raw, unique.length);
        unique.push(raw);
      }
    }

    const results = new Array(unique.length);
    let done = 0;
    const concurrency = Math.min(4, Math.max(1, unique.length));
    const cursor = { i: 0 };

    async function worker() {
      while (cursor.i < unique.length) {
        const idx = cursor.i++;
        results[idx] = await translateOne(unique[idx], options);
        done += 1;
        if (onProgress) onProgress(done, unique.length);
      }
    }

    const jobs = [];
    for (let k = 0; k < concurrency; k++) jobs.push(worker());
    await Promise.all(jobs);

    return texts.map(function (t) {
      const raw = String(t || "").trim();
      if (!raw) return { src: raw, dst: "", service: "skip" };
      return results[index.get(raw)];
    });
  }

  global.PdfTranslator = {
    translateOne: translateOne,
    translateMany: translateMany,
    applyGlossary: applyGlossary,
  };
})(window);
