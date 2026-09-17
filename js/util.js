/**
 * PZUtil — 通用工具层
 * 几何 / 文本比对 / 并发 / 画布 / 大模型输出解析
 *
 * 经典脚本（非 ES module），挂到 window.PZUtil。
 * 在 Node 下挂到 globalThis，方便直接对纯函数做单元测试。
 */
(function (global) {
  "use strict";

  /* ============================================================
   * 画布工厂（可在无 DOM 环境注入，便于测试）
   * ============================================================ */

  let canvasFactory = function (w, h) {
    if (typeof document === "undefined") {
      throw new Error("当前环境没有 document，请先调用 PZUtil.setCanvasFactory 注入");
    }
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w || 1));
    c.height = Math.max(1, Math.round(h || 1));
    return c;
  };

  function setCanvasFactory(fn) {
    if (typeof fn === "function") canvasFactory = fn;
  }

  function createCanvas(w, h) {
    return canvasFactory(w, h);
  }

  function ctx2d(canvas, opts) {
    return canvas.getContext("2d", opts || { willReadFrequently: true });
  }

  /** 构造与 ImageData 同形状的纯对象（测试用，不需要 DOM） */
  function imageLike(w, h, fill) {
    const data = new Uint8ClampedArray(Math.max(0, w * h * 4));
    if (fill) data.fill(fill);
    return { width: w, height: h, data: data };
  }

  /* ============================================================
   * 数值 / 几何
   * ============================================================ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function round(v) {
    return Math.round(v);
  }

  function boxW(b) {
    return Math.max(0, b.x1 - b.x0);
  }

  function boxH(b) {
    return Math.max(0, b.y1 - b.y0);
  }

  function boxArea(b) {
    return boxW(b) * boxH(b);
  }

  function toBox(b) {
    // 统一成 {x0,y0,x1,y1}
    if (b == null) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    if (typeof b.x0 === "number") {
      return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    }
    return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
  }

  /** {x,y,w,h} → {x0,y0,x1,y1} 就地风格 */
  function toRect(b) {
    if (b == null) return { x: 0, y: 0, w: 0, h: 0 };
    if (typeof b.x === "number") return { x: b.x, y: b.y, w: b.w, h: b.h };
    return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  }

  function unionBox(a, b) {
    const A = toBox(a);
    const B = toBox(b);
    return {
      x0: Math.min(A.x0, B.x0),
      y0: Math.min(A.y0, B.y0),
      x1: Math.max(A.x1, B.x1),
      y1: Math.max(A.y1, B.y1),
    };
  }

  function expandBox(b, pad, W, H) {
    const r = toRect(b);
    let x0 = r.x - pad;
    let y0 = r.y - pad;
    let x1 = r.x + r.w + pad;
    let y1 = r.y + r.h + pad;
    if (typeof W === "number") {
      x0 = Math.max(0, x0);
      x1 = Math.min(W, x1);
    }
    if (typeof H === "number") {
      y0 = Math.max(0, y0);
      y1 = Math.min(H, y1);
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function boxesIntersect(a, b) {
    const A = toBox(a);
    const B = toBox(b);
    return !(A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0);
  }

  function intersectArea(a, b) {
    const A = toBox(a);
    const B = toBox(b);
    const w = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    const h = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /** 交并比 */
  function iou(a, b) {
    const inter = intersectArea(a, b);
    if (!inter) return 0;
    const total = boxArea(toBox(a)) + boxArea(toBox(b)) - inter;
    return total > 0 ? inter / total : 0;
  }

  /** 较小框被覆盖的比例 —— 比 iou 更适合判断"同一行文字被重复识别" */
  function overlapRatio(a, b) {
    const inter = intersectArea(a, b);
    if (!inter) return 0;
    const minArea = Math.min(boxArea(toBox(a)), boxArea(toBox(b)));
    return minArea > 0 ? inter / minArea : 0;
  }

  function boxCenter(b) {
    const r = toRect(b);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function containsPoint(b, x, y) {
    const A = toBox(b);
    return x >= A.x0 && x <= A.x1 && y >= A.y0 && y <= A.y1;
  }

  /**
   * 把若干框按"是否属于同一视觉行"聚成块。
   * 用于把检测出来的一行行文字合并成更少的区域，减少云端请求数。
   * 纯函数，可单测。
   */
  function groupBoxesIntoBlocks(boxes, opts) {
    opts = opts || {};
    const vGap = opts.vGap || 14; // 垂直间距阈值（像素）
    const hGap = opts.hGap || 40; // 水平间距阈值
    const alignTol = opts.alignTol || 0.35; // 左边缘对齐容差（按高度比例）
    const items = boxes
      .map(function (b, i) {
        const r = toRect(b);
        return { i: i, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, h: r.h, raw: b };
      })
      .filter(function (b) {
        return b.x1 > b.x0 && b.y1 > b.y0;
      });

    items.sort(function (a, b) {
      if (Math.abs(a.y0 - b.y0) > Math.max(a.h, b.h) * 0.6) return a.y0 - b.y0;
      return a.x0 - b.x0;
    });

    const used = new Array(items.length).fill(false);
    const blocks = [];

    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const members = [items[i]];
      let x0 = items[i].x0;
      let y0 = items[i].y0;
      let x1 = items[i].x1;
      let y1 = items[i].y1;

      let grew = true;
      let guard = 0;
      while (grew && guard < 40) {
        grew = false;
        guard++;
        for (let j = 0; j < items.length; j++) {
          if (used[j]) continue;
          const b = items[j];
          const gapY = Math.max(0, Math.max(y0 - b.y1, b.y0 - y1));
          const gapX = Math.max(0, Math.max(x0 - b.x1, b.x0 - x1));
          const overlapX = Math.min(x1, b.x1) - Math.max(x0, b.x0);
          const overlapY = Math.min(y1, b.y1) - Math.max(y0, b.y0);
          const lineH = Math.max(1, Math.min(y1 - y0, b.h));

          // 同一行：垂直重叠明显 + 水平靠近
          const sameRow = overlapY > lineH * 0.5 && gapX <= hGap;
          // 同列堆叠：水平重叠明显 + 垂直靠近 + 左边缘大致对齐
          const sameColumn =
            overlapX > -alignTol * lineH &&
            gapY <= vGap &&
            Math.abs(b.x0 - x0) < Math.max(alignTol * lineH * 4, 60);

          if (sameRow || sameColumn) {
            used[j] = true;
            members.push(b);
            x0 = Math.min(x0, b.x0);
            y0 = Math.min(y0, b.y0);
            x1 = Math.max(x1, b.x1);
            y1 = Math.max(y1, b.y1);
            grew = true;
          }
        }
      }

      blocks.push({
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
        members: members.map(function (m) {
          return m.raw;
        }),
        count: members.length,
      });
    }

    return blocks;
  }

  /* ============================================================
   * 文本比对
   * ============================================================ */

  /** 归一化：转小写、压缩空白、去掉首尾标点，用于去重比较 */
  function normText(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const n = a.length;
    const m = b.length;
    if (!n) return m;
    if (!m) return n;
    let prev = new Array(m + 1);
    let cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
    return prev[m];
  }

  /** 0..1 相似度（基于归一化编辑距离） */
  function similarity(a, b) {
    const x = normText(a);
    const y = normText(b);
    if (!x && !y) return 1;
    if (!x || !y) return 0;
    if (x === y) return 1;
    const d = levenshtein(x, y);
    return 1 - d / Math.max(x.length, y.length);
  }

  /** 判断两段文字是否是"同一处的重复识别" */
  function sameText(a, b, threshold) {
    const t = typeof threshold === "number" ? threshold : 0.82;
    const x = normText(a);
    const y = normText(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) {
      const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
      if (ratio >= 0.6) return true;
    }
    return similarity(x, y) >= t;
  }

  function splitLines(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
  }

  /* ============================================================
   * 大模型输出 → JSON
   * ============================================================ */

  function stripFences(text) {
    let s = String(text || "").trim();
    // ```json ... ``` / ``` ... ```
    const fence = s.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
    if (fence && fence[1]) s = fence[1].trim();
    return s;
  }

  /**
   * 从任意位置起找第一个括号平衡的 JSON 片段。
   * 正确处理字符串与转义，避免被文本里的 "[" "]" 干扰。
   */
  function balancedSlice(text, startIdx) {
    const open = text[startIdx];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          void close;
          return text.slice(startIdx, i + 1);
        }
      }
    }
    return null;
  }

  /**
   * 给没有引号的键名补上引号：{items:[{text:"a"}]} → {"items":[{"text":"a"}]}
   * 模型（和小型开源模型尤其）经常吐这种 JS 字面量风格的 JSON。
   * 两个分支：紧跟 { 或 , 的键名、以及数组里 【{...} 之间】的键名。
   */
  function quoteBareKeys(s) {
    return String(s)
      .replace(/([{,]\s*)([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)(\s*:)/g, '$1"$2"$3')
      .replace(/(\[\s*)([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)(\s*:)/g, '$1"$2"$3');
  }

  /** 常见小毛病的容错修复 */
  function repairJson(s) {
    // 顺序很重要：先去尾逗号，再补键名引号。
    // 反过来的话，`{a:1,}` 里的 `,}` 会先被补成 `,"}":` 这种鬼东西。
    let out = String(s)
      // 对象/数组尾逗号
      .replace(/,\s*([}\]])/g, "$1")
      // Python 系字面量
      .replace(/\bNone\b/g, "null")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNaN\b/g, "null")
      .replace(/\bInfinity\b/g, "null");
    return quoteBareKeys(out);
  }

  /**
   * 从模型输出里尽力抽出 JSON。成功返回解析结果，失败返回 null。
   */
  function extractJson(raw) {
    if (raw == null) return null;
    if (typeof raw === "object") return raw;
    let s = stripFences(raw);
    if (!s) return null;

    try {
      return JSON.parse(s);
    } catch (e) {
      /* 继续尝试 */
    }

    // 找到最早出现的 { 或 [
    const iObj = s.indexOf("{");
    const iArr = s.indexOf("[");
    let start = -1;
    if (iObj < 0) start = iArr;
    else if (iArr < 0) start = iObj;
    else start = Math.min(iObj, iArr);
    if (start < 0) return null;

    const slice = balancedSlice(s, start);
    if (!slice) return null;
    try {
      return JSON.parse(slice);
    } catch (e) {
      /* 尝试修复 */
    }
    try {
      return JSON.parse(repairJson(slice));
    } catch (e) {
      return null;
    }
  }

  /**
   * 把模型返回的任意形状规整成条目数组。
   * 支持：[...] / {items:[...]} / {data:[...]} / {results:[...]} / 单个对象
   */
  function coerceItems(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== "object") return [];
    const keys = ["items", "data", "results", "list", "lines", "entries", "translations"];
    for (let i = 0; i < keys.length; i++) {
      if (Array.isArray(parsed[keys[i]])) return parsed[keys[i]];
    }
    // 兜底：第一个数组型属性
    const props = Object.keys(parsed);
    for (let i = 0; i < props.length; i++) {
      if (Array.isArray(parsed[props[i]])) return parsed[props[i]];
    }
    // 单个条目对象
    if (typeof parsed.text === "string" || typeof parsed.translation === "string") {
      return [parsed];
    }
    return [];
  }

  /* ============================================================
   * 中止 / 并发
   * ============================================================ */

  function abortError(message) {
    if (typeof DOMException === "function") {
      return new DOMException(message || "已取消", "AbortError");
    }
    const e = new Error(message || "已取消");
    e.name = "AbortError";
    return e;
  }

  function isAbortError(err) {
    return !!err && (err.name === "AbortError" || err.code === 20);
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw signal.reason || abortError();
    }
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(signal.reason || abortError());
        return;
      }
      const timer = setTimeout(function () {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(signal.reason || abortError());
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 并发池：按顺序返回结果，支持中止与进度回调。
   * worker(item, index) 抛错时该位置为 null（可用 onError 决定是否整体失败）。
   */
  async function pool(items, worker, opts) {
    opts = opts || {};
    const limit = Math.max(1, Math.min(opts.concurrency || 4, items.length || 1));
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;

    async function run() {
      while (true) {
        throwIfAborted(opts.signal);
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (opts.onError) opts.onError(err, items[i], i);
          results[i] = null;
          if (opts.failFast) throw err;
        }
        done++;
        if (opts.onProgress) opts.onProgress(done, items.length);
      }
    }

    const runners = [];
    for (let k = 0; k < limit; k++) runners.push(run());
    await Promise.all(runners);
    return results;
  }

  /* ============================================================
   * 画布辅助
   * ============================================================ */

  function cloneCanvas(src) {
    const c = createCanvas(src.width, src.height);
    ctx2d(c).drawImage(src, 0, 0);
    return c;
  }

  /**
   * 从源画布裁一块，可选缩放（用于把区域放大后再交给识别引擎）。
   */
  function cropCanvas(src, box, opts) {
    opts = opts || {};
    const r = toRect(box);
    const x0 = clamp(Math.floor(r.x - (opts.pad || 0)), 0, src.width);
    const y0 = clamp(Math.floor(r.y - (opts.pad || 0)), 0, src.height);
    const x1 = clamp(Math.ceil(r.x + r.w + (opts.pad || 0)), 0, src.width);
    const y1 = clamp(Math.ceil(r.y + r.h + (opts.pad || 0)), 0, src.height);
    const sw = Math.max(1, x1 - x0);
    const sh = Math.max(1, y1 - y0);
    const scale = opts.scale || 1;
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const c = createCanvas(dw, dh);
    const ctx = ctx2d(c);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, x0, y0, sw, sh, 0, 0, dw, dh);
    c._cropOffset = { x: x0, y: y0, scale: scale, srcW: sw, srcH: sh };
    return c;
  }

  function canvasToDataUrl(canvas, mime, quality) {
    return canvas.toDataURL(mime || "image/png", quality);
  }

  function base64Of(dataUrl) {
    const i = String(dataUrl).indexOf(",");
    return i >= 0 ? String(dataUrl).slice(i + 1) : String(dataUrl);
  }

  function uid(prefix) {
    return (prefix || "id") + "-" + Math.random().toString(36).slice(2, 9);
  }

  /** 格式化的耗时显示 */
  function fmtDuration(ms) {
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return m + "m" + s + "s";
  }

  global.PZUtil = {
    // 画布工厂
    setCanvasFactory: setCanvasFactory,
    createCanvas: createCanvas,
    ctx2d: ctx2d,
    imageLike: imageLike,
    // 数值几何
    clamp: clamp,
    round: round,
    toBox: toBox,
    toRect: toRect,
    boxArea: boxArea,
    boxW: boxW,
    boxH: boxH,
    unionBox: unionBox,
    expandBox: expandBox,
    boxesIntersect: boxesIntersect,
    intersectArea: intersectArea,
    iou: iou,
    overlapRatio: overlapRatio,
    boxCenter: boxCenter,
    containsPoint: containsPoint,
    groupBoxesIntoBlocks: groupBoxesIntoBlocks,
    // 文本
    normText: normText,
    similarity: similarity,
    sameText: sameText,
    levenshtein: levenshtein,
    splitLines: splitLines,
    // JSON
    extractJson: extractJson,
    coerceItems: coerceItems,
    repairJson: repairJson,
    stripFences: stripFences,
    // 异步
    abortError: abortError,
    isAbortError: isAbortError,
    throwIfAborted: throwIfAborted,
    sleep: sleep,
    pool: pool,
    // 画布
    cloneCanvas: cloneCanvas,
    cropCanvas: cropCanvas,
    canvasToDataUrl: canvasToDataUrl,
    base64Of: base64Of,
    uid: uid,
    fmtDuration: fmtDuration,
  };
})(typeof window !== "undefined" ? window : globalThis);
