/**
 * Multi-source EN→ZH translator with caching and code preservation.
 */
(function (global) {
  "use strict";

  const CACHE = new Map();
  // ASCII-safe placeholders — rare bracket chars get mangled by MT engines
  const OPEN = "ZXQ";
  const CLOSE = "QXZ";

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

  /** Normalize OpenAI-compatible base URL → chat/completions endpoint */
  function openaiEndpoint(baseUrl) {
    let u = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!u) throw new Error("未填写 API Base URL");
    if (/\/chat\/completions$/i.test(u)) return u;
    if (/\/v1$/i.test(u)) return u + "/chat/completions";
    return u + "/v1/chat/completions";
  }

  function openaiConfig(options) {
    options = options || {};
    const provider = options.llmProvider || "deepseek";
    let baseUrl = options.llmBaseUrl || "";
    let model = options.llmModel || "";
    let label = provider;

    if (provider === "deepseek") {
      if (!baseUrl) baseUrl = "https://api.deepseek.com";
      if (!model) model = "deepseek-chat";
      label = "DeepSeek";
    } else if (provider === "openai") {
      if (!baseUrl) baseUrl = "https://api.openai.com";
      if (!model) model = "gpt-4o-mini";
      label = "OpenAI";
    }
    return {
      endpoint: openaiEndpoint(baseUrl),
      apiKey: (options.llmApiKey || "").trim(),
      model: model,
      label: label,
      provider: provider,
    };
  }

  /**
   * OpenAI-compatible chat translate (DeepSeek / custom).
   * options: { target, llmProvider, llmBaseUrl, llmApiKey, llmModel }
   */
  async function translateOpenAICompat(text, options) {
    const cfg = openaiConfig(options);
    if (!cfg.apiKey) throw new Error(cfg.label + " API Key 未填写");
    const langName =
      (options && options.target) === "zh-TW" ? "繁體中文" : "简体中文";

    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, 60000);
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + cfg.apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "你是专业产品规格/文档译者。把用户给出的英文准确翻译成" +
                langName +
                "。保留数字、单位、色号（如 PMS 361 C）、SKU。只输出译文，不要解释。",
            },
            { role: "user", content: text },
          ],
        }),
      });
      const json = await res.json().catch(function () {
        return null;
      });
      if (!res.ok) {
        const msg =
          (json && json.error && json.error.message) || "HTTP " + res.status;
        const err = new Error(cfg.label + " API 调用失败：" + msg);
        err.status = res.status;
        throw err;
      }
      const out =
        json &&
        json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content;
      if (!out) throw new Error(cfg.label + " 返回空内容");
      return String(out).trim();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Batch translate many strings in one DeepSeek/OpenAI call (JSON array in/out). */
  async function translateOpenAICompatBatch(texts, options, onProgress) {
    const cfg = openaiConfig(options);
    if (!cfg.apiKey) throw new Error(cfg.label + " API Key 未填写");
    const langName =
      (options && options.target) === "zh-TW" ? "繁體中文" : "简体中文";
    const chunkSize = 24;
    const out = new Array(texts.length);

    for (let start = 0; start < texts.length; start += chunkSize) {
      const chunk = texts.slice(start, start + chunkSize);
      const indexed = chunk.map(function (t, i) {
        return { id: start + i, text: t };
      });
      const user =
        "把下列英文条目翻译成" +
        langName +
        "。返回 JSON 数组，每项 {\"id\":数字,\"translation\":\"译文\"}。" +
        "保留数字/单位/PMS色号/SKU。不要输出其它文字。\n" +
        JSON.stringify(indexed);

      const ctrl = new AbortController();
      const timer = setTimeout(function () {
        ctrl.abort();
      }, 90000);
      let json = null;
      let res = null;
      try {
        res = await fetch(cfg.endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + cfg.apiKey,
          },
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.1,
            messages: [
              {
                role: "system",
                content:
                  "你是 JSON 翻译接口。只输出合法 JSON 数组，不要 markdown。",
              },
              { role: "user", content: user },
            ],
          }),
        });
        json = await res.json().catch(function () {
          return null;
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res || !res.ok) {
        const msg =
          (json && json.error && json.error.message) ||
          (res ? "HTTP " + res.status : "网络错误");
        const err = new Error(cfg.label + " API 调用失败：" + msg);
        err.status = res && res.status;
        throw err;
      }
      const content =
        json &&
        json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content;
      let arr = null;
      try {
        arr = JSON.parse(content);
      } catch (e) {
        const m = String(content || "").match(/\[[\s\S]*\]/);
        if (m) {
          try {
            arr = JSON.parse(m[0]);
          } catch (e2) {
            arr = null;
          }
        }
      }
      if (!Array.isArray(arr)) {
        // fallback: per-item
        for (let i = 0; i < chunk.length; i++) {
          out[start + i] = await translateOpenAICompat(chunk[i], options);
          if (onProgress) onProgress(start + i + 1, texts.length);
        }
        continue;
      }
      const byId = {};
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] && typeof arr[i].id === "number") {
          byId[arr[i].id] = arr[i].translation || arr[i].text || "";
        }
      }
      for (let i = 0; i < chunk.length; i++) {
        const id = start + i;
        out[id] = byId[id] != null ? String(byId[id]).trim() : chunk[i];
        if (onProgress) onProgress(id + 1, texts.length);
      }
    }
    return out;
  }

  /** Quick DeepSeek/OpenAI key check. */
  async function testOpenAICompatKey(options) {
    const cfg = openaiConfig(options);
    if (!cfg.apiKey) throw new Error("未填写 " + cfg.label + " API Key");
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, 30000);
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + cfg.apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const json = await res.json().catch(function () {
        return null;
      });
      if (!res.ok) {
        const msg =
          (json && json.error && json.error.message) || "HTTP " + res.status;
        throw new Error(cfg.label + " API 调用失败：" + msg);
      }
      return { ok: true, label: cfg.label, model: cfg.model, endpoint: cfg.endpoint };
    } finally {
      clearTimeout(timer);
    }
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
      deepseek: function () {
        return translateOpenAICompat(payload, options);
      },
      openai: function () {
        return translateOpenAICompat(payload, options);
      },
    };

    const order =
      service === "auto"
        ? ["google", "mymemory"]
        : service === "dict"
          ? []
          : service === "deepseek" || service === "openai"
            ? [service]
            : [service];

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

    // Fast path: DeepSeek / OpenAI-compatible batch API
    const svc = options.service || "auto";
    if ((svc === "deepseek" || svc === "openai") && unique.length) {
      let batchOut;
      try {
        batchOut = await translateOpenAICompatBatch(unique, options, onProgress);
      } catch (err) {
        // Hard fail — do not silently fall back to Google
        throw err;
      }
      const byText = {};
      for (let i = 0; i < unique.length; i++) {
        let dst = batchOut[i] || unique[i];
        if (options.preserveCodes !== false) dst = applyGlossary(dst);
        dst = dst.replace(/\s+([，。；：！？、])/g, "$1").trim();
        byText[unique[i]] = { src: unique[i], dst: dst, service: svc };
      }
      return texts.map(function (t) {
        const raw = String(t || "").trim();
        if (!raw) return { src: raw, dst: "", service: "skip" };
        return byText[raw];
      });
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
    openaiConfig: openaiConfig,
    testOpenAICompatKey: testOpenAICompatKey,
    translateOpenAICompat: translateOpenAICompat,
  };
})(window);
