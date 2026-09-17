/**
 * PZTranslate — 翻译层（免费公共接口 / 大模型 / 术语表）
 *
 * 设计要点，都是「为什么」而不是「是什么」：
 *
 * 1. 本文件里**不允许出现任何具体产品 / 角色 / 客户词汇**。所有领域词汇一律走
 *    `opts.glossaryEntries`（由 PZConfig.parseGlossary 从界面文本解析而来）。
 *    原实现把二十多条客户专有词表和「你是某个行业的规格图译者」的提示词
 *    写死在代码里，用户换一份普通客户资料就会被带偏。
 *
 * 2. 提示词一律由 PZConfig.buildTranslateSystem / buildTranslateBatchUser 生成，
 *    这里不拼任何提示词文本——换领域只改 config.js，不用碰算法。
 *
 * 3. 失败必须**大声抛错**：绝不静默降级到免费接口（用户以为在用大模型，其实在用
 *    Google），也绝不静默把原文当译文返回（用户会以为已经翻好了）。
 *    但已经翻出来的部分不能丢：抛出的错误上挂 `err.partial`，界面仍可展示，
 *    每条结果都带 `engine` 字段标明真实来源（google / mymemory / llm / glossary / skip）。
 *
 * 4. 型号与代码用占位符保护后再送机翻，还原之后**还要做残留检测**：
 *    占位符一旦被引擎吃掉或改写，译文里就会留下乱码或丢掉色号，必须让用户看见。
 */
