/**
 * PZOcr — 本地 Tesseract OCR
 *
 * 与原实现的区别（都是针对"小字识别不准"这个痛点）：
 *
 * 1. **不再自己用 Tesseract 做全图多尺度探测**。原实现是「3 次全图 OCR 探测 →
 *    64 个区域各 1 次 → 1 次救援」，最多 68 次串行调用。现在检测交给 PZDetect
 *    （纯像素算法，几十毫秒），Tesseract 只负责"认字"这一件事。
 *
 * 2. **条带按行高分组，各自决定放大倍数**。原实现对所有区域用同一个放大区间，
 *    结果是"小字放大不够、大字放大过头"。这里按检测到的行高反推：
 *    放大后字高要接近 32px（Tesseract 的舒适区），所以 8px 的小字放大 4 倍，
 *    24px 的字放大 1.3 倍。这才是"把糊掉的小字放大到能认"的正确做法。
 *
 * 3. **多 worker 并行**。原实现单 worker 串行，再多的调用也得排队。
 *
 * 4. **结果解析同时兼容 Tesseract v4 和 v5 的输出结构**。v5 把
 *    `data.lines` / `data.words` 挪到了 `data.blocks[].paragraphs[].lines[]` 下面，
 *    直接读 `data.words` 会拿到 undefined 然后静默返回空结果 —— 图里明明有字，
 *    程序却认为没字。这里优先解析 TSV（结构最稳定、v4/v5 一致），
 *    解析不到再遍历对象树兜底。
 */
