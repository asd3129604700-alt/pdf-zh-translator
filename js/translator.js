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
    // Shinobu-style: baseUrl already includes /v1, append /chat/completions
    if (/\/chat\/completions$/i.test(u)) return u;
    if (/\/v1$/i.test(u)) return u + "/chat/completions";
    // DeepSeek official is https://api.deepseek.com/v1/chat/completions
    // also accepts https://api.deepseek.com/chat/completions
    if (/deepseek\.com$/i.test(u)) return u + "/chat/completions";
    return u + "/v1/chat/completions";
  }

  /** GET {base}/models — OpenAI-compatible model list (DeepSeek included). */
  function modelsEndpoint(baseUrl) {
    let u = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!u) throw new Error("未填写 API Base URL");
    if (/\/models$/i.test(u)) return u;
    if (/\/v1$/i.test(u)) return u + "/models";
    if (/deepseek\.com$/i.test(u)) return u + "/models";
    return u + "/v1/models";
  }

  /**
   * Fetch model IDs from an OpenAI-compatible endpoint.
   * Returns string[] (sorted). Throws with a clear Chinese message.
   */
  async function fetchOpenAIModels(options) {
    const cfg = openaiConfig(options);
    if (!cfg.apiKey) throw new Error(cfg.label + " API Key 未填写");
    const url = modelsEndpoint(cfg.baseUrl || options.llmBaseUrl || "");
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, 25000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + cfg.apiKey,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (e) {
        parsed = null;
      }
      if (!res.ok) {
        const detail = apiErrorDetail(parsed, text) || "HTTP " + res.status;
        throw new Error(cfg.label + " 拉取模型失败：" + detail);
      }
      const data = parsed && parsed.data;
      if (!Array.isArray(data)) {
        throw new Error(cfg.label + " 模型列表格式无法识别");
      }
      const ids = data
        .map(function (m) {
          return (m && (m.id || m.name)) || "";
        })
        .filter(Boolean);
      if (!ids.length) throw new Error(cfg.label + " 未返回任何模型");
      ids.sort();
      return ids;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Built-in Gemini model list + optional live fetch. */
  const GEMINI_MODELS = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ];

  async function fetchGeminiModels(apiKey) {
    if (!apiKey) throw new Error("Gemini API Key 未填写");
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models?key=" +
      encodeURIComponent(apiKey.trim()) +
      "&pageSize=50";
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, 25000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (e) {
        parsed = null;
      }
      if (!res.ok) {
        const detail = apiErrorDetail(parsed, text) || "HTTP " + res.status;
        throw new Error("Gemini 拉取模型失败：" + detail);
      }
      const models = parsed && parsed.models;
      if (!Array.isArray(models) || !models.length) {
        return GEMINI_MODELS.slice();
      }
      const ids = models
        .map(function (m) {
          // name: "models/gemini-2.0-flash"
          const n = (m && m.name) || "";
          return n.replace(/^models\//, "");
        })
        .filter(function (id) {
          return /generateContent|gemini/i.test(id);
        });
      return ids.length ? ids : GEMINI_MODELS.slice();
    } catch (err) {
      // Fall back to known list if list endpoint is restricted
      if (/拉取模型失败|Key/.test(err.message || "")) throw err;
      return GEMINI_MODELS.slice();
    } finally {
      clearTimeout(timer);
    }
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
      baseUrl: baseUrl,
      apiKey: (options.llmApiKey || "").trim(),
      model: model,
      label: label,
      provider: provider,
    };
  }

  /**
   * Robust chat-completions POST (ported from ShinobuTranslator browser-runtime):
   * - Bearer auth, cache no-store
   * - retry 429 / 5xx (max 2), honor Retry-After, expo backoff
   * - surface API error.message clearly
   */
  const MAX_RETRIES = 2;
  const MAX_RETRY_DELAY_MS = 10000;

  function sleepMs(ms, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(signal.reason || new DOMException("已取消", "AbortError"));
    }
    return new Promise(function (resolve, reject) {
      const onAbort = function () {
        clearTimeout(timer);
        reject(signal && signal.reason ? signal.reason : new DOMException("已取消", "AbortError"));
      };
      const timer = setTimeout(function () {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function retryableStatus(status) {
    return status === 429 || status >= 500;
  }

  function retryDelayMs(response, retryIndex) {
    const retryAfter = response && response.headers && response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(MAX_RETRY_DELAY_MS, seconds * 1000);
      }
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) {
        return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, at - Date.now()));
      }
    }
    return Math.min(MAX_RETRY_DELAY_MS, 500 * Math.pow(2, retryIndex));
  }

  function apiErrorDetail(parsed, responseText) {
    if (parsed && parsed.error && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (parsed && typeof parsed.message === "string") return parsed.message;
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
    if (responseText) return String(responseText).slice(0, 240);
    return null;
  }

  async function postChatCompletion(endpoint, apiKey, body, signal) {
    let response = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + apiKey,
          },
          body: JSON.stringify(body),
          cache: "no-store",
          signal: signal,
        });
      } catch (error) {
        if (signal && signal.aborted) throw error;
        const err = new Error("网络请求失败（无法连接 API）");
        err.retryable = error instanceof TypeError;
        throw err;
      }
      if (!retryableStatus(response.status) || attempt === MAX_RETRIES) break;
      const delay = retryDelayMs(response, attempt);
      try {
        if (response.body) await response.body.cancel();
      } catch (e) { /* ignore */ }
      await sleepMs(delay, signal);
    }
    if (!response) throw new Error("API 请求未能启动");

    let responseText = "";
    try {
      responseText = await response.text();
    } catch (error) {
      if (signal && signal.aborted) throw error;
      throw new Error("API 响应读取失败");
    }
    let parsed = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch (e) {
      parsed = null;
    }
    if (!response.ok) {
      const detail = apiErrorDetail(parsed, responseText) || "HTTP " + response.status;
      const err = new Error("API 调用失败：" + detail);
      err.status = response.status;
      err.responseText = responseText;
      err.detail = detail;
      throw err;
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("API 响应解析失败");
    }
    return parsed;
  }

  /**
   * OpenAI-compatible chat translate (DeepSeek / custom).
   */
  async function translateOpenAICompat(text, options) {
    const cfg = openaiConfig(options);
    if (!cfg.apiKey) throw new Error(cfg.label + " API Key 未填写");
    const langName =
      (options && options.target) === "zh-TW" ? "繁體中文" : "简体中文";

    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, 90000);
    try {
      const json = await postChatCompletion(
        cfg.endpoint,
        cfg.apiKey,
        {
          model: cfg.model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "你是玩具/产品规格图译者。把英文准确翻译成" +
                langName +
                "。先纠正明显 OCR 错误再翻译。保留 PMS/色号/SKU/数字。" +
                "角色名 TAKANASHI KIARA / hololive / Jakks 原样保留。" +
                "SEPARATE PIECE=独立部件，EMBROIDERY=刺绣，APPLIQUE=贴布绣，PRINTED GRAPHIC=印花图案，GRADIENT=渐变。" +
                "只输出译文，不要解释。",
            },
            { role: "user", content: text },
          ],
        },
        ctrl.signal
      );
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
        "你是玩具/产品规格图译者。把下列从 OCR 得到的英文条目翻译成" +
        langName +
        "。\n" +
        "要求：\n" +
        "1. 先纠正明显 OCR 错误（如 sxeculion→execution, SEPARRTE→SEPARATE）再翻译\n" +
        "2. 保留 PMS/色号/SKU/数字/单位原样\n" +
        "3. 角色名 TAKANASHI KIARA、hololive、Jakks 原样保留，不要音译\n" +
        "4. 工艺词固定译法：SEPARATE PIECE=独立部件，EMBROIDERY=刺绣，APPLIQUE=贴布绣，PRINTED GRAPHIC=印花图案，GRADIENT=渐变，MINI PLUSH=迷你毛绒\n" +
        "5. 返回 JSON 数组，每项 {\"id\":数字,\"translation\":\"译文\"}。不要输出其它文字。\n" +
        JSON.stringify(indexed);

      const ctrl = new AbortController();
      const timer = setTimeout(function () {
        ctrl.abort();
      }, 120000);
      let json = null;
      try {
        json = await postChatCompletion(
          cfg.endpoint,
          cfg.apiKey,
          {
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
          },
          ctrl.signal
        );
      } finally {
        clearTimeout(timer);
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
      await postChatCompletion(
        cfg.endpoint,
        cfg.apiKey,
        {
          model: cfg.model,
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        },
        ctrl.signal
      );
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

    // Glossary only for short labels; long sentences go to MT as-is
    // (pre-glossary on long text creates mixed EN/ZH and worse output)
    const isShort = raw.length <= 48;
    const pre = preserve && isShort ? applyGlossary(raw) : raw;
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
        // Only glossary-fallback when LLM output still looks untranslated
        const stillEn = (String(dst).match(/[A-Za-z]{3,}/g) || []).length >= 3;
        if (options.preserveCodes !== false && stillEn) {
          dst = applyGlossary(dst);
        }
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
    fetchOpenAIModels: fetchOpenAIModels,
    fetchGeminiModels: fetchGeminiModels,
    GEMINI_MODELS: GEMINI_MODELS,
  };
})(window);
