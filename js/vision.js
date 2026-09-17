/**
 * PZVision — 云端视觉模型客户端（Gemini / OpenAI 兼容）
 *
 * 设计要点（以及为什么这么做）：
 *  1. **提示词一律从 PZConfig 生成**。这个文件里一个字都不许写领域词汇
 *     （具体行业、品牌、工艺名词都不行），否则换一个领域的资料就又废了。
 *     领域词只允许从 opts.profileHint / glossaryEntries 进来。
 *  2. **两遍识别**：先按检测出来的区域放大逐块识别（小字看得清），
 *     再整图兜底识别一遍（把检测漏掉的捡回来）。第二遍不能省 —— 漏字是这个工具最大的痛点。
 *  3. **坐标全程只有一套**：模型返回的是「相对当前送出图片、归一化 0-1000」的框，
 *     统一经 `_mapBoxFromCrop` 映射回整图左上角原点的像素坐标。
 *  4. 纯逻辑函数（映射/解析/去重/端点拼接/裁切计划）单独导出成 `_xxx`，
 *     不碰 canvas 也不碰网络，可以在 Node 里直接单测。
 *
 * 经典脚本（非 ES module），挂到 window.PZVision。
 */
(function (global) {
  "use strict";

  function util() {
    const u = global.PZUtil;
    if (!u) throw new Error("PZVision 依赖 PZUtil，请先加载 js/util.js");
    return u;
  }

  function config() {
    const c = global.PZConfig;
    if (!c) throw new Error("PZVision 依赖 PZConfig，请先加载 js/config.js");
    return c;
  }

  /* ============================================================
   * 常量
   * ============================================================ */

  // JPEG 而不是 PNG：同样的画质下体积小一个数量级，请求快、也不容易撞到
  // 各家服务端对单张图片的字节上限。0.92 是"肉眼看不出损失"的常用值。
  const JPEG_MIME = "image/jpeg";
  const JPEG_QUALITY = 0.92;

  // 单次请求的超时与重试策略
  const REQUEST_TIMEOUT_MS = 90000;
  const MAX_RETRIES = 2; // 429/5xx 最多再试 2 次（共 3 次）
  const RETRY_BASE_MS = 600;
  const RETRY_MAX_MS = 10000;

  const SYSTEM_JSON =
    "你是 JSON 输出接口，只输出合法 JSON。";

  /**
   * box 缺失/退化时用的兜底框尺寸。
   * 按图算：短边的 2.5%，但不小于 24px、不大于 200px。
   * 为什么不用固定 8px：8px 在长边 2000 的图上连一个字母都盖不住，
   * 反而会贴出一堆没有意义的碎片；24px 起至少能盖住一行小字。
   */
  function fallbackBoxFor(imgW, imgH) {
    const minSide = Math.max(1, Math.min(imgW || 1, imgH || 1));
    const s = Math.round(Math.max(24, Math.min(200, minSide * 0.025)));
    return { w: s, h: Math.max(12, Math.round(s * 0.5)) };
  }

  /** 模型名兜底：用户没填模型时不能把 URL 拼成 .../models/:generateContent */
  const FALLBACK_MODELS = { gemini: "gemini-2.5-flash", openai: "gpt-4o-mini" };

  function limits(opts) {
    const L = config().LIMITS || {};
    const o = (opts && opts.limits) || {};
    // 只覆盖调用方显式给出的键，避免调用方传了半套 limits 就把默认值抹成 undefined
    const out = {};
    const keys = Object.keys(L);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = L[keys[i]];
    const okeys = Object.keys(o);
    for (let i = 0; i < okeys.length; i++) {
      if (o[okeys[i]] != null) out[okeys[i]] = o[okeys[i]];
    }
    return out;
  }

  function textOf(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  }

  /**
   * 清理模型给的文本：压掉多余空白、去掉首尾的"包裹引号"和项目符号。
   *
   * 关键取舍：数字后面的引号是英寸符号，绝对不能剥 —— 把 3.5" 变成 3.5
   * 会直接改错尺寸。所以只剥"看起来是包裹用的引号"：引号后面还得跟着
   * 字母或汉字才算，且结尾的引号前面不能是数字。
   */
  function cleanText(s) {
    return textOf(s)
      .replace(/\u00a0/g, " ")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s·•\-–—:：]+/, "")
      // 开头的包裹引号：后面必须跟字母/数字/汉字才算（"Front、"EMBROIDERY）
      .replace(/^(['"“”‘’])(?=[A-Za-z0-9\u4e00-\u9fff])/, "")
      .replace(/[\s·•\-–—:：]+$/, "")
      // 结尾的包裹引号：前面不能是数字（3.5" 是英寸，不能剥）
      .replace(/([^0-9])['"“”‘’]$/, "$1")
      .trim();
  }

  /** 一个"看起来像文字"的最小门槛。太短的、纯符号的（表格线、图标碎片）直接丢 */
  function looksReadable(s) {
    if (!s) return false;
    const hasWord = /[A-Za-z0-9\u4e00-\u9fff]/.test(s);
    if (!hasWord) return false;
    if (s.length < 2 && !/[A-Za-z0-9\u4e00-\u9fff]/.test(s)) return false;
    return true;
  }

  /* ============================================================
   * 端点拼接
   *
   * baseUrl 在真实世界里五花八门，实测过的写法：
   *   https://generativelanguage.googleapis.com
   *   https://generativelanguage.googleapis.com/v1beta
   *   .../v1beta/models
   *   https://api.openai.com/v1
   *   https://api.deepseek.com              （裸域名，没有版本号！）
   *   https://dashscope.aliyuncs.com/compatible-mode/v1
   *   https://open.bigmodel.cn/api/paas/v4
   *   以及用户把整个 .../chat/completions 都贴进来的情况
   * 所以这里要"先剥掉尾巴上的冗余段，再按协议补回来"。
   * ============================================================ */

  /** 去掉末尾斜杠 */
  function trimSlashes(s) {
    return String(s == null ? "" : s).trim().replace(/\/+$/, "");
  }

  function isValidUrl(u) {
    return typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u);
  }

  /** 末尾是不是版本号段：v1 / v1beta / v2 / v4 / v1beta2 ... */
  function isVersionSegment(seg) {
    return /^v\d+[a-z]*\d*$/i.test(seg);
  }

  /** 归一化 baseUrl：补协议、去尾斜杠，顺便把末尾的 query/hash 切掉 */
  function normalizeBaseUrl(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    const cut = s.search(/[?#]/);
    if (cut >= 0) s = s.slice(0, cut);
    s = trimSlashes(s);
    if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    return s;
  }

  /** 模型名可能被写成 "models/gemini-2.5-flash" 或带路径，统一取最后一段 */
  function normalizeModel(model, api) {
    let m = String(model == null ? "" : model).trim().replace(/^\/+/, "");
    if (!m) return FALLBACK_MODELS[api === "gemini" ? "gemini" : "openai"];
    // 用户可能贴了完整 URL
    if (/^https?:\/\//i.test(m)) {
      const parts = m.split("?")[0].replace(/\/+$/, "").split("/");
      m = parts[parts.length - 1] || m;
    }
    return m.replace(/^models\//i, "");
  }

  /** 去掉 baseUrl 尾巴上可能已经存在的同类路径段 */
  function stripIfMatch(base, re) {
    let s = base;
    let guard = 0;
    while (guard++ < 4 && re.test(s)) s = s.replace(re, "");
    return s;
  }

  /**
   * 统一端点拼接。
   * kind: "chat"（识别请求） | "models"（拉模型列表）
   */
  function _endpoint(baseUrl, kind, api) {
    const k = kind === "models" ? "models" : "chat";
    const a = api === "gemini" ? "gemini" : "openai";
    let base = normalizeBaseUrl(baseUrl);
    if (!base) {
      if (a === "gemini") base = "https://generativelanguage.googleapis.com";
      else base = "https://api.openai.com/v1";
    }

    if (a === "gemini") {
      // 先切掉 query/hash，否则 "...:generateContent?alt=sse" 这种尾巴剥不干净
      const cut = base.search(/[?#]/);
      if (cut >= 0) base = base.slice(0, cut);
      // 用户很可能把整个 .../models/gemini-2.5-flash:generateContent 贴进来，
      // 这里截断到 /models 之前，剩下的模型名与动作一把丢掉
      const mi = base.indexOf("/models");
      if (mi >= 0 && /^\/models(\/|:|$)/.test(base.slice(mi))) base = base.slice(0, mi);
      base = base.replace(/(:streamGenerateContent|:generateContent|\/[^/:]+:.*)$/i, "");
      base = stripIfMatch(base, /\/models$/i);
      base = stripIfMatch(base, /\/v\d+[a-z]*\d*$/i);
      return base + "/v1beta/" + (k === "models" ? "models" : "models/{model}:generateContent");
    }

    if (k === "models") {
      base = stripIfMatch(base, /\/chat\/completions$/i);
      // 判断"路径里到底有没有版本号"要整段看：
      // https://dashscope.aliyuncs.com/compatible-mode/v1 有（不能重复加），
      // https://api.deepseek.com 没有（必须补 /v1，否则打的是不存在的根路径）。
      const hasVersion = /\/v\d+[a-z]*\d*(\/|$)/i.test(base.replace(/^https?:\/\/[^/]+/i, ""));
      base = stripIfMatch(base, /\/models$/i);
      if (!hasVersion) base += "/v1";
      return base + "/models";
    }

    if (/\/chat\/completions$/i.test(base)) return base;
    base = stripIfMatch(base, /\/models$/i);
    // 裸域名 / 只写到 /compatible-mode 的，补一个默认版本号；已经带 vN 的保持原样
    if (base && !/\/v\d+[a-z]*\d*$/i.test(base)) base += "/v1";
    return base + "/chat/completions";
  }

  /** 把 {model} 占位符换成真实模型名；Gemini 走 query 传 key，OpenAI 走 header */
  function resolveEndpoint(url, model, api, apiKey) {
    let u = url;
    if (u.indexOf("{model}") >= 0) {
      u = u.replace("{model}", encodeURIComponent(model));
    }
    if (api === "gemini" && apiKey) {
      u += (u.indexOf("?") >= 0 ? "&" : "?") + "key=" + encodeURIComponent(apiKey);
    }
    return u;
  }

  /* ============================================================
   * 区域裁切计划
   * ============================================================ */

  /**
   * 算一个区域该怎么裁、放大多少倍。
   *
   * 为什么要放大：客户给的是电子截图，小字一个字符可能只有 5~8 px，
   * 直接送模型等于送一团糊；放大到 20~40 px 模型才认得出。
   * 但同时要压住上限 —— 一张动辄几千像素的裁切图会让请求又慢又贵，还可能被服务端拒收。
   */
  function _cropForRegion(region, W, H, opts) {
    const u = util();
    const L = limits(opts);
    const r = u.toRect(region);
    const padRatio = L.regionCropPadRatio != null ? L.regionCropPadRatio : 0.12;
    const minSide = L.regionCropMinSide || 640;
    const maxSide = L.regionCropMaxSide || 1400;
    const zoomMax = L.regionCropZoomMax || 4;

    const pad = Math.max(
      4,
      Math.round(Math.max(Math.abs(r.w), Math.abs(r.h)) * padRatio)
    );
    const x0 = u.clamp(Math.floor(r.x - pad), 0, Math.max(0, W));
    const y0 = u.clamp(Math.floor(r.y - pad), 0, Math.max(0, H));
    const x1 = u.clamp(Math.ceil(r.x + r.w + pad), 0, Math.max(0, W));
    const y1 = u.clamp(Math.ceil(r.y + r.h + pad), 0, Math.max(0, H));

    // 极端情况（区域完全在图外 / 退化）给一个 1px 的合法框，避免 cropCanvas 出 NaN
    const sw = Math.max(1, x1 - x0);
    const sh = Math.max(1, y1 - y0);
    const longSide = Math.max(sw, sh);

    // 目标：放大后长边尽量落在 [minSide, maxSide]
    let scale = u.clamp(minSide / longSide, 1, zoomMax);
    if (longSide * scale > maxSide) scale = maxSide / Math.max(1, longSide);

    return { x: x0, y: y0, w: sw, h: sh, srcW: sw, srcH: sh, pad: pad, scale: scale };
  }

  /* ============================================================
   * 坐标映射
   * ============================================================ */

  function validOffset(crop) {
    if (!crop || typeof crop !== "object") return null;
    const x = Number(crop.x);
    const y = Number(crop.y);
    const scale = Number(crop.scale);
    if (!isFinite(x) || !isFinite(y) || !isFinite(scale) || scale <= 0) return null;
    return { x: x, y: y, scale: scale };
  }

  /**
   * 归一化 0-1000 的框 → 数组（容忍模型给出的各种越界值）。
   *
   * 为什么不无条件钳到 [0,1000]：文字贴着裁切边时模型经常给 -5 或 1010。
   * 统一钳到 0/1000 会让这个框在映射回整图时丢掉贴边的那几像素。
   * 这里只裁掉"明显是噪声"的部分（超出 ±8%），剩下的交给整图钳制那一步。
   */
  function normalizeBox1000(raw) {
    if (!raw) return null;
    let v;
    if (Array.isArray(raw)) v = raw.slice(0, 4);
    else if (typeof raw === "object") {
      let x0 = raw.x0;
      let y0 = raw.y0;
      let x1 = raw.x1;
      let y1 = raw.y1;
      if (x0 == null && raw.x != null) x0 = raw.x;
      if (y0 == null && raw.y != null) y0 = raw.y;
      if (x1 == null && raw.x2 != null) x1 = raw.x2;
      if (y1 == null && raw.y2 != null) y1 = raw.y2;
      v = [x0, y0, x1, y1];
    } else return null;

    let a = [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
    for (let i = 0; i < 4; i++) if (!isFinite(a[i])) return null;

    // 有的模型给 0-1 的小数。判据要小心：完全合法的满幅框就是 [0,0,1000,1000]，
    // 不能因为 min<=1 就再乘一次 1000（那会把整张图缩成左上角一个点）。
    // 只用 max<2 判断：满幅框的 max 是 1000，不会被误判。
    const maxV = Math.max(a[0], a[1], a[2], a[3]);
    if (maxV < 2) a = a.map(function (n) { return n * 1000; });
    // 负数是"指向左上角之外"的意思，取绝对值是常见模型的写法
    a = a.map(function (n) { return Math.abs(n); });

    const lo = -80;
    const hi = 1080;
    a = a.map(function (n) { return Math.min(hi, Math.max(lo, n)); });

    let x0 = Math.min(a[0], a[2]);
    let y0 = Math.min(a[1], a[3]);
    let x1 = Math.max(a[0], a[2]);
    let y1 = Math.max(a[1], a[3]);
    // 退化成一个点/一条线时给个最小尺寸：0.6% 的画面（1000 尺度上就是 6 单位）
    if (x1 - x0 < 6) x1 = x0 + 6;
    if (y1 - y0 < 6) y1 = y0 + 6;
    return [x0, y0, x1, y1];
  }

  /**
   * 裁切图坐标 → 整图坐标。
   *
   * box 是「归一化 0-1000、相对当前送出（可能被放大过的）裁切图」，
   * cropOffset 是 PZUtil.cropCanvas 挂在返回画布上的 _cropOffset。
   *
   *   x, y       = 裁切框在整图里的左上角（原图像素）
   *   srcW, srcH = 裁切框在**放大前**的尺寸（原图像素）
   *   scale      = 放大倍数
   *   ⇒ 交给模型的裁切画布尺寸 = srcW*scale × srcH*scale
   *
   * 模型量的 box 是相对「放大后的裁切画布」做 0-1000 归一化的，那张画布的宽是
   * srcW*scale，所以：
   *   cropX = (box/1000) * srcW * scale      ← 裁切画布内的像素
   *   fullX = offset.x + cropX / scale
   *         = offset.x + (box/1000) * srcW    ← scale 约掉，不参与计算
   *
   * 【历史坑，别再踩】曾经写成 `fullX = x + (box/1000 * srcW) / scale`，
   * 等于把 srcW 当成了"放大后的宽度"，于是多除一个 scale：放大 4 倍时
   * 映射回来的框整体缩成 1/4 并贴向裁切框左上角，排版直接崩。
   * 注意注释里那句 `cropX = box/1000 * 裁切图.width` 本来是对的
   * （裁切图.width 就是放大后的宽度），错的是实现里用的 srcW 又除了 scale。
   *
   * 两条自检（单测里已钉住）：
   *   · 同一块裁切换不同 scale，映射结果必须一模一样（否则排版随放大倍数漂移）
   *   · PZUtil.cropCanvas 裁出来的画布宽度 = round(srcW * scale)，反推能对上
   *
   * 整图兜底那一遍传的是 {x:0, y:0, scale:f, srcW:W, srcH:H}，W 是缩图前的原图宽度，
   * 同样满足上面的语义 —— 所以同一个公式对两遍都成立，不需要分支。
   *
   * 最后必须钳在整图范围内，并保证 x1 > x0 + 1 ——
   * 否则后面 overlay 会拿到零宽零高甚至负数的框，画出来是一条线或是 NaN。
   */
  function _mapBoxFromCrop(box, cropOffset, imgW, imgH, fallback) {
    const u = util();
    const W = Math.max(1, Math.round(Number(imgW) || 1));
    const H = Math.max(1, Math.round(Number(imgH) || 1));
    const off = validOffset(cropOffset);
    // 归一化后的框。模型完全没给坐标时这里是 null，交给下面的兜底框处理 ——
    // 不能兜底成 [0,0,6,6]，那会把"不知道在哪"的文字硬塞到左上角一个小点上。
    const b = normalizeBox1000(box);
    // 裁切块在「未放大的像素空间」里的尺寸 srcW/srcH，也按可靠性分三层取：
    //   ① cropOffset.srcW（cropCanvas 直接给的，最准）
    //   ② 裁切画布尺寸 / scale（自己反推；cropCanvas 的 dw = round(sw*scale)）
    //   ③ 整图尺寸（没有 cropOffset 时就是整图那一条路径，此时 scale 按 1 算）
    const rawSrcW = Number(cropOffset && cropOffset.srcW);
    const rawSrcH = Number(cropOffset && cropOffset.srcH);
    const canvasW = Number(cropOffset && cropOffset.width);
    const canvasH = Number(cropOffset && cropOffset.height);
    const scale = off ? off.scale : 1;
    const srcW = rawSrcW > 0 ? rawSrcW : canvasW > 0 ? canvasW / scale : W;
    const srcH = rawSrcH > 0 ? rawSrcH : canvasH > 0 ? canvasH / scale : H;
    const ox = off ? off.x : 0;
    const oy = off ? off.y : 0;

    // 见上面的推导：完整算式是 (box/1000)*(srcW*scale)/scale，scale 约掉后不参与计算。
    // 也就是说映射结果只取决于「裁切框在原图里的位置与尺寸」，与放大倍数无关 ——
    // 这正是我们要的：改 regionCropZoomMax 不应该让中文框整体漂移。
    let x0 = b ? ox + (b[0] / 1000) * srcW : NaN;
    let y0 = b ? oy + (b[1] / 1000) * srcH : NaN;
    let x1 = b ? ox + (b[2] / 1000) * srcW : NaN;
    let y1 = b ? oy + (b[3] / 1000) * srcH : NaN;

    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) {
      // 模型没给坐标：整条用兜底框，位置取裁切块左上角（比塞到整图原点更合理）
      const fb = fallback && fallback.w > 0 && fallback.h > 0 ? fallback : fallbackBoxFor(W, H);
      x0 = Number(fb.x) || ox;
      y0 = Number(fb.y) || oy;
      x1 = x0 + fb.w;
      y1 = y0 + fb.h;
    }

    x0 = u.clamp(x0, 0, W);
    y0 = u.clamp(y0, 0, H);
    x1 = u.clamp(x1, 0, W);
    y1 = u.clamp(y1, 0, H);

    // 保证最小 2px、且不越出整图
    if (x1 <= x0 + 1) {
      x1 = Math.min(W, x0 + 2);
      x0 = Math.max(0, Math.min(x0, x1 - 2));
    }
    if (y1 <= y0 + 1) {
      y1 = Math.min(H, y0 + 2);
      y0 = Math.max(0, Math.min(y0, y1 - 2));
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ============================================================
   * 模型输出解析（字段名兼容）
   *
   * 现实：不管提示词怎么要求，各家模型/兼容网关返回的字段名都不会统一。
   * 缺字段比报错好得多，所以这里一律"多名字命中的第一个有效值"。
   * ============================================================ */

  const SRC_KEYS = ["text", "source", "src", "original", "原文", "content", "label"];
  const DST_KEYS = [
    "translation", "dst", "translated", "译文", "target",
    "translation_zh", "chinese", "target_text",
  ];
  const BOX_KEYS = [
    "box", "bbox", "bbox_2d", "coords", "rect", "bounds",
    "box_2d", "rectangle", "position", "region",
  ];

  /** 铺平可能的嵌套：{"text": {"content": "..."}} */
  function keyText(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number") {
        const s = textOf(v);
        if (s) return s;
      } else if (typeof v === "object") {
        // 少数网关会把 text 包一层
        const inner = v.text != null ? v.text : v.content != null ? v.content : v.value;
        if (inner != null) {
          const s = textOf(inner);
          if (s) return s;
        }
      }
    }
    return "";
  }

  function pickKey(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return undefined;
  }

  /** 对象形态的框：{x0,y0,x1,y1} / {x,y,w,h} / {left,top,right,bottom} */
  function rectFromObject(o) {
    if (!o || typeof o !== "object") return null;
    const num = function (v) {
      const n = Number(v);
      return isFinite(n) ? n : null;
    };
    let x0 = num(o.x0);
    let y0 = num(o.y0);
    let x1 = num(o.x1);
    let y1 = num(o.y1);
    if (x0 != null && y0 != null && x1 != null && y1 != null) return [x0, y0, x1, y1];

    const left = num(o.left != null ? o.left : o.x);
    const top = num(o.top != null ? o.top : o.y);
    if (left != null && top != null) {
      const w = num(o.width != null ? o.width : o.w);
      const h = num(o.height != null ? o.height : o.h);
      const r = num(o.right);
      const b = num(o.bottom);
      let rx1 = r != null ? r : w != null ? left + w : null;
      let ry1 = b != null ? b : h != null ? top + h : null;
      if (rx1 != null && ry1 != null) return [left, top, rx1, ry1];
    }
    return null;
  }

  /** 把条目里任意一种形态的框挖出来 */
  function extractBox(it) {
    if (!it || typeof it !== "object") return null;
    const cands = [];
    for (let i = 0; i < BOX_KEYS.length; i++) {
      if (it[BOX_KEYS[i]] !== undefined && it[BOX_KEYS[i]] !== null) cands.push(it[BOX_KEYS[i]]);
    }
    // 有些服务把 4 个坐标拆成平铺字段
    cands.push(it);

    for (let i = 0; i < cands.length; i++) {
      const v = cands[i];
      if (Array.isArray(v)) {
        if (v.length >= 4 && v.slice(0, 4).every(function (n) { return isFinite(Number(n)); })) {
          return [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
        }
        continue;
      }
      if (v && typeof v === "object") {
        const r = rectFromObject(v);
        if (r) return r;
      }
    }
    return null;
  }

  /**
   * 模型原始文本 → 候选条目数组（还没做坐标映射）。
   * 这一层只负责"从一堆畸形 JSON 里把数组挖出来"。
   */
  function _parseItems(raw) {
    const u = util();
    const parsed = u.extractJson(raw);
    const arr = u.coerceItems(parsed);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (!it || typeof it !== "object") continue;
      // coerceItems 有时会返回嵌套数组
      if (Array.isArray(it)) continue;

      const src = cleanText(keyText(it, SRC_KEYS));
      const dst = cleanText(keyText(it, DST_KEYS));
      let box = null;
      try {
        box = extractBox(it);
      } catch (e) {
        box = null;
      }
      out.push({ raw: it, src: src, dst: dst, box: box });
    }
    return out;
  }

  /* ============================================================
   * 合并去重
   * ============================================================ */

  function srcKey(it) {
    const s = String(it && (it.src != null ? it.src : it.text) || "");
    return util().normText(s);
  }

  /**
   * 去重：位置高度重叠（overlapRatio > 0.5）且文本相似 → 同一处文字。
   *
   * 冲突时保留「区域遍」的结果：区域遍是放大后认的，分辨率更高、更准；
   * 整图遍只负责补漏，不该覆盖更好的结果。
   * 反之，位置相近但文本不同（比如 "Front" 和 "Back"）必须都保留 ——
   * 用严格的文本相似度门槛就是为了不误删这种。
   */
  function _dedupe(items, opts) {
    const u = util();
    const o = opts || {};
    const minOverlap = o.overlap != null ? o.overlap : 0.5;
    const threshold = o.textThreshold != null ? o.textThreshold : 0.82;
    const list = (items || []).filter(function (it) {
      if (!it) return false;
      const w = Number(it.w != null ? it.w : (it.x1 - it.x0));
      const h = Number(it.h != null ? it.h : (it.y1 - it.y0));
      return isFinite(w) && isFinite(h) && w > 0 && h > 0;
    });

    // 优先保留区域遍；同一遍里先按阅读顺序（上→下、左→右），
    // 这样"重叠但文本不同"的条目不会被面积大小重排得东一条西一条。
    const ranked = list
      .map(function (it, i) { return { it: it, i: i }; })
      .sort(function (a, b) {
        const ra = a.it.source === "region" ? 0 : 1;
        const rb = b.it.source === "region" ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const ah = Math.max(1, a.it.h || 0);
        const bh = Math.max(1, b.it.h || 0);
        // 垂直方向差半行以上就当是不同行，直接比 y
        if (Math.abs(a.it.y - b.it.y) > Math.max(4, Math.min(ah, bh) * 0.6)) {
          return a.it.y - b.it.y;
        }
        if (a.it.x !== b.it.x) return a.it.x - b.it.x;
        // 同一位置的两条（同遍内的重复）：留面积大的那个，更可能是完整一行
        return (b.it.w || 0) * (b.it.h || 0) - (a.it.w || 0) * (a.it.h || 0) || a.i - b.i;
      });

    const kept = [];
    for (let i = 0; i < ranked.length; i++) {
      const cand = ranked[i].it;
      let dup = false;
      for (let j = 0; j < kept.length; j++) {
        const e = kept[j];
        if (u.overlapRatio(cand, e) <= minOverlap) continue;
        if (u.sameText(cand.src, e.src, threshold)) { dup = true; break; }
      }
      if (!dup) kept.push(cand);
    }

    // 还原成阅读顺序（先上后下、先左后右），便于人看日志、也便于排版
    kept.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > Math.max(4, Math.min(a.h, b.h) * 0.6)) return a.y - b.y;
      return a.x - b.x;
    });
    return kept;
  }

  /* ============================================================
   * 提示词（一律来自 PZConfig，本文件不允许出现领域词）
   * ============================================================ */

  function buildPrompt(kind, opts) {
    const C = config();
    const wantTranslate = opts.translate !== false;
    const promptOpts = {
      targetLang: opts.targetLang || "zh-CN",
      glossaryEntries: opts.glossaryEntries || null,
      profileHint: opts.profileHint || "",
      cropLabel: opts.cropLabel || "",
      translate: wantTranslate,
    };
    if (kind === "region") return C.buildRegionPrompt(promptOpts);
    return C.buildWholePrompt(promptOpts);
  }

  /* ============================================================
   * 编码 / 请求
   * ============================================================ */

  /**
   * 画布 → JPEG base64。
   * 注意 JPEG 没有 alpha 通道：透明区域编码后会是黑的，
   * 所以先铺一层白底再画 —— PDF 渲染出来的画布常常带透明边。
   */
  function encodeCanvas(canvas, quality) {
    const u = util();
    const W = Math.max(1, Math.round(canvas.width));
    const H = Math.max(1, Math.round(canvas.height));
    const tmp = u.createCanvas(W, H);
    const ctx = u.ctx2d(tmp);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(canvas, 0, 0);
    const dataUrl = tmp.toDataURL(JPEG_MIME, quality || JPEG_QUALITY);
    return u.base64Of(dataUrl);
  }

  /** 按协议组装请求体 */
  function buildBody(api, prompt, base64) {
    if (api === "gemini") {
      return {
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: JPEG_MIME, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      };
    }
    return {
      model: undefined, // 由 send() 填真实模型名
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_JSON },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: "data:" + JPEG_MIME + ";base64," + base64 },
            },
          ],
        },
      ],
    };
  }

  /**
   * 从响应 JSON 里把模型文本抠出来。
   *
   * Gemini：candidates[0].content.parts 里可能有多段，必须**全部拼接**。
   *   原实现只取 parts[0]，遇到模型把 JSON 拆成多个 part 时就会解析失败 —— 这个坑踩过。
   * OpenAI 兼容：choices[0].message.content 可能是字符串，也可能是
   *   [{type:"text",text:"..."}] 这种数组（不少国产兼容网关如此），还要考虑
   *   reasoning_content（思维链）不能混进来。
   */
  function extractModelText(api, json) {
    if (!json) return "";
    if (typeof json === "string") return json;

    // —— Gemini ——
    const cands = json.candidates;
    if (Array.isArray(cands) && cands.length) {
      const parts = [];
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const ps = c && c.content && c.content.parts;
        if (!Array.isArray(ps)) continue;
        for (let j = 0; j < ps.length; j++) {
          const t = ps[j] && ps[j].text;
          if (typeof t === "string") parts.push(t);
        }
      }
      if (parts.length) return parts.join("");
      // 有的代理把结果放在 promptFeedback 之类的地方，这里不猜，返回空让上层报错
    }

    // —— OpenAI 兼容 ——
    const choices = json.choices;
    if (Array.isArray(choices) && choices.length) {
      const m = choices[0].message || choices[0].delta || {};
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        const parts = [];
        for (let i = 0; i < c.length; i++) {
          const p = c[i];
          if (!p) continue;
          if (typeof p === "string") parts.push(p);
          else if (typeof p.text === "string") parts.push(p.text);
          else if (p.text && typeof p.text.value === "string") parts.push(p.text.value);
        }
        if (parts.length) return parts.join("");
      }
      if (typeof choices[0].text === "string") return choices[0].text;
    }

    // —— Anthropic 风格 ——
    if (Array.isArray(json.content)) {
      const parts = [];
      for (let i = 0; i < json.content.length; i++) {
        const p = json.content[i];
        if (p && typeof p.text === "string") parts.push(p.text);
      }
      if (parts.length) return parts.join("");
    }

    // —— 有的网关再包一层 data/result ——
    if (json.data && json.data !== json) {
      const inner = extractModelText(api, json.data);
      if (inner) return inner;
    }
    if (json.result && typeof json.result === "string") return json.result;
    return "";
  }

  function parseRetryAfter(res) {
    let hv = "";
    try {
      hv = res && res.headers && typeof res.headers.get === "function"
        ? res.headers.get("retry-after") || res.headers.get("Retry-After") || ""
        : "";
    } catch (e) {
      hv = "";
    }
    hv = String(hv).trim();
    if (!hv) return 0;
    if (/^\d+(\.\d+)?$/.test(hv)) return Math.max(0, parseFloat(hv) * 1000);
    const t = Date.parse(hv);
    if (!isNaN(t)) return Math.max(0, t - Date.now());
    return 0;
  }

  /** 429 / 5xx 才算"值得重试"的失败；401/403/404 重试多少次都是白搭 */
  function isRetryableStatus(status) {
    return status === 429 || status === 408 || (status >= 500 && status <= 599);
  }

  /** 少数网关 HTTP 状态是 200 但 body 里带限流信息，顺手认一下 */
  function isRetryablePayload(json) {
    if (!json || typeof json !== "object") return false;
    const e = json.error;
    const st = e && e.status ? String(e.status) : "";
    if (st === "RESOURCE_EXHAUSTED" || st === "UNAVAILABLE" || st === "INTERNAL") return true;
    const code = Number(json.code != null ? json.code : e && e.code);
    if (code === 429 || (code >= 500 && code <= 599)) return true;
    const msg = String((e && e.message) || json.message || "");
    if (/\b(429|rate limit|too many requests|overloaded|quota exceeded)\b/i.test(msg)) return true;
    return false;
  }

  function backoffMs(attempt, res) {
    const serverWait = parseRetryAfter(res);
    if (serverWait > 0) return Math.min(serverWait, RETRY_MAX_MS);
    const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
    // 加抖动，避免多个并发请求在同一时刻一起重试又把服务端打爆
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  /**
   * 把「外部 signal」和「单请求超时」串成一个 controller。
   * 外部中止时内部请求必须立刻断（用户点了取消还在后台发请求是很糟的体验）。
   */
  function linkSignals(signal, timeoutMs) {
    const AC = global.AbortController;
    if (typeof AC !== "function") return { signal: signal, cleanup: function () {} };

    if (typeof AbortSignal === "function" && typeof AbortSignal.any === "function") {
      const timeoutSignal = typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : null;
      if (timeoutSignal) {
        return {
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
          cleanup: function () {},
          isTimeout: function () { return timeoutSignal.aborted && !(signal && signal.aborted); },
        };
      }
    }

    const ctrl = new AC();
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      try { ctrl.abort(new Error("请求超时")); } catch (e) { ctrl.abort(); }
    }, timeoutMs);
    const onAbort = function () {
      try { ctrl.abort(signal.reason); } catch (e) { ctrl.abort(); }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      cleanup: function () {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      },
      isTimeout: function () { return timedOut; },
    };
  }

  function fetchImpl() {
    if (typeof global.fetch === "function") return global.fetch;
    throw new Error("当前环境没有 fetch，无法调用云端接口");
  }

  function errMessage(json, status) {
    if (json && typeof json === "object") {
      if (json.error && json.error.message) return String(json.error.message);
      if (json.message) return String(json.message);
      if (json.error && typeof json.error === "string") return json.error;
    }
    if (typeof json === "string" && json.trim()) return json.slice(0, 300);
    return "HTTP " + status;
  }

  /**
   * 发一次请求（带重试）。
   * 返回解析好的 JSON，并顺手把模型文本抠出来放进 `json.__text`，
   * 省得上层再判断一次协议。
   */
  async function send(opts, url, body, label) {
    const u = util();
    const api = opts.api === "gemini" ? "gemini" : "openai";
    const key = (opts.apiKey || "").trim();
    const headers = { "Content-Type": "application/json" };
    if (api === "openai" && key) headers.Authorization = "Bearer " + key;

    const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    let lastErr = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      u.throwIfAborted(opts.signal);
      const link = linkSignals(opts.signal, timeoutMs);
      let res = null;
      try {
        res = await fetchImpl()(url, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(body),
          signal: link.signal,
        });
      } catch (e) {
        link.cleanup();
        // 用户主动取消：必须原样穿透，不能被"重试"吃掉
        if (opts.signal && opts.signal.aborted) {
          throw opts.signal.reason || u.abortError();
        }
        const timedOut = link.isTimeout && link.isTimeout();
        lastErr = timedOut
          ? new Error(label + "请求超时（" + Math.round(timeoutMs / 1000) + "s）")
          : new Error(label + "网络请求失败：" + ((e && e.message) || e));
        lastErr.cause = e;
        // 退避等待期间用户也可能点取消，sleep 会抛 AbortError，正好穿透出去
        if (attempt < MAX_RETRIES) {
          await u.sleep(backoffMs(attempt, null), opts.signal);
          continue;
        }
        throw lastErr;
      }
      link.cleanup();

      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        json = null; // 有些错误页返回 HTML，读不出来就算了
      }

      if (!res.ok) {
        lastErr = new Error(
          label + "调用失败（HTTP " + res.status + "）：" + errMessage(json, res.status)
        );
        lastErr.status = res.status;
        lastErr.payload = json;
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          await u.sleep(backoffMs(attempt, res), opts.signal);
          continue;
        }
        throw lastErr;
      }

      if (!json) {
        lastErr = new Error(label + "返回了无法解析的响应体（不是 JSON）");
        if (attempt < MAX_RETRIES) {
          await u.sleep(backoffMs(attempt, res), opts.signal);
          continue;
        }
        throw lastErr;
      }

      if (isRetryablePayload(json) && attempt < MAX_RETRIES) {
        await u.sleep(backoffMs(attempt, res), opts.signal);
        continue;
      }

      json.__text = extractModelText(api, json);
      return json;
    }
    throw lastErr || new Error(label + "请求失败");
  }

  /* ============================================================
   * 一次"看图"：裁切（可选）→ 编码 → 请求 → 解析 → 映射
   * ============================================================ */

  async function recognizeCanvas(opts, canvas, prompt, cropOffset, label) {
    const u = util();
    const W = opts.imageWidth;
    const H = opts.imageHeight;
    const api = opts.api === "gemini" ? "gemini" : "openai";
    const b64 = encodeCanvas(canvas, opts.jpegQuality);
    const body = buildBody(api, prompt, b64);
    if (api === "openai") body.model = opts.model;

    const json = await send(opts, opts.endpointUrl, body, label);
    const rawText = json.__text;
    const cands = _parseItems(rawText);
    // 模型"说了话"但一条都解析不出来 → 这是解析/协议问题，不是"图里没字"。
    // 必须当失败抛出来：如果当成空结果，用户又会以为整页没内容。
    // 合法的"图里确实没字"长这样：{"items":[]} —— 这时 cands 是"空数组"而不是"没解析出数组"。
    if (!cands.length && String(rawText || "").trim() && !u.extractJson(rawText)) {
      const err = new Error(
        label + "返回的内容无法解析成 JSON（前 120 字符：" +
          String(rawText).slice(0, 120).replace(/\s+/g, " ") + "）"
      );
      err.code = "PARSE_FAILED";
      throw err;
    }
    const out = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (!looksReadable(c.src)) continue;
      const rect = _mapBoxFromCrop(c.box, cropOffset, W, H, fallbackBoxFor(W, H));
      if (!rect || rect.w <= 1 || rect.h <= 1) continue;
      out.push({
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        src: c.src,
        dst: opts.translate === false ? "" : c.dst || "",
        source: opts.passKind === "whole" ? "whole" : "region",
      });
    }
    return out;
  }

  /* ============================================================
   * 主入口
   * ============================================================ */

  function num(v, def) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : def;
  }

  function makeHooks(hooks) {
    const h = hooks || {};
    return {
      onLog: typeof h.onLog === "function" ? h.onLog : function () {},
      onProgress: typeof h.onProgress === "function" ? h.onProgress : function () {},
    };
  }

  /**
   * 包一层 PZUtil.pool：
   * pool 是 failFast 的 —— 一旦有 worker 抛 AbortError，Promise.all 立刻拒绝，
   * 但其他并发 worker 可能还在跑（取消了也是要等它们自己停下来的）。
   * 这些"后到的"拒绝没人接就会变成 UnhandledPromiseRejection，
   * 所以这里在 pool 返回的 Promise 上挂一个 catch 把它们全收干净，
   * 再按中止与否决定是抛出去还是照常返回结果数组。
   */
  async function poolAll(u, items, worker, poolOpts) {
    let rejected = null;
    let result = null;
    await u
      .pool(items, worker, poolOpts)
      .then(function (r) {
        result = r;
      })
      .catch(function (err) {
        // 收尾用：这里的错误只用来判断"是不是被取消了"，真正的错误下面再抛
        rejected = err;
      });
    if (rejected) throw rejected;
    return result;
  }

  /**
   * 统一加工"失败"错误：补上人话前缀与统计字段，方便上层直接显示。
   * 之所以要包一层而不是就地改 message：原始错误里的 HTTP 状态/服务端原文
   * 是最有价值的诊断信息，必须留在末尾而不是被覆盖掉。
   */
  function decorateFailure(err, prefix, failedCount, partial) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.message = prefix + e.message;
    e.failed = failedCount;
    if (partial) e.partial = true;
    return e;
  }

  /**
   * 有没有任何一遍真的认出了文字。
   *
   * 这里必须同时兼容两种形态：
   *   - 扁平的条目数组（区域遍合并进来之后的形态）
   *   - 嵌套的数组（每个区域的结果各占一个元素）
   * 踩过的坑：只判 `items[i].length` 时，扁平数组里每个条目都没有 length，
   * 于是"明明认出了字"也会被判成空，进而误报"结果不可信"。
   */
  function hasAnyItem(items) {
    if (!items) return false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (Array.isArray(it)) {
        if (it.length) return true;
      } else if (typeof it === "object") {
        return true; // 扁平形态：只要有一个合法条目就算有
      }
    }
    return false;
  }

  /**
   * 两遍识别 + 合并去重。
   *
   * 第一遍（区域遍）负责精度，第二遍（整图遍）负责召回。
   * 只做第一遍就会漏字（检测算法本身会漏），只做第二遍小字又认不准 ——
   * 两遍都做、再合并去重，才是这个工具在"小字漏识别"这个痛点上该有的样子。
   */
  async function translate(canvas, opts, hooks) {
    const u = util();
    const h = makeHooks(hooks);
    const o = opts || {};
    const L = limits(o);
    const signal = o.signal;
    u.throwIfAborted(signal);

    if (!canvas || !canvas.width || !canvas.height) {
      throw new Error("PZVision.translate：没有可用的画布");
    }

    const api = o.api === "gemini" ? "gemini" : "openai";
    const apiKey = String(o.apiKey || "").trim();
    if (!apiKey) throw new Error("未配置 API Key，无法调用云端识别");

    const W = Math.round(canvas.width);
    const H = Math.round(canvas.height);
    const model = normalizeModel(o.model, api);
    const endpointUrl = resolveEndpoint(_endpoint(o.baseUrl, "chat", api), model, api, apiKey);

    const started = Date.now();
    const stats = {
      regions: 0,
      requests: 0,
      failed: 0,
      merged: 0,
      whole: false,
      dropped: 0,
      errors: [],
      ms: 0,
    };

    const base = {
      api: api,
      apiKey: apiKey,
      model: model,
      endpointUrl: endpointUrl,
      signal: signal,
      targetLang: o.targetLang || "zh-CN",
      glossaryEntries: o.glossaryEntries || null,
      profileHint: String(o.profileHint || ""),
      translate: o.translate !== false,
      jpegQuality: num(o.jpegQuality, JPEG_QUALITY),
      timeoutMs: num(o.timeoutMs, REQUEST_TIMEOUT_MS),
      imageWidth: W,
      imageHeight: H,
    };
    // 超时严格上限：再长也没意义，用户早点了取消
    if (base.timeoutMs > 300000) base.timeoutMs = 300000;

    h.onLog(
      "云端识别：" + api + " / " + model + "（" + W + "×" + H + "px）"
    );

    /* ---------- 规划区域 ---------- */
    let regions = [];
    if (Array.isArray(o.regions)) regions = o.regions.slice();
    else if (o.detected && Array.isArray(o.detected.regions)) regions = o.detected.regions.slice();
    else if (global.PZDetect && typeof global.PZDetect.detect === "function") {
      // 没传区域就自己检测一遍，省得调用方什么都要管
      try {
        h.onLog("未提供区域，先做一次文字区域检测");
        const det = global.PZDetect.detect(canvas, { maxSide: L.detectMaxSide });
        regions = (det && det.regions) || [];
      } catch (e) {
        h.onLog("区域检测失败（将只做整图兜底）：" + ((e && e.message) || e));
        regions = [];
      }
    }

    // 大区域优先：一个区域能覆盖更多字，性价比更高
    regions = regions
      .filter(function (r) {
        const t = u.toRect(r);
        return t.w >= 8 && t.h >= 6;
      })
      .sort(function (a, b) {
        const A = u.toRect(a);
        const B = u.toRect(b);
        return B.w * B.h - A.w * A.h;
      });

    const maxRegions = Math.max(0, Math.round(num(o.maxRegions, L.visionMaxRegions || 24)));
    if (regions.length > maxRegions) {
      h.onLog("区域数 " + regions.length + " 超过上限，按面积保留前 " + maxRegions + " 个");
      regions = regions.slice(0, maxRegions);
    }
    stats.regions = regions.length;

    const wantWhole = o.wholeImage !== false && L.visionImageMaxSide !== 0;
    const concurrency = Math.max(1, Math.round(num(o.concurrency, L.visionConcurrency || 4)));
    const total = regions.length + (wantWhole ? 1 : 0);

    if (!total) {
      throw new Error("没有可识别的区域，也没有开启整图兜底 —— 无内容可送模型");
    }

    h.onProgress({
      phase: "vision-region",
      done: 0,
      total: total,
      message: "准备识别 " + regions.length + " 个区域",
    });

    /* ---------- 第一遍：区域放大识别 ---------- */
    const failures = [];
    let doneCount = 0;
    const regionPromptOf = function (idx) {
      return buildPrompt("region", Object.assign({}, base, { cropLabel: String(idx + 1) }));
    };

    const poolOpts = {
      concurrency: concurrency,
      signal: signal,
      onError: function (err, region, idx) {
        stats.failed++;
        failures.push(err);
        const msg = "区域#" + (idx + 1) + " 识别失败：" + ((err && err.message) || err);
        stats.errors.push(msg);
        h.onLog(msg);
      },
      onProgress: function (done, totalTasks) {
        doneCount = done;
        h.onProgress({
          phase: "vision-region",
          done: done,
          total: total,
          message: "区域识别 " + done + "/" + totalTasks,
        });
      },
    };

    const regionItems = await poolAll(
      u,
      regions,
      async function (region, idx) {
        const plan = _cropForRegion(region, W, H, o);
        const crop = u.cropCanvas(canvas, region, { pad: plan.pad, scale: plan.scale });
        const prompt = regionPromptOf(idx);
        stats.requests++;
        // 单个区域失败不抛出去：由 pool 的 onError 收集，进来时已由 pool 兜住
        return await recognizeCanvas(
          Object.assign({}, base, { passKind: "region" }),
          crop,
          prompt,
          crop._cropOffset,
          "区域#" + (idx + 1) + " "
        );
      },
      poolOpts
    );

    let items = [];
    for (let i = 0; i < regionItems.length; i++) {
      if (regionItems[i]) items = items.concat(regionItems[i]);
    }

    // 全部区域都失败 → 大声抛错。
    // 静默返回空数组是最坏的结果：用户会以为是图里没字，而不是"这次调用挂了"。
    // 注意：这一步放在整图兜底【之后】统一判 —— 只要还有一遍没跑，
    // 就不能提前认定"没救了"（整图兜底本身就有可能是唯一的活路）。
    if (regions.length > 0 && stats.failed >= regions.length && failures.length) {
      throw decorateFailure(
        failures[failures.length - 1],
        "所有区域识别都失败了（共 " + regions.length + " 个），最后一次错误：",
        stats.failed,
        false
      );
    }

    /* ---------- 第二遍：整图兜底 ---------- */
    if (wantWhole) {
      const maxSide = L.visionImageMaxSide || 1800;
      const long = Math.max(W, H);
      const f = long > maxSide ? maxSide / long : 1;
      const pw = Math.max(8, Math.round(W * f));
      const ph = Math.max(8, Math.round(H * f));
      h.onProgress({
        phase: "vision-whole",
        done: doneCount,
        total: total,
        message: "整图兜底识别",
      });
      try {
        const whole = u.createCanvas(pw, ph);
        const wctx = u.ctx2d(whole);
        wctx.imageSmoothingEnabled = true;
        wctx.imageSmoothingQuality = "high";
        wctx.drawImage(canvas, 0, 0, pw, ph);
        stats.requests++;
        const wholeItems = await recognizeCanvas(
          Object.assign({}, base, { passKind: "whole" }),
          whole,
          buildPrompt("whole", base),
          { x: 0, y: 0, scale: f, srcW: W, srcH: H },
          "整图 "
        );
        items = items.concat(wholeItems);
        stats.whole = true;
        h.onLog("整图兜底识别到 " + wholeItems.length + " 条");
      } catch (err) {
        if (u.isAbortError(err)) throw err;
        // 整图兜底失败不致命（区域遍的结果还在），但必须报出来，不能悄悄吞掉
        stats.failed++;
        // 一定要记进 failures：下面的"零结果判定"要靠它，
        // 漏记就会出现"请求失败 + 0 条结果"却静默返回空数组的情况。
        failures.push(err);
        const msg = "整图兜底识别失败：" + ((err && err.message) || err);
        stats.errors.push(msg);
        h.onLog(msg);
      }
    }

    /* ---------- 失败判定（必须在两遍都跑完之后） ---------- */
    // 铁律：只要有请求失败，而整体又是一条文字都没认出来，就绝不能静默返回空数组。
    // 用户看到"0 条"会以为图里是空的，从而漏掉整页内容 —— 这比明确报错糟糕得多。
    if (stats.failed > 0 && !hasAnyItem(items) && failures.length) {
      throw decorateFailure(
        failures[failures.length - 1],
        "有 " + stats.failed + " 次请求失败，且没有任何一次识别到文字 —— " +
          "结果不可信（失败的那几次里很可能正有内容），请重试。最后一次错误：",
        stats.failed,
        true
      );
    }

    /* ---------- 合并去重 ---------- */
    const before = items.length;
    const merged = _dedupe(items);
    stats.merged = before;
    stats.dropped = Math.max(0, before - merged.length);
    stats.ms = Date.now() - started;

    stats.lines = merged.length;
    h.onProgress({
      phase: "vision-done",
      done: total,
      total: total,
      message:
        "识别完成：" + merged.length + " 条（去重 " + stats.dropped + " 条，" +
        u.fmtDuration(stats.ms) + "）",
    });
    h.onLog(
      "请求 " + stats.requests + " 次，失败 " + stats.failed + " 次，输出 " + merged.length + " 条"
    );

    return { items: merged, stats: stats };
  }

  /* ============================================================
   * 连通性 / 模型列表
   * ============================================================ */

  /** 用一次极小的纯文本请求验证 Key、端点、模型名是否都对 */
  async function testKey(opts) {
    const u = util();
    const o = opts || {};
    const api = o.api === "gemini" ? "gemini" : "openai";
    const apiKey = String(o.apiKey || "").trim();
    if (!apiKey) throw new Error("未填写 API Key");
    const model = normalizeModel(o.model, api);
    const endpoint = resolveEndpoint(_endpoint(o.baseUrl, "chat", api), model, api, apiKey);
    const started = Date.now();

    let body;
    if (api === "gemini") {
      body = {
        contents: [{ parts: [{ text: "ping" }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      };
    } else {
      body = {
        model: model,
        temperature: 0,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      };
    }

    const json = await send(
      {
        api: api,
        apiKey: apiKey,
        signal: o.signal,
        timeoutMs: num(o.timeoutMs, 30000),
      },
      endpoint,
      body,
      "连通性测试 "
    );
    const echo = cleanText(json.__text || "").slice(0, 40);
    return {
      ok: true,
      model: model,
      endpoint: endpoint,
      latencyMs: Date.now() - started,
      echo: echo,
    };
  }

  /** 拉模型列表。Gemini 与 OpenAI 兼容的响应结构不一样，都要认 */
  async function listModels(opts) {
    const u = util();
    const o = opts || {};
    const api = o.api === "gemini" ? "gemini" : "openai";
    const apiKey = String(o.apiKey || "").trim();
    if (!apiKey) throw new Error("未填写 API Key");
    const endpoint = resolveEndpoint(_endpoint(o.baseUrl, "models", api), "", api, apiKey);

    const headers = {};
    if (api === "openai") headers.Authorization = "Bearer " + apiKey;
    const res = await fetchImpl()(endpoint, {
      method: "GET",
      headers: headers,
      signal: o.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    if (!res.ok) {
      const err = new Error(
        "拉取模型列表失败（HTTP " + res.status + "）：" + errMessage(json, res.status)
      );
      err.status = res.status;
      throw err;
    }

    const arr = (json && (json.data || json.models)) || [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      const id = textOf(typeof m === "string" ? m : m && (m.id || m.name));
      if (!id) continue;
      // Gemini 的模型名是 "models/gemini-2.5-flash"
      const clean = id.replace(/^models\//, "");
      // 只保留支持 generateContent 的（Gemini 会混进 embedding 模型）
      if (api === "gemini" && m && Array.isArray(m.supportedGenerationMethods)) {
        if (m.supportedGenerationMethods.indexOf("generateContent") < 0) continue;
      }
      if (out.indexOf(clean) < 0) out.push(clean);
    }
    return out;
  }

  global.PZVision = {
    translate: translate,
    testKey: testKey,
    listModels: listModels,
    // —— 纯逻辑（供单测）——
    _endpoint: _endpoint,
    _mapBoxFromCrop: _mapBoxFromCrop,
    _parseItems: _parseItems,
    _dedupe: _dedupe,
    _cropForRegion: _cropForRegion,
    // —— 辅助（也一并导出，便于以后排查）——
    _normalizeModel: normalizeModel,
    _normalizeBaseUrl: normalizeBaseUrl,
    _extractModelText: extractModelText,
    _normalizeBox1000: normalizeBox1000,
    _cleanText: cleanText,
    _encodeCanvas: encodeCanvas,
    _buildPrompt: buildPrompt,
    _limits: limits,
    JPEG_QUALITY: JPEG_QUALITY,
  };
})(typeof window !== "undefined" ? window : globalThis);