(function (global) {
  "use strict";

  const U = global.PZUtil;
  if (!U) throw new Error("PZOcr 依赖 PZUtil，请先加载 js/util.js");

  const OCR_LANG = "eng";

  // 放大后希望字高落在这个区间。Tesseract 的 LSTM 在 30~40px 字高上表现最好，
  // 太小认不出，太大反而变慢且不涨准确率。
  const TARGET_GLYPH_HEIGHT = 32;

  let scheduler = null;
  let workerCount = 0;
  let initPromise = null;

  /* ============================================================
   * Tesseract 生命周期
   * ============================================================ */

  function ensureTesseract() {
    if (!global.Tesseract || typeof global.Tesseract.createWorker !== "function") {
      throw new Error(
        "Tesseract.js 未加载。请检查网络（首次使用需要从 CDN 下载 OCR 引擎与语言数据），" +
          "或改用云端视觉模型识别。"
      );
    }
  }

  /**
   * 建立 worker 池。Tesseract 的 worker 创建很贵（要下载 wasm 和语言数据），
   * 所以整个会话只建一次，之后跨图片复用。
   */
  async function ensureScheduler(count, hooks) {
    ensureTesseract();
    const want = Math.max(1, Math.min(count || 3, 8));

    if (scheduler && workerCount >= want) return scheduler;
    if (initPromise) {
      await initPromise;
      if (scheduler && workerCount >= want) return scheduler;
    }

    initPromise = (async function () {
      // 已经有池子但不够大：补几个 worker，比全部重建便宜得多
      if (scheduler) {
        for (let i = workerCount; i < want; i++) {
          scheduler.addWorker(await makeWorker(hooks));
          workerCount++;
        }
        return;
      }

      if (typeof global.Tesseract.createScheduler !== "function") {
        throw new Error("当前 Tesseract.js 版本不支持 createScheduler，无法并行识别");
      }
      const s = global.Tesseract.createScheduler();
      for (let i = 0; i < want; i++) {
        s.addWorker(await makeWorker(hooks));
      }
      scheduler = s;
      workerCount = want;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
    return scheduler;
  }

  async function makeWorker(hooks) {
    const worker = await global.Tesseract.createWorker(OCR_LANG, 1, {
      logger: function (m) {
        if (hooks && hooks.onLog && m && m.status) {
          hooks.onLog(m.status + (m.progress != null ? " " + Math.round(m.progress * 100) + "%" : ""));
        }
      },
    });
    try {
      await worker.setParameters({
        // PSM 11 = 稀疏文本。规格表上标签零散分布、不时有表格分栏，
        // 稀疏模式比"整块文本"模式稳。原实现也是这么选的。
        tessedit_pageseg_mode: "11",
        // 这里**故意不设 tessedit_char_whitelist**：LSTM 引擎在白名单约束下
        // 会把噪声强行映射成白名单里的字符，产生"看起来像单词的垃圾"，
        // 比直接让它输出乱码更难过滤。垃圾在识别后的过滤阶段处理更可靠。
      });
    } catch (e) {
      /* 老版本可能不支持 setParameters，忽略 */
    }
    return worker;
  }

  async function terminate() {
    if (scheduler) {
      try {
        await scheduler.terminate();
      } catch (e) {
        /* 忽略 */
      }
    }
    scheduler = null;
    workerCount = 0;
    initPromise = null;
  }

  /* ============================================================
   * 结果解析
   * ============================================================ */

  /**
   * 解析 Tesseract 的 TSV 输出。
   *
   * TSV 每行是：
   *   level page block par line word left top width height conf text
   * level 4 = 行，level 5 = 词。结构在 v4/v5 之间稳定，是最可靠的取数方式。
   */
  function parseTsv(tsv) {
    const lines = [];
    if (!tsv || typeof tsv !== "string") return lines;

    const rows = tsv.split(/\r?\n/);
    const byLine = new Map();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const cols = row.split("\t");
      if (cols.length < 12) continue;
      const level = Number(cols[0]);
      if (level !== 4 && level !== 5) continue;

      const left = Number(cols[6]);
      const top = Number(cols[7]);
      const width = Number(cols[8]);
      const height = Number(cols[9]);
      const conf = Number(cols[10]);
      const text = cols.slice(11).join("\t");

      if (!(width > 0) || !(height > 0)) continue;

      if (level === 4) {
        const key = cols[1] + ":" + cols[2] + ":" + cols[3] + ":" + cols[4];
        byLine.set(key, {
          x: left,
          y: top,
          w: width,
          h: height,
          text: text || "",
          conf: conf,
          words: [],
        });
      } else {
        const key = cols[1] + ":" + cols[2] + ":" + cols[3] + ":" + cols[4];
        let entry = byLine.get(key);
        if (!entry) {
          entry = { x: left, y: top, w: width, h: height, text: "", conf: conf, words: [] };
          byLine.set(key, entry);
        }
        entry.words.push({ text: text || "", conf: conf, x: left, y: top, w: width, h: height });
      }
    }

    byLine.forEach(function (entry) {
      // 行文本优先用词拼接（v4/v5 对 line 级 text 的填充行为不一致）
      let text = entry.text;
      if (entry.words.length) {
        text = entry.words
          .map(function (w) {
            return w.text;
          })
          .join(" ");
      }
      text = String(text || "").replace(/\s+/g, " ").trim();
      if (!text) return;

      // 行级置信度必须从词级算出来。
      //
      // TSV 里 level=4（行）那一行的 conf 字段**恒为 -1** —— Tesseract 不填它，
      // 真实置信度只在 level=5（词）上。早先直接取 level=4 的 conf，
      // 结果是每一行的 conf 都是 -1，然后被 looksLikeNoise 的
      // "conf < 35 判为垃圾" 规则**全部丢掉**，本地 OCR 在真实素材上恒返回 0 行。
      // 这个 bug 只有拿真实图片跑端到端才会暴露：单看 parseTsv 的条数是对的。
      if (entry.words.length) {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < entry.words.length; i++) {
          const c = entry.words[i].conf;
          if (typeof c === "number" && c >= 0) {
            sum += c;
            n++;
          }
        }
        if (n) entry.conf = sum / n;
      }

      lines.push({
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
        text: text,
        conf: entry.conf,
      });
    });

    return lines;
  }

  /** 从对象树里收集候选行，兼容 v4 的 data.lines 与 v5 的 data.blocks[].paragraphs[].lines[] */
  function collectLines(data) {
    const out = [];
    if (!data) return out;

    function pushLine(o) {
      if (!o || !o.bbox) return;
      const b = o.bbox;
      const w = (b.x1 || 0) - (b.x0 || 0);
      const h = (b.y1 || 0) - (b.y0 || 0);
      if (!(w > 0) || !(h > 0)) return;
      const text = String(o.text || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      out.push({
        x: b.x0 || 0,
        y: b.y0 || 0,
        w: w,
        h: h,
        text: text,
        conf: typeof o.confidence === "number" ? o.confidence : 100,
      });
    }

    // v4 扁平结构
    if (Array.isArray(data.lines)) {
      for (let i = 0; i < data.lines.length; i++) pushLine(data.lines[i]);
      if (out.length) return out;
    }

    // v5 层级结构
    if (Array.isArray(data.blocks)) {
      for (let bi = 0; bi < data.blocks.length; bi++) {
        const block = data.blocks[bi];
        const paras = (block && block.paragraphs) || [];
        for (let pi = 0; pi < paras.length; pi++) {
          const ls = (paras[pi] && paras[pi].lines) || [];
          for (let li = 0; li < ls.length; li++) pushLine(ls[li]);
        }
      }
      if (out.length) return out;
    }

    // 最后兜底：用词拼成行（词一定有 bbox，按 y 聚一下）
    const words = data.words || [];
    if (words.length) {
      const sorted = words.slice().sort(function (a, b) {
        return (a.bbox ? a.bbox.y0 : 0) - (b.bbox ? b.bbox.y0 : 0);
      });
      let cur = null;
      for (let i = 0; i < sorted.length; i++) {
        const w = sorted[i];
        if (!w.bbox) continue;
        const h = (w.bbox.y1 || 0) - (w.bbox.y0 || 0);
        if (!cur || Math.abs(w.bbox.y0 - cur.y) > Math.max(4, h * 0.6)) {
          cur = {
            x: w.bbox.x0,
            y: w.bbox.y0,
            x1: w.bbox.x1,
            y1: w.bbox.y1,
            words: [w],
          };
          out.push(cur);
        } else {
          cur.words.push(w);
          cur.x = Math.min(cur.x, w.bbox.x0);
          cur.x1 = Math.max(cur.x1, w.bbox.x1);
          cur.y1 = Math.max(cur.y1, w.bbox.y1);
        }
      }
      return out.map(function (c) {
        return {
          x: c.x,
          y: c.y,
          w: c.x1 - c.x,
          h: c.y1 - c.y,
          text: c.words
            .map(function (w) {
              return w.text || "";
            })
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
          conf:
            c.words.reduce(function (s, w) {
              return s + (typeof w.confidence === "number" ? w.confidence : 100);
            }, 0) / Math.max(1, c.words.length),
        };
      });
    }

    return out;
  }

  /**
   * 垃圾过滤。
   *
   * 原实现这里堆了 60 行启发式（元音比例、特定长度的白名单……），
   * 那些规则是从少量测试图反推出来的，换一张图就容易误杀正常单词。
   * 这里只保留"确定是垃圾"的判据，宁可放过也不误杀 —— 因为漏字才是用户的痛点。
   */
  function looksLikeNoise(text, conf) {
    const s = String(text || "").trim();
    if (!s) return true;
    if (s.length < 2) return true;
    if (typeof conf === "number" && conf < 35) return true;

    // 一个字母或汉字都没有 → 不是可翻译的文字
    if (!/[A-Za-z\u4e00-\u9fff]/.test(s)) return true;

    // 同一个字符重复（"|||||"、"....."）
    if (/^(.)\1+$/.test(s.replace(/\s/g, ""))) return true;

    // 符号占比过高
    const symbols = (s.match(/[^A-Za-z0-9\u4e00-\u9fff\s]/g) || []).length;
    if (symbols > s.length * 0.5) return true;

    // 有字母但元音一个都没有，且比 4 个字母长 —— 基本可以断定是识别噪声
    // （PMS、SKU 这类无元音代号通常很短，所以加长度条件避免误杀）
    const letters = s.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 5 && !/[aeiouAEIOU]/.test(letters)) return true;

    return false;
  }

  /** 过滤 + 把条带内的坐标换算回整图坐标 */
  function filterFound(found, band, scaleX, scaleY) {
    const out = [];
    for (let i = 0; i < (found || []).length; i++) {
      const l = found[i];
      if (looksLikeNoise(l.text, l.conf)) continue;
      out.push({
        x: band.x + l.x / scaleX,
        y: band.y + l.y / scaleY,
        w: l.w / scaleX,
        h: l.h / scaleY,
        fontHeight: l.h / scaleY,
        text: l.text,
        conf: l.conf,
      });
    }
    return out;
  }

  /* ============================================================
   * 条带规划
   * ============================================================ */

  /** 把检测到的行聚成"行高相近、垂直相邻"的条带 */
  function planBands(lines, W, H, opts) {
    opts = opts || {};
    const maxBands = opts.maxBands || 10;
    const maxZoom = opts.maxZoom || 4;
    const maxBandSide = opts.maxBandSide || 2600;
    const targetGlyph = opts.targetGlyphHeight || TARGET_GLYPH_HEIGHT;

    const items = (lines || [])
      .filter(function (l) {
        return l && l.w > 1 && l.h > 1;
      })
      .map(function (l) {
        return { x: l.x, y: l.y, w: l.w, h: l.h };
      })
      .sort(function (a, b) {
        if (Math.abs(a.y - b.y) > Math.max(a.h, b.h) * 0.6) return a.y - b.y;
        return a.x - b.x;
      });

    if (!items.length) return [];

    const bands = [];
    for (let i = 0; i < items.length; i++) {
      const l = items[i];
      const last = bands[bands.length - 1];
      let joined = false;

      if (last) {
        const medH = last.medH;
        const gap = l.y - last.y1;
        // 行高接近 → 属于同一"字号层级"，可以共用同一个放大倍数
        const similarH = Math.abs(l.h - medH) <= Math.max(3, medH * 0.5);
        // 垂直靠近 → 放进同一张裁切里不会浪费太多空白
        const near = gap <= Math.max(10, medH * 2.5);
        if (similarH && near && last.lines.length < 12) {
          last.lines.push(l);
          last.x0 = Math.min(last.x0, l.x);
          last.y0 = Math.min(last.y0, l.y);
          last.x1 = Math.max(last.x1, l.x + l.w);
          last.y1 = Math.max(last.y1, l.y + l.h);
          // 用中位数而不是均值：少数异常高的行不该整体拉高放大倍数
          const hs = last.lines
            .map(function (m) {
              return m.h;
            })
            .sort(function (a, b) {
              return a - b;
            });
          last.medH = hs[Math.floor(hs.length / 2)];
          joined = true;
        }
      }

      if (!joined) {
        bands.push({
          x0: l.x,
          y0: l.y,
          x1: l.x + l.w,
          y1: l.y + l.h,
          medH: l.h,
          lines: [l],
        });
      }
    }

    // 条带太多会拖慢速度，把垂直间距最小的一对反复合并
    while (bands.length > maxBands) {
      let bestIdx = -1;
      let bestGap = Infinity;
      for (let i = 0; i < bands.length - 1; i++) {
        const gap = bands[i + 1].y0 - bands[i].y1;
        if (gap < bestGap) {
          bestGap = gap;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const a = bands[bestIdx];
      const b = bands[bestIdx + 1];
      a.x0 = Math.min(a.x0, b.x0);
      a.y0 = Math.min(a.y0, b.y0);
      a.x1 = Math.max(a.x1, b.x1);
      a.y1 = Math.max(a.y1, b.y1);
      a.lines = a.lines.concat(b.lines);
      const hs = a.lines
        .map(function (m) {
          return m.h;
        })
        .sort(function (x, y) {
          return x - y;
        });
      a.medH = hs[Math.floor(hs.length / 2)];
      bands.splice(bestIdx + 1, 1);
    }

    // 每条带按自己的字高算放大倍数
    const out = [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const pad = Math.max(4, Math.round(b.medH * 0.8));
      let x0 = Math.max(0, Math.floor(b.x0 - pad));
      let y0 = Math.max(0, Math.floor(b.y0 - pad));
      let x1 = Math.min(W, Math.ceil(b.x1 + pad));
      let y1 = Math.min(H, Math.ceil(b.y1 + pad));

      let zoom = U.clamp(targetGlyph / Math.max(1, b.medH), 1, maxZoom);

      // 放大后不能超过 Tesseract 舒服处理的尺寸，超了就退回一点
      const w = x1 - x0;
      const h = y1 - y0;
      const side = Math.max(w, h) * zoom;
      if (side > maxBandSide) zoom = Math.max(1, maxBandSide / Math.max(w, h));

      out.push({
        x: x0,
        y: y0,
        w: w,
        h: h,
        zoom: zoom,
        medH: b.medH,
        lineCount: b.lines.length,
      });
    }

    return out;
  }

  /* ============================================================
   * 主入口
   * ============================================================ */

  /**
   * canvas: 原图
   * opts:   { lines, workers, signal, maxBands, maxZoom, target, limits }
   * hooks:  { onProgress({phase, done, total, message}), onLog }
   */
  async function recognize(canvas, opts, hooks) {
    opts = opts || {};
    hooks = hooks || {};
    const LIMITS = (global.PZConfig && global.PZConfig.LIMITS) || {};
    const W = canvas.width;
    const H = canvas.height;
    const t0 = Date.now();

    const stats = { bands: 0, calls: 0, workers: 0, raw: 0, kept: 0, ms: 0 };

    const lines = opts.lines || [];
    let bands = planBands(lines, W, H, {
      maxBands: opts.maxBands || LIMITS.ocrMaxBands || 10,
      maxZoom: opts.maxZoom || 4,
      targetGlyphHeight: opts.targetGlyphHeight,
    });

    // 检测几乎没找到东西时不要直接放弃：可能这张图版面很特殊（比如整页一段文字），
    // 退回一次整图识别，比返回空结果好。
    if (!bands.length) {
      if (hooks.onLog) hooks.onLog("检测未找到文字行，退回整图识别");
      const side = Math.max(W, H);
      const zoom = U.clamp(1800 / Math.max(1, side), 1, 2);
      bands = [{ x: 0, y: 0, w: W, h: H, zoom: zoom, medH: 0, lineCount: 0 }];
    }

    stats.bands = bands.length;

    const workers = opts.workers || LIMITS.ocrWorkers || 3;
    if (hooks.onProgress) {
      hooks.onProgress({ phase: "ocr_init", done: 0, total: bands.length, message: "准备 OCR 引擎" });
    }
    const sched = await ensureScheduler(workers, hooks);
    stats.workers = workerCount;

    const collect = [];

    await U.pool(
      bands,
      async function (band) {
        U.throwIfAborted(opts.signal);

        // 裁切 → 放大/锐化/可选二值化，全部交给 PZImage.prepareForOcr。
        // 这一步是"小字能不能认出来"的关键：客户给的电子截图往往被缩放过，
        // 字边缘是灰的，直接 OCR 认不出；放大后再做反锐化掩膜才认得清。
        const raw = U.cropCanvas(canvas, band, { pad: 0, scale: 1 });
        const prep =
          global.PZImage && global.PZImage.prepareForOcr
            ? global.PZImage.prepareForOcr(raw, {
                zoom: band.zoom,
                sharpen: true,
                binarize: false,
              })
            : raw;

        // 实际倍率以 prepareForOcr 的返回值为准，不要假设它一定等于 band.zoom
        const scaleX = prep.width / Math.max(1, raw.width);
        const scaleY = prep.height / Math.max(1, raw.height);

        let res = null;
        try {
          res = await sched.addJob("recognize", prep, {}, { blocks: true, text: true, tsv: true });
        } catch (err) {
          if (U.isAbortError(err)) throw err;
          if (hooks.onLog) hooks.onLog("条带识别失败：" + (err && err.message ? err.message : err));
          return null;
        }
        stats.calls++;

        const data = res && res.data;
        if (!data) return null;

        // TSV 优先（v4/v5 结构一致、最可靠），拿不到再走对象树。
        //
        // 过滤之后如果一条都没剩下、但解析本身是抽到了行的，说明是
        // **过滤判据**和这个解析器给出的字段不匹配（历史上就栽过一次：
        // TSV 的行级 conf 恒为 -1，被"低置信度"规则全数误杀）。
        // 这时换另一个解析器再试一遍，比静默返回 0 行安全得多。
        let found = parseTsv(data.tsv);
        let kept = filterFound(found, band, scaleX, scaleY);
        if (!kept.length && found.length) {
          const alt = collectLines(data);
          if (alt.length) {
            const altKept = filterFound(alt, band, scaleX, scaleY);
            if (altKept.length) {
              if (hooks.onLog) {
                hooks.onLog("TSV 解析结果被过滤为空，改用层级结构解析（" + altKept.length + " 条）");
              }
              kept = altKept;
            }
          }
        }
        stats.raw += found.length;
        for (let i = 0; i < kept.length; i++) collect.push(kept[i]);
        return null;
      },
      {
        concurrency: workers,
        signal: opts.signal,
        onProgress: function (done, total) {
          if (hooks.onProgress) {
            hooks.onProgress({
              phase: "ocr_band",
              done: done,
              total: total,
              message: "识别条带 " + done + "/" + total,
            });
          }
        },
        onError: function (err) {
          if (hooks.onLog) hooks.onLog("条带异常：" + (err && err.message ? err.message : err));
        },
      }
    );

    // 不同条带之间可能有重叠，也会把同一行认两遍
    const merged = [];
    for (let i = 0; i < collect.length; i++) {
      const c = collect[i];
      let dup = false;
      for (let j = 0; j < merged.length; j++) {
        const m = merged[j];
        if (U.overlapRatio(m, c) > 0.5 && U.sameText(m.text, c.text)) {
          // 保留置信度更高的那条
          if ((c.conf || 0) > (m.conf || 0)) merged[j] = c;
          dup = true;
          break;
        }
      }
      if (!dup) merged.push(c);
    }

    stats.kept = merged.length;
    stats.ms = Date.now() - t0;

    return { lines: merged, stats: stats };
  }

  global.PZOcr = {
    recognize: recognize,
    terminate: terminate,
    // 导出内部函数便于单测
    planBands: planBands,
    parseTsv: parseTsv,
    collectLines: collectLines,
    looksLikeNoise: looksLikeNoise,
  };
})(typeof window !== "undefined" ? window : globalThis);