(function (global) {
  "use strict";

  const U = global.PZUtil;
  const CONFIG = global.PZConfig;
  if (!U || !CONFIG) {
    throw new Error("PZTranslate 依赖 js/util.js（PZUtil）与 js/config.js（PZConfig），请先加载它们");
  }

  /* ============================================================
   * 常量
   * ============================================================ */

  const VERSION = "3.0.0";

  // 型号 / 代码占位符的定界符。用 Unicode 私用区（PUA, U+E000 / U+E001）：
  //   - 机翻引擎看不到「词」也看不到「音节」，没有东西可以翻译或拆开，
  //     而原来的 "ZXQ0QXZ" 是一串拉丁字母，会被当成单词切开甚至音译；
  //   - 真实英文资料里不可能自然出现这两个码位，不会误伤正文；
  //   - 与数字连写后仍是一个 token，不会因为插空格而错位。
  const PH_OPEN = "\uE000";
  const PH_CLOSE = "\uE001";
  // 还原时容忍引擎插入的空格、以及全角数字（有些引擎会把阿拉伯数字转全角）
  const PH_RESTORE = /\uE000\s*([0-9\uFF10-\uFF19]+)\s*\uE001/g;
  // 残留检测：还原完之后译文里还留着定界符 → 占位符没被完整还原
  const PH_RESIDUE = /[\uE000\uE001]/;

  // 大模型每批条目数：太小浪费往返，太大容易超出 max_tokens 被截断
  const LLM_BATCH_SIZE = 24;
  // MyMemory 单次请求的硬上限（官方限制），超过必须拆段，绝不能悄悄截断
  const MYMEMORY_MAX_CHARS = 480;
  // Google 免费接口是 GET，URL 太长会被拒；超了直接报错让用户改走大模型
  const GOOGLE_MAX_URL = 7000;

  const MAX_RETRIES = 2;
  const MAX_RETRY_DELAY_MS = 10000;

  /* ============================================================
   * 底层 HTTP（可注入，便于单测）
   * ============================================================ */

  let fetchImpl = function (url, init) {
    if (typeof global.fetch !== "function") {
      throw new Error("当前环境没有 fetch，无法调用翻译接口");
    }
    return global.fetch(url, init);
  };

  /** 注入假的 fetch（只在单测/沙箱里用），传 null 恢复默认 */
  function setFetch(fn) {
    if (typeof fn === "function") fetchImpl = fn;
    else fetchImpl = function (url, init) { return global.fetch(url, init); };
  }

  function noop() {}

  /**
   * 把「外部取消信号」和「请求超时」合成一个 signal。
   * 必须区分两者：超时应该让调用方降级到下一个源；外部取消必须立刻整体中止。
   */
  function timeoutSignal(ms, signal) {
    if (typeof AbortController !== "function") return { signal: signal || null, done: noop };
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort(U.abortError("请求超时（" + ms + "ms）"));
    }, ms);
    let onAbort = null;
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason || U.abortError());
      else {
        onAbort = function () { ctrl.abort(signal.reason || U.abortError()); };
        signal.addEventListener("abort", onAbort);
      }
    }
    return {
      signal: ctrl.signal,
      done: function () {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  /**
   * 统一请求出口，返回 { ok, status, headers, text, json }。
   * 错误消息都翻成中文——用户看到的提示必须能直接判断下一步做什么。
   */
  async function httpRequest(url, o) {
    o = o || {};
    const timeoutMs = o.timeoutMs || 20000;
    const t = timeoutSignal(timeoutMs, o.signal);
    let res = null;
    try {
      res = await fetchImpl(url, {
        method: o.method || "GET",
        headers: o.headers,
        body: o.body,
        cache: "no-store",
        signal: t.signal,
      });
    } catch (err) {
      // 外部取消 → 原样抛出，让上层 isAbortError 识别
      if (o.signal && o.signal.aborted) throw (o.signal.reason || U.abortError());
      // 超时也是 AbortError，但不能当成「用户取消」，否则一个源超时就整体中止
      if (U.isAbortError(err)) throw new Error("请求超时（" + timeoutMs + "ms）");
      throw new Error("网络请求失败：" + ((err && err.message) || String(err)));
    } finally {
      t.done();
    }
    let text = "";
    try {
      text = await res.text();
    } catch (e) {
      text = "";
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }
    return {
      ok: !!res.ok,
      status: res.status,
      headers: res.headers || null,
      text: text,
      json: json,
    };
  }

  /* ============================================================
   * 术语表
   * ============================================================ */

  // 正则元字符转义。不转义的话 "DEV. STAGE" 里的点会变成通配符，
  // "DEVXSTAGE" 也会被替换；"(A+B)" 更是直接抛 "unterminated group"。
  const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
  function escapeRe(s) {
    return String(s).replace(RE_SPECIAL, "\\$&");
  }

  // 与 \b 等价的「词字符」判断。不用 \b 是因为像 "Silk/Sateen"、"DEV. STAGE"、
  // "(A+B)" 这种词的首尾不是词字符，\b 在它们身上会失效（既不匹配也不会报错，
  // 就是静默不替换，最难查）。
  const WORD_CHAR = /[A-Za-z0-9_]/;

  /**
   * 把 [{from,to,keep}] 编译成可用的匹配器。
   * keep 项**不参与替换**（它们的作用是进提示词告诉模型别翻）。
   */
  function prepareGlossary(entries) {
    const list = [];
    if (!entries || !entries.length) return list;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      const from = String(e.from == null ? "" : e.from).trim();
      if (!from) continue;
      if (e.keep) continue;
      list.push({
        from: from,
        to: e.to == null ? "" : String(e.to),
        // sticky(y) 正则只在 lastIndex 处匹配，正好用来做「从某个位置起的最长匹配」
        re: new RegExp(escapeRe(from), "iy"),
        headWord: WORD_CHAR.test(from.charAt(0)),
        tailWord: WORD_CHAR.test(from.charAt(from.length - 1)),
      });
    }
    // 长词优先：否则 "Shoes" 会先命中，导致 "Shoes Laces" 只翻了一半
    list.sort(function (a, b) {
      return b.from.length - a.from.length;
    });
    return list;
  }

  /** 在 text 的 idx 处找最长且词边界合法的术语；找不到返回 null */
  function matchAt(text, idx, list, prevCh) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      // 词首是词字符时，要求左边不是词字符 —— 这样 "Backpack" 不会命中 "Back"
      if (e.headWord && prevCh && WORD_CHAR.test(prevCh)) continue;
      e.re.lastIndex = idx;
      if (!e.re.test(text)) continue;
      const end = idx + e.from.length;
      if (e.tailWord) {
        const next = text.charAt(end);
        if (next && WORD_CHAR.test(next)) continue;
      }
      return e;
    }
    return null;
  }

  /**
   * 术语表替换。大小写不敏感、长词优先、词边界感知、正则特殊字符安全。
   * 逐字符扫描而不是反复 String.replace：这样「长词先试、失败再退到短词」是确定的，
   * 而且替换进去的译文不会被再次匹配（否则 "Shoes"=>"鞋子" 之后再匹配到别的词就乱了）。
   */
  function applyGlossary(text, entries) {
    const src = text == null ? "" : String(text);
    if (!src) return "";
    const list = prepareGlossary(entries);
    if (!list.length) return src;
    let out = "";
    let i = 0;
    while (i < src.length) {
      const prevCh = i > 0 ? src.charAt(i - 1) : "";
      const hit = matchAt(src, i, list, prevCh);
      if (hit) {
        out += hit.to;
        i += hit.from.length;
      } else {
        out += src.charAt(i);
        i += 1;
      }
    }
    return out;
  }

  /**
   * keep:true 的条目：「保持原样不翻译」。
   * applyGlossary 对它们不做替换，它们的用途是交给提示词告诉模型别翻。
   */
  function glossaryKeepList(entries) {
    const out = [];
    if (!entries || !entries.length) return out;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || !e.keep) continue;
      const from = String(e.from == null ? "" : e.from).trim();
      if (from) out.push(from);
    }
    return out;
  }

  /* ============================================================
   * 型号 / 代码保护
   * ============================================================ */

  // 只放**通用**模式（色号标准、尺寸、度量单位、百分比、编号），
  // 不放任何客户专有词——那是 config.js 的职责。
  const CODE_PATTERNS = [
    // 色号：PMS 1234 C / PMS 186 C / PMS Yellow C
    "\\bPMS\\s+(?:[0-9]{2,4}(?:\\s*[A-Z]{1,3})?|[A-Za-z]+(?:\\s+[A-Za-z]+)*\\s+C)\\b",
    // 英制尺寸：4'5" / 4\u20195\u201d
    "\\d+\\s*['\u2019\u2032]\\s*\\d+\\s*[\"\u201d\u2033]",
    // 数字 + 单位：160cm / 12 kg / 3.5mm
    "\\d+(?:\\.\\d+)?\\s*(?:cm|mm|km|inch|inches|ft|feet|yd|kg|kgs|mg|lb|lbs|oz|ml|pcs|pc|set|sets)\\b",
    // 百分比：65%
    "\\d+(?:\\.\\d+)?\\s*%",
    // 连字符编号：AB-1234 / SKU-01
    "\\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)+\\b",
    // 两位以上纯数字（单位不明确时也得保住）
    "\\b\\d{2,}\\b",
  ];
  const CODE_TOKEN = new RegExp(CODE_PATTERNS.join("|"), "g");

  function toAsciiDigits(s) {
    return String(s).replace(/[\uFF10-\uFF19]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
  }

  /** 把型号/代码换成占位符，返回 { masked, codes } */
  function extractCodes(text) {
    const src = text == null ? "" : String(text);
    const codes = [];
    const masked = src.replace(CODE_TOKEN, function (m) {
      const id = PH_OPEN + codes.length + PH_CLOSE;
      codes.push(m);
      return id;
    });
    return { masked: masked, codes: codes };
  }

  /**
   * 占位符还原。
   * 编号越界（模型自己编了个数字）时原样返回占位符，让残留检测去报，绝不产出 "undefined"。
   */
  function restoreCodes(masked, codes) {
    const src = masked == null ? "" : String(masked);
    if (!codes || !codes.length) return src;
    return src.replace(PH_RESTORE, function (whole, digits) {
      const n = Number(toAsciiDigits(digits));
      if (!isFinite(n) || n < 0 || n >= codes.length) return whole;
      return codes[n];
    });
  }

  /**
   * 还原后的残留检测。原实现没有这一步，占位符被机翻吃掉后会直接漏进译文
   * （用户看到 \uE0000\uE001 或者色号整个消失却毫不知情）。
   * 返回空串表示干净。
   */
  function codeResidue(restored, codes) {
    const problems = [];
    if (PH_RESIDUE.test(String(restored))) {
      problems.push("译文里残留了未被还原的保护占位符");
    }
    const missing = [];
    for (let i = 0; i < (codes || []).length; i++) {
      if (String(restored).indexOf(codes[i]) < 0) missing.push(codes[i]);
    }
    if (missing.length) {
      problems.push("以下型号/代码可能在翻译过程中丢失：" + missing.join("、"));
    }
    return problems.length ? problems.join("；") : "";
  }

  /* ============================================================
   * 免费公共接口
   * ============================================================ */

  function googleLang(targetLang) {
    return targetLang === "zh-TW" ? "zh-TW" : "zh-CN";
  }

  async function googleTranslate(text, opts) {
    // sl=en 而不是 sl=auto：用户处理的就是英文资料。
    // auto 会在「全是型号/短词」的条目上误判成别的语言（比如把 "SEASON" 判成德文），
    // 结果整条不翻或者翻成奇怪的东西。
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=" +
      encodeURIComponent(googleLang(opts.targetLang)) +
      "&dt=t&q=" +
      encodeURIComponent(text);
    if (url.length > GOOGLE_MAX_URL) {
      throw new Error(
        "文本过长（" + text.length + " 字符），Google 免费接口的 GET 放不下，请改用它源或大模型翻译"
      );
    }
    const r = await httpRequest(url, { signal: opts.signal, timeoutMs: 20000 });
    if (!r.ok) throw new Error("Google 翻译失败：HTTP " + r.status);
    const data = r.json;
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error("Google 翻译返回格式无法识别");
    }
    const dst = data[0]
      .map(function (seg) {
        return (seg && seg[0]) || "";
      })
      .join("")
      .trim();
    if (!dst) throw new Error("Google 翻译返回空结果");
    return dst;
  }

  /** MyMemory 单次调用（text 必须已经 ≤ 480 字符） */
  async function mymemoryCall(text, opts) {
    const pair = "en|" + googleLang(opts.targetLang);
    const url =
      "https://api.mymemory.translated.net/get?q=" +
      encodeURIComponent(text) +
      "&langpair=" +
      encodeURIComponent(pair);
    const r = await httpRequest(url, { signal: opts.signal, timeoutMs: 20000 });
    if (!r.ok) throw new Error("MyMemory 翻译失败：HTTP " + r.status);
    const t = r.json && r.json.responseData && r.json.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(String(t))) {
      throw new Error("MyMemory 翻译失败：" + ((r.json && r.json.responseDetails) || "无有效译文"));
    }
    return String(t).trim();
  }

  /**
   * 把切点往左挪，避免把 \uE000n\uE001 切成两半——切断了就永远还原不回来。
   */
  function safeCut(text, cut) {
    const open = text.lastIndexOf(PH_OPEN, cut - 1);
    if (open < 0) return cut;
    const close = text.indexOf(PH_CLOSE, open);
    if (close >= 0 && close < cut) return cut; // 占位符完整落在左边，随便切
    return Math.max(1, open);
  }

  /** 按句子 → 逗号 → 空格 的顺序找切点，保证每段 ≤ limit */
  function splitForLimit(text, limit) {
    const chunks = [];
    let rest = String(text);
    const marks = ["\n", ". ", "! ", "? ", "; ", ", ", " "];
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      let cut = -1;
      for (let i = 0; i < marks.length && cut < 0; i++) {
        const at = window.lastIndexOf(marks[i]);
        if (at > limit * 0.4) cut = at + marks[i].length;
      }
      if (cut < 0) cut = limit;
      cut = safeCut(rest, cut);
      if (cut <= 0) cut = limit;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  /**
   * MyMemory 翻译。超过 480 字符**显式拆段**，并返回 warn 说明。
   * 原实现是 text.slice(0, 480) 悄悄截断——用户看到半句译文，还以为翻完了。
   */
  async function mymemoryTranslate(text, opts) {
    if (text.length <= MYMEMORY_MAX_CHARS) {
      return { text: await mymemoryCall(text, opts), warn: "" };
    }
    const chunks = splitForLimit(text, MYMEMORY_MAX_CHARS);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      U.throwIfAborted(opts.signal);
      parts.push(await mymemoryCall(chunks[i], opts));
    }
    return {
      text: parts.join(""),
      warn:
        "原文 " + text.length + " 字符超过 MyMemory 单次上限 " + MYMEMORY_MAX_CHARS +
        " 字符，已拆成 " + chunks.length + " 段调用，段与段衔接处可能不连贯",
    };
  }

  /** 免费源多源回退：Google → MyMemory；两个都挂就抛错（不静默降级） */
  async function freeTranslate(text, opts) {
    const errors = [];
    try {
      return { dst: await googleTranslate(text, opts), engine: "google", warn: "" };
    } catch (err) {
      if (U.isAbortError(err)) throw err;
      errors.push("Google：" + err.message);
    }
    try {
      const r = await mymemoryTranslate(text, opts);
      return { dst: r.text, engine: "mymemory", warn: r.warn };
    } catch (err) {
      if (U.isAbortError(err)) throw err;
      errors.push("MyMemory：" + err.message);
    }
    throw new Error("免费翻译接口全部失败（" + errors.join("；") + "）");
  }

  /* ============================================================
   * 大模型（OpenAI 兼容 /chat/completions）
   * ============================================================ */

  function stripTrailingSlash(u) {
    return String(u == null ? "" : u).trim().replace(/\/+$/, "");
  }

  // 路径最后一段是不是「版本号」（v1 / v1beta / v4 …）。
  // 判断这个是因为：有的服务 base 是 .../v1，有的是 .../compatible-mode/v1，
  // 智谱是 .../api/paas/v4 —— 它们都只需要补 /chat/completions，
  // 再补一层 /v1 就 404（"…/v4/v1/chat/completions" 不是有效端点）。
  const VERSION_SEGMENT = /\/v[0-9]+[a-z0-9.]*$/i;

  function isDeepseekHost(u) {
    return /^(https?:\/\/)?(api\.)?deepseek\.com$/i.test(u);
  }

  /**
   * Base URL → /chat/completions 端点。
   * 用户填什么的都有：带 /v1 的、不带 /v1 的、带 /v4 的、已经把整条路径写全的。
   * 少补一段 404，多补一段也 404，所以按下面顺序判定（先匹配先返回）：
   *   1. 已经以 /chat/completions 结尾 → 原样用
   *   2. 最后一段是版本号（v1/v1beta/v4…）     → 补 /chat/completions
   *   3. 官方 DeepSeek 域名（/v1 可有可无）     → 补 /chat/completions
   *   4. 其它（含裸域名）                       → 补 /v1/chat/completions
   */
  function chatEndpoint(baseUrl) {
    const u = stripTrailingSlash(baseUrl);
    if (!u) throw new Error("未填写 API Base URL");
    if (/\/chat\/completions$/i.test(u)) return u;
    if (VERSION_SEGMENT.test(u)) return u + "/chat/completions";
    if (isDeepseekHost(u)) return u + "/chat/completions";
    return u + "/v1/chat/completions";
  }

  /** Base URL → /models 端点（拉取模型列表），规则与 chatEndpoint 对齐 */
  function modelsEndpoint(baseUrl) {
    let u = stripTrailingSlash(baseUrl);
    if (!u) throw new Error("未填写 API Base URL");
    if (/\/models$/i.test(u)) return u;
    if (/\/chat\/completions$/i.test(u)) u = u.replace(/\/chat\/completions$/i, "");
    if (VERSION_SEGMENT.test(u)) return u + "/models";
    if (isDeepseekHost(u)) return u + "/models";
    return u + "/v1/models";
  }

  function llmConfig(opts, requireModel) {
    const llm = (opts && opts.llm) || {};
    const api = String(llm.api || "openai").toLowerCase();    if (api !== "openai") {
      throw new Error('文本翻译只支持 OpenAI 兼容接口（api: "openai"），收到：' + api);
    }
    const baseUrl = String(llm.baseUrl || "").trim();
    if (!baseUrl) throw new Error("未填写文本大模型的 Base URL");
    const apiKey = String(llm.apiKey || "").trim();
    if (!apiKey) throw new Error("未填写文本大模型的 API Key");
    const model = String(llm.model || "").trim();
    if (requireModel !== false && !model) throw new Error("未选择文本大模型（model 为空）");
    return {
      api: api,
      baseUrl: baseUrl,
      apiKey: apiKey,
      model: model,
      endpoint: chatEndpoint(baseUrl),
      label: llm.label || "文本大模型",
    };
  }

  function apiErrorDetail(parsed, responseText) {
    if (parsed && parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    if (parsed && typeof parsed.message === "string") return parsed.message;
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
    if (responseText) return String(responseText).slice(0, 240);
    return "";
  }

  function retryDelayMs(headers, attempt) {
    const retryAfter = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_DELAY_MS, seconds * 1000);
      const at = Date.parse(retryAfter);
      if (isFinite(at)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, at - Date.now()));
    }
    return Math.min(MAX_RETRY_DELAY_MS, 500 * Math.pow(2, attempt));
  }

  /**
   * 一次 chat/completions 调用，429 / 5xx 自动退避重试。
   * 返回模型回复的正文（可能是空串，由调用方决定空串算不算失败——
   * 测连通性时不关心内容，批量解析时才算）。
   */
  async function chatCompletion(messages, opts, extra) {
    const cfg = llmConfig(opts, true);
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const body = Object.assign(
        { model: cfg.model, temperature: 0.1, messages: messages },
        extra || {}
      );
      const r = await httpRequest(cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
        timeoutMs: opts.llmTimeoutMs || 120000,
      });
      if (r.ok) {
        const content =
          r.json && r.json.choices && r.json.choices[0] &&
          r.json.choices[0].message && r.json.choices[0].message.content;
        return typeof content === "string" ? content : "";
      }
      lastErr = new Error(cfg.label + " API 调用失败：" + (apiErrorDetail(r.json, r.text) || "HTTP " + r.status));
      lastErr.status = r.status;
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw lastErr;
      await U.sleep(retryDelayMs(r.headers, attempt), opts.signal);
    }
    throw lastErr || new Error("API 请求未能启动");
  }

  /** 系统提示词：不硬编码任何文本，全部交给 PZConfig */
  function systemMessage(opts) {
    return CONFIG.buildTranslateSystem({
      targetLang: opts.targetLang,
      glossaryEntries: opts.glossaryEntries,
      profileHint: opts.profileHint,
    });
  }

  /**
   * 从条目对象里取译文。刻意不认识 "text" 键：
   * 有些模型会把原文塞在 text 里，取错了就等于把英文当译文返回。
   */
  function pickTranslation(it) {
    if (!it || typeof it !== "object") return "";
    const keys = ["translation", "translated", "translationText", "output", "result", "dst", "zh"];
    for (let i = 0; i < keys.length; i++) {
      const v = it[keys[i]];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  /**
   * 把批量返回映射回本批的数组（可能返回 null 表示这条没拿到）。
   * 兼容三种形态：{id,translation} / 纯字符串数组 / 缺 id 的对象数组。
   */
  function mapBatchReply(content, batch) {
    const out = new Array(batch.length).fill(null);
    const items = U.coerceItems(U.extractJson(content));
    if (!items.length) return out;
    const leftovers = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it === "string") {
        if (it.trim()) leftovers.push(it.trim());
        continue;
      }
      const text = pickTranslation(it);
      if (!text) continue;
      const raw = it.id != null ? it.id : it.index;
      const id = typeof raw === "number" ? raw : Number(raw);
      if (isFinite(id) && id >= 0 && id < batch.length && !out[id]) out[id] = text;
      else leftovers.push(text);
    }
    for (let i = 0, k = 0; i < batch.length && k < leftovers.length; i++) {
      if (!out[i]) out[i] = leftovers[k++];
    }
    return out;
  }

  /** 单条调用（兜底路径）：system 提示词 + 该条原文 */
  function singleReplyToText(content) {
    const s = String(content == null ? "" : content).trim();
    if (!s) return "";
    const items = U.coerceItems(U.extractJson(s));
    for (let i = 0; i < items.length; i++) {
      const t = typeof items[i] === "string" ? items[i].trim() : pickTranslation(items[i]);
      if (t) return t;
    }
    return s.replace(/^["'\u201c\u201d]+/, "").replace(/["'\u201c\u201d]+$/, "").trim();
  }

  async function llmOne(text, opts) {
    const content = await chatCompletion(
      [
        { role: "system", content: systemMessage(opts) },
        { role: "user", content: text },
      ],
      opts
    );
    const dst = singleReplyToText(content);
    if (!dst) throw new Error("大模型返回空译文");
    return dst;
  }

  /**
   * 批量翻译：每 24 条一个请求，JSON 数组进出。
   * 返回数组与入参等长，取不到的位置是 null（由调用方逐条重试）。
   * 请求本身失败直接抛错——逐条重试只会把同一个错误重复 N 遍。
   */
  async function llmBatchTranslate(texts, opts, onBatchDone) {
    const out = new Array(texts.length).fill(null);
    for (let start = 0; start < texts.length; start += LLM_BATCH_SIZE) {
      U.throwIfAborted(opts.signal);
      const batch = texts.slice(start, start + LLM_BATCH_SIZE);
      let content = "";
      try {
        content = await chatCompletion(
          [
            { role: "system", content: systemMessage(opts) },
            { role: "user", content: CONFIG.buildTranslateBatchUser(batch, { targetLang: opts.targetLang }) },
          ],
          opts
        );
      } catch (err) {
        if (U.isAbortError(err)) throw err;
        throw new Error("大模型批量翻译失败（第 " + (Math.floor(start / LLM_BATCH_SIZE) + 1) + " 批）：" + err.message);
      }
      // 解析失败 → 只让这一批降级成逐条，不影响其它批
      const mapped = mapBatchReply(content, batch);
      let resolved = 0;
      for (let i = 0; i < batch.length; i++) {
        if (mapped[i]) {
          out[start + i] = mapped[i];
          resolved++;
          continue;
        }
        out[start + i] = await llmOne(batch[i], opts); // 失败直接抛，不吞
        resolved++;
      }
      if (onBatchDone) onBatchDone(resolved);
    }
    return out;
  }

  /** 文本模型的连通性测试（只要 HTTP 通就算通过，不校验内容） */
  async function testLlm(opts) {
    const o = normalizeOpts(opts);
    const cfg = llmConfig(o, true);
    const t0 = Date.now();
    await chatCompletion([{ role: "user", content: "ping" }], o, { max_tokens: 16 });
    return { ok: true, model: cfg.model, endpoint: cfg.endpoint, latencyMs: Date.now() - t0 };
  }

  /** 拉取模型 ID 列表（不需要 model 本身） */
  async function listLlmModels(opts) {
    const o = normalizeOpts(opts);
    const cfg = llmConfig(o, false);
    U.throwIfAborted(o.signal);
    const r = await httpRequest(modelsEndpoint(cfg.baseUrl), {
      method: "GET",
      headers: {
        Authorization: "Bearer " + cfg.apiKey,
        "Content-Type": "application/json",
      },
      signal: o.signal,
      timeoutMs: 25000,
    });
    if (!r.ok) {
      throw new Error(cfg.label + " 拉取模型失败：" + (apiErrorDetail(r.json, r.text) || "HTTP " + r.status));
    }
    const data = r.json && r.json.data;
    if (!Array.isArray(data)) throw new Error(cfg.label + " 模型列表格式无法识别");
    const ids = data
      .map(function (m) {
        return (m && (m.id || m.name)) || "";
      })
      .filter(Boolean);
    if (!ids.length) throw new Error(cfg.label + " 未返回任何模型");
    ids.sort();
    return ids;
  }

  /* ============================================================
   * 结果整理
   * ============================================================ */

  function isMostlyHan(text) {
    const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return han > latin;
  }

  function cleanupPunct(s) {
    return String(s)
      .replace(/\s+([，。；：！？、）】」』])/g, "$1")
      .replace(/([（【「『])\s+/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  /* ============================================================
   * 缓存
   * ============================================================ */

  const CACHE = new Map();

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function glossaryFingerprint(entries) {
    if (!entries || !entries.length) return "0";
    const parts = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] || {};
      parts.push(String(e.from == null ? "" : e.from) + "\u0002" + String(e.to == null ? "" : e.to) + "\u0002" + (e.keep ? "1" : "0"));
    }
    return fnv1a(parts.join("\u0003"));
  }

  /**
   * 缓存键。
   * 必须含 targetLang + engine + 原文：只按原文缓存的话，先翻简中再切繁中会直接
   * 命中简中旧结果（繁简串味，用户一眼就能看出来）。
   * 再带上模型与术语表指纹：换了模型 / 改了术语表就该重翻，否则改动"不生效"。
   */
  function cacheKey(raw, opts) {
    const model =
      opts.engine === "llm" && opts.llm
        ? String(opts.llm.model || "") + "@" + String(opts.llm.baseUrl || "")
        : "";
    return [
      opts.targetLang,
      opts.engine,
      model,
      glossaryFingerprint(opts.glossaryEntries),
      opts.preserveCodes ? "1" : "0",
      raw,
    ].join("\u0001");
  }

  function clearCache() {
    CACHE.clear();
  }

  function copyResult(r) {
    return { dst: r.dst, engine: r.engine, warn: r.warn || "" };
  }

  function toItem(src, r) {
    const item = { src: src, dst: r.dst, engine: r.engine };
    if (r.warn) item.warn = r.warn;
    return item;
  }

  /* ============================================================
   * 主流程
   * ============================================================ */

  /**
   * 兼容两种传参风格：契约里是 opts.llm = {api, baseUrl, apiKey, model}，
   * 但有些调用方（比如测试连接、拉模型列表）习惯把这几项平铺在 opts 顶层。
   * 两种都收，免得调用方猜；平铺项只有在 opts.llm 缺失时才生效。
   */
  function flatLlm(o) {
    if (!o) return null;
    const hasAny = o.baseUrl || o.apiKey || o.model;
    if (!hasAny) return null;
    return {
      api: o.api,
      baseUrl: o.baseUrl,
      apiKey: o.apiKey,
      model: o.model,
      label: o.label,
      provider: o.provider,
    };
  }

  function normalizeOpts(opts) {
    const o = opts || {};
    return {
      engine: o.engine || "free",
      targetLang: o.targetLang || "zh-CN",
      glossaryEntries: Array.isArray(o.glossaryEntries) ? o.glossaryEntries : [],
      profileHint: o.profileHint || "",
      signal: o.signal || null,
      concurrency: o.concurrency,
      preserveCodes: o.preserveCodes !== false,
      llm: o.llm || flatLlm(o),
      llmTimeoutMs: o.llmTimeoutMs,
      hooks: o.hooks || null,
    };
  }

  function reportProgress(hooks, phase, done, total, message) {
    const fn = hooks && hooks.onProgress;
    if (typeof fn !== "function") return;
    // 两种回调风格都支持：
    //   onProgress({ phase, done, total, message })  ← 架构契约里的写法
    //   onProgress(done, total)                      ← 老接口 / app.js 的写法
    // 用形参个数区分（用了解构的话形参仍然只有 1 个，所以判断是可靠的）
    if (fn.length >= 2) fn(done, total);
    else fn({ phase: phase, done: done, total: total, message: message || "" });
  }

  function logLine(hooks, text) {
    if (hooks && typeof hooks.onLog === "function") hooks.onLog(text);
  }

  /**
   * 不联网就能定的部分：缓存 / 空行 / 已是中文 / 仅术语表 / 纯代码。
   * 返回 { done } 或 { ctx }（ctx 表示必须送翻译引擎）。
   */
  function prepare(raw, opts) {
    if (!raw.trim()) return { done: { dst: "", engine: "skip", warn: "" } };
    // 已经是中文的行（比如原文件里本来就有中文标注）不要送去机翻，
    // 机翻会把中文再"翻"一遍，反而翻坏。
    if (isMostlyHan(raw)) return { done: { dst: raw, engine: "skip", warn: "" } };

    const key = cacheKey(raw, opts);
    if (CACHE.has(key)) return { done: copyResult(CACHE.get(key)), key: key };

    const engine = opts.engine || "free";
    if (engine === "dict") {
      return { done: { dst: applyGlossary(raw, opts.glossaryEntries), engine: "glossary", warn: "" }, key: key };
    }

    // 术语表预扫：整条都被术语表覆盖的短标签不必联网。
    // 这不算"静默降级"——它确实已经翻完了，并且 engine 明确标成 glossary。
    const pre = applyGlossary(raw, opts.glossaryEntries);
    if (pre !== raw && !/[A-Za-z]/.test(pre)) {
      return { done: { dst: pre, engine: "glossary", warn: "" }, key: key };
    }

    const preserve = opts.preserveCodes !== false;
    const masked = preserve ? extractCodes(raw) : { masked: raw, codes: [] };
    // 保护掉型号之后完全没有拉丁字母，说明这一条没有可翻的内容（纯数字/色号/尺寸），
    // 送机翻只会白跑一趟，直接按原文返回。
    if (!/[A-Za-z]/.test(masked.masked)) {
      return { done: { dst: raw, engine: "skip", warn: "" }, key: key };
    }
    // 送引擎的是**原文的掩码**，不是术语表替换后的中英混排文本：
    // 把 "刺绣 PANEL" 这种半成品丢给机翻，出来的往往是更差的混排。
    return {
      ctx: { raw: raw, payload: masked.masked, codes: masked.codes, preserve: preserve, key: key },
    };
  }

  /** 引擎返回之后的收尾：还原占位符 → 残留检测 → 术语表兜底 → 标点清理 */
  function finishCtx(ctx, translated, engine, warn, opts) {
    if (translated == null || !String(translated).trim()) {
      throw new Error("翻译引擎返回空结果（engine=" + engine + "）");
    }
    let dst = String(translated);
    let w = warn || "";
    if (ctx.preserve && ctx.codes.length) {
      dst = restoreCodes(dst, ctx.codes);
      const residue = codeResidue(dst, ctx.codes);
      if (residue) w = w ? w + "；" + residue : residue;
    }
    // 兜底：模型漏译的术语用术语表补上；keep 项不参与替换，正合"保持原样"的要求
    dst = applyGlossary(dst, opts.glossaryEntries);
    dst = cleanupPunct(dst);
    if (!dst) throw new Error("翻译结果为空（engine=" + engine + "）");
    const r = { dst: dst, engine: engine, warn: w };
    if (ctx.key) CACHE.set(ctx.key, r);
    return r;
  }

  /** 免费源路径（单条） */
  async function networkTranslate(ctx, opts) {
    const engine = opts.engine || "free";
    if (engine === "google") {
      return finishCtx(ctx, await googleTranslate(ctx.payload, opts), "google", "", opts);
    }
    if (engine === "mymemory") {
      const r = await mymemoryTranslate(ctx.payload, opts);
      return finishCtx(ctx, r.text, "mymemory", r.warn, opts);
    }
    if (engine === "free") {
      const r = await freeTranslate(ctx.payload, opts);
      return finishCtx(ctx, r.dst, r.engine, r.warn, opts);
    }
    throw new Error("不认识的翻译引擎：" + engine);
  }

  async function translateOne(text, opts) {
    const o = normalizeOpts(opts);
    const hooks = o.hooks;
    const raw = String(text == null ? "" : text);
    const p = prepare(raw, o);
    if (p.done) {
      if (p.key) CACHE.set(p.key, p.done);
      return toItem(raw, p.done);
    }
    U.throwIfAborted(o.signal);
    let done = null;
    if (o.engine === "llm") {
      done = finishCtx(p.ctx, await llmOne(p.ctx.payload, o), "llm", "", o);
    } else {
      done = await networkTranslate(p.ctx, o);
    }
    reportProgress(hooks, "translate", 1, 1, "");
    return toItem(raw, done);
  }

  async function translateMany(texts, opts, hooks) {
    const o = normalizeOpts(opts);
    if (!o.hooks) o.hooks = hooks || null;
    const h = o.hooks;
    const list = Array.isArray(texts) ? texts : [];

    // 去重：同一段英文在一页里出现十次只翻一次，省请求也省时间。
    // 键用 trim 后的文本，src 仍返回调用方传进来的原串（保证能按原文映射回位置）。
    const unique = [];
    const at = new Map();
    for (let i = 0; i < list.length; i++) {
      const raw = String(list[i] == null ? "" : list[i]);
      const key = raw.trim();
      if (!key) continue;
      if (!at.has(key)) {
        at.set(key, unique.length);
        unique.push(key);
      }
    }

    const out = new Array(unique.length).fill(null);
    let finished = 0;
    const tick = function (n) {
      finished += n;
      reportProgress(h, "translate", Math.min(finished, unique.length), unique.length, "");
    };

    logLine(h, "待翻译 " + unique.length + " 条（去重前 " + list.length + " 条），引擎 " + o.engine);

    // 1) 先把手头就能定的处理掉（缓存 / 术语表 / 纯代码 / 已是中文）
    const pending = [];
    for (let i = 0; i < unique.length; i++) {
      const p = prepare(unique[i], o);
      if (p.done) {
        if (p.key) CACHE.set(p.key, p.done);
        out[i] = p.done;
      } else {
        pending.push({ index: i, ctx: p.ctx });
      }
    }
    tick(unique.length - pending.length);

    try {
      if (pending.length) {
        if (o.engine === "llm") {
          // 大模型：把所有待翻的掩码文本按 24 条一批发出去
          const results = await llmBatchTranslate(
            pending.map(function (j) { return j.ctx.payload; }),
            o,
            tick
          );
          for (let i = 0; i < pending.length; i++) {
            out[pending[i].index] = finishCtx(pending[i].ctx, results[i], "llm", "", o);
          }
        } else {
          // 免费源/指定源：并发池逐条请求，顺序与 pending 一致
          await U.pool(
            pending,
            async function (job) {
              const r = await networkTranslate(job.ctx, o);
              out[job.index] = r;
              tick(1);
              return r;
            },
            {
              concurrency: o.concurrency || 4,
              signal: o.signal,
              failFast: true, // 失败就整体抛错，不要"装作翻完了"
            }
          );
        }
      }
    } catch (err) {
      // 大声抛错，但把已经翻好的部分带出去，界面还能显示（而不是一片空白）
      err.partial = expand(list, at, out);
      err.translatedCount = out.filter(Boolean).length;
      throw err;
    }

    logLine(h, "翻译完成：" + out.filter(Boolean).length + " 条");
    return expand(list, at, out);
  }

  function expand(list, at, out) {
    const items = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] == null ? "" : String(list[i]);
      const key = raw.trim();
      if (!key) {
        // 空白行不是"失败"，也没什么可翻的，明确标成 skip
        items[i] = { src: raw, dst: "", engine: "skip" };
        continue;
      }
      const idx = at.get(key);
      const r = idx === undefined ? null : out[idx];
      if (!r) {
        // 走到这里说明整体失败了（异常路径），用 failed 明确标出来，
        // 而不是拿原文冒充译文
        items[i] = { src: raw, dst: "", engine: "failed" };
      } else {
        items[i] = toItem(raw, r);
      }
    }
    return items;
  }

  global.PZTranslate = {
    VERSION: VERSION,
    // 契约接口
    translateMany: translateMany,
    translateOne: translateOne,
    applyGlossary: applyGlossary,
    glossaryKeepList: glossaryKeepList,
    testLlm: testLlm,
    listLlmModels: listLlmModels,
    // 代码保护（单测需要直接验证往返）
    extractCodes: extractCodes,
    restoreCodes: restoreCodes,
    codeResidue: codeResidue,
    // 端点规则（界面上的"测试连接/拉取模型"要显示真实 URL）
    chatEndpoint: chatEndpoint,
    modelsEndpoint: modelsEndpoint,
    // 维护接口
    clearCache: clearCache,
    setFetch: setFetch,
  };
})(typeof window !== "undefined" ? window : globalThis);
