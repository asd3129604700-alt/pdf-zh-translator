/**
 * PZOverlay — 中文排版与覆盖引擎（PDF 与图片共用的唯一一套）
 *
 * 原项目有两套覆盖逻辑：pdf-engine 的 renderPageComposed（用 PDF 坐标、y 向上）
 * 和 image-engine 的 overlayLines（用画布坐标、y 向下）。两者字号策略不一致，
 * 是"中文溢出压住下一行"这类问题的根源。这里合并成一套。
 *
 * 设计要点：
 *  1. 按「框」索引，不按原文文本索引 —— 原实现用 map[line.text] 映射，
 *     同一段英文出现两次会被强制翻成同一结果，且重复文本互相覆盖。
 *  2. 先算每个框上下有多少**空闲空间**，再决定字号，而不是无脑放宽 2.2 倍高度。
 *  3. 覆盖底色逐列插值重建，而不是刷一块平均色 —— 渐变色底上不会留下突兀矩形。
 *  4. 最终 clip 到允许区域内，保证绝不压到相邻文字。
 */
(function (global) {
  "use strict";

  const U = global.PZUtil;
  if (!U) throw new Error("PZOverlay 依赖 PZUtil，请先加载 js/util.js");

  const DEFAULT_FONT_STACK =
    '"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",' +
    '"Hiragino Sans GB",SimHei,sans-serif';

  /** 全角标点，不允许出现在行首 */
  const NO_LINE_START = "，。、；：？！）》」』】…—·%";
  /** 不允许出现在行尾 */
  const NO_LINE_END = "（《「『【";

  function isCJK(ch) {
    const c = ch.charCodeAt(0);
    return (
      (c >= 0x3000 && c <= 0x303f) || // CJK 标点
      (c >= 0x3040 && c <= 0x30ff) || // 假名
      (c >= 0x4e00 && c <= 0x9fff) || // 汉字
      (c >= 0xff00 && c <= 0xffef) // 全角
    );
  }

  /* ============================================================
   * 纯逻辑（可注入假 measure，Node 里能单测）
   * ============================================================ */

  /**
   * 换行。英文按空格断，中文没空格所以按字断。
   * 顺带处理两个中文排版禁忌：行首不能是收尾标点，行尾不能是起始标点。
   *
   * spacing 是字距（em）。放在 opts 之前，是因为它是排版参数而不是选项，
   * 而且旧调用点传 4 个参数时不至于把 opts 挤错位。
   */
  function wrapText(measure, text, maxWidth, fontSize, spacing, opts) {
    const src = String(text == null ? "" : text);
    if (!src) return [];
    if (!(maxWidth > 0)) return [src];

    const chars = Array.from(src);
    const lines = [];
    let cur = "";

    function width(s) {
      return measure(s, fontSize, spacing);
    }

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const trial = cur + ch;
      if (cur && width(trial) > maxWidth) {
        // 避免行首出现收尾标点：把它拽回上一行
        if (NO_LINE_START.indexOf(ch) >= 0) {
          lines.push(cur + ch);
          cur = "";
          continue;
        }
        // 避免行尾出现起始标点：把它推到下一行
        const last = cur.charAt(cur.length - 1);
        if (NO_LINE_END.indexOf(last) >= 0) {
          lines.push(cur.slice(0, -1));
          cur = last + ch;
          continue;
        }
        lines.push(cur);
        cur = ch === " " ? "" : ch;
      } else {
        cur = trial;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [src];
  }

  /**
   * 在给定框内排版中文。
   *
   * measure(str, fontSize, spacingEm) -> 像素宽度（注入的函数，便于测试）
   *   spacingEm 是字距，单位是 em（负值表示收紧）。第三个参数可以省略。
   * box: {x, y, w, h}
   * opts: {
   *   minFontSize, maxFontSize, allowH,        // allowH = 实际可用高度（含上下空闲）
   *   lineHeightRatio, fontFillRatio, letterSpacings
   * }
   *
   * 返回 { lines, fontSize, lineHeight, blockH, widest, spacing, x, y, overflow, shrunk }
   *
   * 关于两个默认值，参考的是 ShinobuTranslator 的排版常数：
   *  · 行高 1.16 → 1.02。中文行高比西文紧，1.16 排出来松垮、且多行块占高、
   *    反而逼着字号往小缩。它的 horizontalLineHeightRatio 是 0.93（更紧）。
   *  · 加了字距微调：宽度差一点点时，优先**收紧字距**而不是缩小字号 ——
   *    字号是视觉大小的主体，能不动就不动。它有
   *    minHorizontalLetterSpacingScale / maxHorizontalLetterSpacingScale 专门管这个。
   */
  function layoutText(measure, text, box, opts) {
    opts = opts || {};
    const w = Math.max(1, box.w);
    const h = Math.max(1, box.h);
    const minFont = Math.max(4, opts.minFontSize || 6);
    const allowH = Math.max(h, opts.allowH || h);
    const lineHeightRatio = opts.lineHeightRatio || 1.02;
    const fillRatio = opts.fontFillRatio || 0.92;
    const spacings = opts.letterSpacings || [0, -0.012, -0.025, -0.04];

    // 起始字号按原文行高来（原文行高就是最可靠的"这里的字本来多大"信号）
    let start = Math.floor(h * fillRatio);
    if (opts.maxFontSize) start = Math.min(start, opts.maxFontSize);
    if (start < minFont) start = minFont;

    // 生成递减的字号阶梯，避免浮点下取整导致死循环
    const ladder = [];
    let f = start;
    let guard = 0;
    while (guard++ < 40) {
      ladder.push(f);
      if (f <= minFont) break;
      const next = Math.floor(f * 0.92);
      if (next >= f) break;
      f = next;
    }

    let chosen = null;
    for (let i = 0; i < ladder.length && !chosen; i++) {
      const fs = ladder[i];
      const lineHeight = fs * lineHeightRatio;
      // 同一个字号下先试正常字距，再逐步收紧 —— 收紧能过就不必缩字号
      for (let s = 0; s < spacings.length; s++) {
        const sp = spacings[s];
        const lines = wrapText(measure, text, w, fs, sp, opts);
        const blockH = lines.length * lineHeight;
        if (blockH > allowH) continue;
        let widest = 0;
        for (let k = 0; k < lines.length; k++) {
          widest = Math.max(widest, measure(lines[k], fs, sp));
        }
        if (widest <= w + 0.5) {
          chosen = {
            lines: lines,
            fontSize: fs,
            lineHeight: lineHeight,
            blockH: blockH,
            widest: widest,
            spacing: sp,
          };
          break;
        }
      }
    }

    let overflow = false;

    let overflowX = false;

    // ---------- 次选：允许轻微溢出 ----------
    //
    // 参考 ShinobuTranslator 的 minorOverflowMaxGlyphCount=2 /
    // minorOverflowShrinkMinScale=0.8：如果严格放不下、字号已经被压到理想值的
    // 0.8 倍以下，那么"字号正确但略微超宽"比"宽度正好但字小一圈"更好看。
    //
    // 两条硬约束，避免溢出变成事故：
    //   · 最多超 2 个字形宽；
    //   · 不能超出**可用横向空间**（allowW，由调用方按邻居边界算出来）。
    // 调用方还要保证覆盖范围把这段中文包进去，否则会被裁剪掉。
    const idealSize = ladder[0];
    const minScale = opts.minorOverflowShrinkMinScale == null ? 0.8 : opts.minorOverflowShrinkMinScale;
    const maxOverflowGlyphs = opts.minorOverflowMaxGlyphCount == null ? 2 : opts.minorOverflowMaxGlyphCount;
    // 除了"最多 2 个字形宽"，再加一道**比例**上限。
    // 只按字形数算的话，一个装 6 个字的窄框允许超 2 个字 = 超 33%，视觉上明显出格。
    // 12% 刚好够跨一档字号（阶梯是 0.92，一档 = 8.7%），这正是这个机制要解决的问题。
    const maxOverflowRatio = opts.maxOverflowRatio == null ? 0.12 : opts.maxOverflowRatio;
    const allowW = opts.allowW == null ? Infinity : opts.allowW;

    if (!chosen || chosen.fontSize < idealSize * minScale) {
      for (let i = 0; i < ladder.length; i++) {
        const fs = ladder[i];
        // 不比已选结果更大就没意义（阶梯是从大到小的）
        if (chosen && fs <= chosen.fontSize) break;
        const lineHeight = fs * lineHeightRatio;
        // 横向放宽到三重约束里最紧的那个
        const limit = Math.max(
          w,
          Math.min(allowW, w + maxOverflowGlyphs * fs, w * (1 + maxOverflowRatio))
        );
        let found = null;
        for (let s = 0; s < spacings.length; s++) {
          const sp = spacings[s];
          const lines = wrapText(measure, text, limit, fs, sp, opts);
          const blockH = lines.length * lineHeight;
          if (blockH > allowH) continue;
          let widest = 0;
          for (let k = 0; k < lines.length; k++) {
            widest = Math.max(widest, measure(lines[k], fs, sp));
          }
          if (widest <= limit + 0.5) {
            found = {
              lines: lines,
              fontSize: fs,
              lineHeight: lineHeight,
              blockH: blockH,
              widest: widest,
              spacing: sp,
            };
            break;
          }
        }
        if (found) {
          chosen = found;
          overflowX = found.widest > w + 0.5;
          break;
        }
      }
    }

    if (!chosen) {
      // 连最小字号都放不下：用最小字号硬排，交给调用方去 clip，并标记溢出
      const fs = minFont;
      const sp = spacings[spacings.length - 1];
      const lines = wrapText(measure, text, w, fs, sp, opts);
      const lineHeight = fs * lineHeightRatio;
      let widest = 0;
      for (let k = 0; k < lines.length; k++) {
        widest = Math.max(widest, measure(lines[k], fs, sp));
      }
      chosen = {
        lines: lines,
        fontSize: fs,
        lineHeight: lineHeight,
        blockH: lines.length * lineHeight,
        widest: widest,
        spacing: sp,
      };
      overflow = true;
    }

    const textH = chosen.blockH;

    // 正常情况下以原框中心对齐（中文行高与原文行高不相等，居中比顶对齐自然）。
    // 但当中文块比原框高时，必须把它夹在允许区间内，否则会被裁剪掉一行。
    const availH = Math.max(h, opts.allowH || h);
    const allowTop =
      opts.allowTop == null ? box.y - (availH - h) / 2 : opts.allowTop;
    const allowBottom =
      opts.allowBottom == null ? allowTop + availH : opts.allowBottom;

    let y = box.y + (h - textH) / 2;
    const lo = allowTop;
    const hi = Math.max(lo, allowBottom - textH);
    y = U.clamp(y, lo, hi);

    return {
      lines: chosen.lines,
      fontSize: chosen.fontSize,
      lineHeight: chosen.lineHeight,
      blockH: textH,
      widest: chosen.widest,
      spacing: chosen.spacing,
      x: box.x,
      y: y,
      overflow: overflow,
      shrunk: chosen.fontSize < start,
      overflowX: overflowX,
      // 字距被收紧过（说明是用调字距换来的字号，值得记一笔）
      tightened: chosen.spacing < 0,
    };
  }

  /**
   * 计算每个框上下各有多少可用空间（含允许的增长）。
   *
   * 这是"不压字"的关键：原实现允许中文块长到原文高度的 2.2 倍，
   * 但完全没检查下面是不是还有别的文字，所以密集表格上必然互相覆盖。
   * 这里用同列相邻框的位置反推出真实可用区间。
   *
   * 注意是"可用区间"而不是"可用高度"：既要能收紧（下面有邻居），
   * 也要能放宽（周围是空白，中文比英文长时可以占用一些）。
   * 否则长译文只能一路缩字号，白白浪费旁边的空白。
   */
  function computeNeighborLimits(items, canvasW, canvasH, opts) {
    opts = opts || {};
    const gap = opts.gap == null ? 3 : opts.gap;
    const maxGrowY = opts.maxGrowY || 1.35;
    const out = [];

    for (let i = 0; i < items.length; i++) {
      const a = items[i];

      // 先按"最多长到 maxGrowY 倍"给出一个上下对称的初始区间
      const grow = Math.max(0, maxGrowY - 1) * a.h;
      let top = a.y - grow / 2;
      let bottom = a.y + a.h + grow / 2;

      // 左右的初始边界就是整张画布，只由**同一行上的邻居**收紧。
      //
      // 为什么不按行高推算一个"合理余量"：上游的框能偏多少没有可靠先验
      // （视觉模型给的是归一化估计值，OCR 的 bbox 不含抗锯齿边和降部），
      // 拍一个 0.7 或 1.5 倍行高都是在凭经验凑常数。真正的硬约束只有一个 ——
      // 不能扩到别的文字上。所以这里只用邻居位置约束。
      let left = 0;
      let right = canvasW;

      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const b = items[j];
        const ovX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const ovY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);

        // 同列（水平投影重叠）→ 约束上下
        if (ovX > 0) {
          if (b.y + b.h <= a.y) {
            top = Math.max(top, b.y + b.h + gap);
          } else if (b.y >= a.y + a.h) {
            bottom = Math.min(bottom, b.y - gap);
          }
        }
        // 同行（垂直投影重叠）→ 约束左右
        if (ovY > 0) {
          if (b.x + b.w <= a.x) {
            left = Math.max(left, b.x + b.w + gap);
          } else if (b.x >= a.x + a.w) {
            right = Math.min(right, b.x - gap);
          }
        }
      }

      // 画布边界
      top = Math.max(0, top);
      bottom = Math.min(canvasH, bottom);
      left = Math.max(0, left);
      right = Math.min(canvasW, right);

      // 无论如何至少要保住原框本身
      top = Math.min(top, a.y);
      bottom = Math.max(bottom, a.y + a.h);
      left = Math.min(left, a.x);
      right = Math.max(right, a.x + a.w);

      out.push({
        top: top,
        bottom: bottom,
        left: left,
        right: right,
        allowH: Math.max(1, bottom - top),
      });
    }
    return out;
  }

  /* ============================================================
   * 颜色采样
   * ============================================================ */

  function luminance(c) {
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  }

  /** 中位色。用中位数而不是均值，避免被少量文字像素带偏 */
  function medianColor(list) {
    if (!list.length) return [255, 255, 255];
    const r = [];
    const g = [];
    const b = [];
    for (let i = 0; i < list.length; i++) {
      r.push(list[i][0]);
      g.push(list[i][1]);
      b.push(list[i][2]);
    }
    function mid(arr) {
      arr.sort(function (x, y) {
        return x - y;
      });
      return arr[Math.floor(arr.length / 2)];
    }
    return [mid(r), mid(g), mid(b)];
  }

  function colorVariance(list) {
    if (list.length < 2) return 0;
    const m = medianColor(list);
    let s = 0;
    for (let i = 0; i < list.length; i++) {
      s += Math.abs(list[i][0] - m[0]) + Math.abs(list[i][1] - m[1]) + Math.abs(list[i][2] - m[2]);
    }
    return s / (list.length * 3);
  }

  function rgbCss(c) {
    return "rgb(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ")";
  }

  /* ============================================================
   * 字段配色（可选功能，默认关闭）
   *
   * 按字段类型给中文上不同颜色，便于在密密麻麻的规格表上扫读。
   * 分类是启发式的（看原文的形态），不需要任何语义模型：
   *   · code  型号 / 色号 / 纯数值
   *   · label 短标签 / 表头
   *   · note  说明句
   *
   * 为什么默认关闭：这会改变原文档的观感，交给客户前可能不合适。
   * 而且**深色底上不上色** —— 固定色在深底上的对比度没保障，
   * 宁可保持从原图采样出来的字色（那是保证可读的）。
   * ============================================================ */

  const FIELD_COLORS = {
    label: [26, 79, 138], // 深蓝：标签 / 表头
    code: [138, 26, 92], // 品红：型号 / 色号 / 数值
    note: [31, 111, 58], // 深绿：说明句
  };

  function classifyField(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return "normal";
    // 型号 / 色号
    if (/^(PMS|SKU|ITEM|ART|MODEL)\b/i.test(s)) return "code";
    // 纯数值 / 尺寸 / 百分比
    if (/^[\d\s.,%'"\/x×\-+]+$/i.test(s)) return "code";
    // 数字 + 单位（规格表上到处都是，例如 "45 in"、"160cm"、"65 %"）
    if (/^[\d.,]+\s*(in|inch|cm|mm|m|ft|kg|g|oz|lb|pcs?|%)$/i.test(s)) return "code";
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const len = latin + han;
    // 长句 → 说明
    if (len >= 22 || /[.。;；]/.test(s)) return "note";
    // 全大写的短标签 / 表头
    if (/^[A-Z0-9\s\/&.\-]{2,}$/.test(s)) return "label";
    if (len <= 14) return "label";
    return "normal";
  }

  /**
   * 决定这一条用什么颜色。
   * bg 是 {@link sampleBackground} 的结果：里面有采样出来的 textColor 和 bgIsDark。
   */
  function colorForItem(it, bg, opts) {
    const fallback = bg.textColor;
    if (!opts || !opts.fieldColors) return fallback;
    if (bg.bgIsDark) return fallback; // 深底上保持采样色，保证对比度
    const kind = classifyField(it.src || it.dst);
    return FIELD_COLORS[kind] || fallback;
  }

  /* ============================================================
   * 实测框内的文字几何
   *
   * 为什么不能直接信传进来的框（下面这些数字是在真实客户图纸上量出来的）：
   *
   * 1. **框常常比文字宽**。某张 TO 图纸上，框宽/墨迹宽中位数 1.17，
   *    最松的一个框左边留了 29px 空白。中文按框左边缘画就会整体左偏 29px
   *    —— 这是"中文对不齐"的直接原因。
   *
   * 2. **框可能装着一整段而不只是一行**。视觉模型习惯把一段文字框成一块，
   *    实测出现过 1308×450、906×165 这种框，里面是好幾行小字。
   *    按框高定字号会算出 fontSize = 0.92 × 450 = 414px，
   *    而那块里每行原文只有 30px —— 这是"字体太大"的直接原因。
   *
   * 所以先量出框内墨迹的外接框和**行数**，再用"单行高"定字号、
   * 用"墨迹左边缘"定位。上游框给松还是给紧都不影响结果。
   * ============================================================ */

  /** 与背景亮度差多少算"墨" */
  const INK_CONTRAST = 38;

  function measureInk(ctx, box, canvasW, canvasH, opts) {
    opts = opts || {};
    const contrast = opts.contrast == null ? INK_CONTRAST : opts.contrast;
    const x0 = U.clamp(Math.floor(box.x), 0, canvasW - 1);
    const y0 = U.clamp(Math.floor(box.y), 0, canvasH - 1);
    const x1 = U.clamp(Math.ceil(box.x + box.w), x0 + 1, canvasW);
    const y1 = U.clamp(Math.ceil(box.y + box.h), y0 + 1, canvasH);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 3 || h < 3) return null;

    let img;
    try {
      img = ctx.getImageData(x0, y0, w, h);
    } catch (e) {
      return null;
    }
    const d = img.data;
    const n = w * h;
    const lum = new Float32Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const v = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      lum[i] = v;
      hist[v < 0 ? 0 : v > 255 ? 255 : v | 0]++;
    }
    // 背景亮度取中位数：文字只占少数像素，中位数一定落在背景上
    let acc = 0;
    let bgLum = 128;
    const half = n / 2;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= half) {
        bgLum = v;
        break;
      }
    }

    let ix0 = w;
    let iy0 = h;
    let ix1 = -1;
    let iy1 = -1;
    let inkCount = 0;
    const rowCount = new Int32Array(h);
    // 每行的左右边界，用来判断原文的对齐方式（多行时看哪种对齐的边缘最齐）
    const rowMinX = new Int32Array(h);
    const rowMaxX = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      let mn = -1;
      let mx = -1;
      for (let x = 0; x < w; x++) {
        if (Math.abs(lum[y * w + x] - bgLum) > contrast) {
          c++;
          if (mn < 0) mn = x;
          mx = x;
          if (x < ix0) ix0 = x;
          if (x > ix1) ix1 = x;
          if (y < iy0) iy0 = y;
          if (y > iy1) iy1 = y;
        }
      }
      rowCount[y] = c;
      rowMinX[y] = mn < 0 ? 0 : mn;
      rowMaxX[y] = mx < 0 ? 0 : mx;
      inkCount += c;
    }
    if (ix1 < 0) return null;

    // 数行：在墨迹的纵向范围内找"连续的墨行带"，同时记录每行的左右边界
    const bands = [];
    let start = -1;
    let bMinX = 0;
    let bMaxX = 0;
    for (let y = iy0; y <= iy1 + 1; y++) {
      const on = y <= iy1 && rowCount[y] > 0;
      if (on) {
        if (start < 0) {
          start = y;
          bMinX = rowMinX[y];
          bMaxX = rowMaxX[y];
        } else {
          if (rowMinX[y] < bMinX) bMinX = rowMinX[y];
          if (rowMaxX[y] > bMaxX) bMaxX = rowMaxX[y];
        }
      } else if (start >= 0) {
        if (y - start >= 2) {
          bands.push({ h: y - start, x0: bMinX, x1: bMaxX });
        }
        start = -1;
      }
    }

    const inkH = iy1 - iy0 + 1;
    const inkW = ix1 - ix0 + 1;
    let lineHeight = inkH;
    let lineCount = 1;
    if (bands.length > 1) {
      // 用各行带高度的中位数当"单行高"：比 inkH/行数 稳，
      // 不会被某一行带降部、或一行里的零星杂点带偏
      const hs = bands
        .map(function (b) {
          return b.h;
        })
        .sort(function (a, b) {
          return a - b;
        });
      lineHeight = hs[hs.length >> 1];
      lineCount = bands.length;
    }

    return {
      // 全部是整图坐标
      x: x0 + ix0,
      y: y0 + iy0,
      w: inkW,
      h: inkH,
      right: x0 + ix1,
      bottom: y0 + iy1,
      lineCount: lineCount,
      lineHeight: lineHeight,
      padLeft: ix0,
      padTop: iy0,
      alignment: inferAlignment(bands, inkW, w, ix0, ix1),
      inkDensity: inkCount / Math.max(1, inkW * inkH),
      bgLum: bgLum,
      bgIsDark: bgLum < 95,
      boxW: w,
      boxH: h,
    };
  }

  /**
   * 推断原文的水平对齐方式。
   *
   * 多行时看哪种对齐的"边缘离散度"最小 —— 左对齐的行左边缘齐、居中行的
   * 中心齐、右对齐的行右边缘齐。思路参考 ShinobuTranslator 的
   * inferHorizontalAlignment（它对 left/center/right 各算一次 spread 取最小）。
   *
   * 单行时没有行间信息，只能看它在框里的留白：左右留白都明显且接近 → 居中；
   * 左边留白明显更多 → 右对齐；否则左对齐。
   *
   * 为什么值得做：中文通常比英文短，如果原文是居中的标题，
   * 一律从左边开始画就会明显偏左 —— 这是"排版不好看"里很显眼的一种。
   */
  function inferAlignment(bands, inkW, boxW, ix0, ix1) {
    if (bands.length >= 2) {
      const lefts = bands.map(function (b) {
        return b.x0;
      });
      const rights = bands.map(function (b) {
        return b.x1;
      });
      const centers = bands.map(function (b) {
        return (b.x0 + b.x1) / 2;
      });
      const spread = function (arr) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < mn) mn = arr[i];
          if (arr[i] > mx) mx = arr[i];
        }
        return mx - mn;
      };
      const sL = spread(lefts);
      const sC = spread(centers);
      const sR = spread(rights);
      // 用"相对行宽的离散度"比较，避免长行天然绝对偏差更大
      const tol = Math.max(3, inkW * 0.12);
      if (sC <= tol && sC < sL && sC < sR) return "center";
      if (sR <= tol && sR < sL) return "right";
      return "left";
    }

    // 单行：看框内左右留白
    const padL = ix0;
    const padR = boxW - 1 - ix1;
    const minPad = Math.max(4, boxW * 0.08);
    if (padL >= minPad && padR >= minPad) {
      if (Math.abs(padL - padR) <= Math.max(6, boxW * 0.12)) return "center";
      if (padL > padR * 1.8) return "right";
    }
    return "left";
  }

  /**
   * 采样：底色 ring（用于重建背景）+ 字色（用于写中文）。
   *
   * ring 的关键是**在框外面采样**（上方、下方、左右两侧），
   * 因为框里面就是原文，采到的是文字像素而不是背景。
   */
  function sampleBackground(ctx, box, canvasW, canvasH) {
    const x0 = U.clamp(Math.round(box.x), 0, canvasW - 1);
    const y0 = U.clamp(Math.round(box.y), 0, canvasH - 1);
    const x1 = U.clamp(Math.round(box.x + box.w), x0 + 1, canvasW);
    const y1 = U.clamp(Math.round(box.y + box.h), y0 + 1, canvasH);
    const w = x1 - x0;
    const h = y1 - y0;

    // 整个过程只读 5 次像素。原实现是逐点 getImageData(px, py, 1, 1)，
    // 一个 300px 宽的框就会产生上千次调用 —— 那是排版阶段最大的耗时来源，
    // 而且读写 1×1 的开销几乎全在函数调用上，跟像素数无关。
    const aboveH = Math.min(9, y0);
    const belowH = Math.min(9, canvasH - y1);
    const leftW = Math.min(7, x0);
    const rightW = Math.min(7, canvasW - x1);

    const above = aboveH > 0 ? ctx.getImageData(x0, y0 - aboveH, w, aboveH).data : null;
    const below = belowH > 0 ? ctx.getImageData(x0, y1, w, belowH).data : null;
    const left = leftW > 0 ? ctx.getImageData(x0 - leftW, y0, leftW, h).data : null;
    const right = rightW > 0 ? ctx.getImageData(x1, y0, rightW, h).data : null;
    const inner = ctx.getImageData(x0, y0, w, h).data;

    function pick(data, sw, sx, sy) {
      const o = (sy * sw + sx) * 4;
      return [data[o], data[o + 1], data[o + 2]];
    }

    /** 从上方/下方条带里取"距框约 3px"的那一行，返回逐列颜色 */
    function bandAt(data, sh, fromTop, k) {
      const row = U.clamp(fromTop ? sh - 1 - k : k, 0, sh - 1);
      const out = new Array(w);
      for (let cx = 0; cx < w; cx++) out[cx] = pick(data, w, cx, row);
      return out;
    }

    /** 从左右条带里取框内某高度处、框外 1px/4px 的颜色，返回逐列颜色 */
    function sideAt(data, sw, yOff, fromLeft) {
      const ry = U.clamp(yOff, 0, h - 1);
      const c1 = fromLeft ? sw - 1 : 0;
      const c2 = fromLeft ? Math.max(0, sw - 4) : Math.min(sw - 1, 3);
      const out = new Array(w);
      for (let cx = 0; cx < w; cx++) {
        out[cx] = medianColor([pick(data, sw, c1, ry), pick(data, sw, c2, ry)]);
      }
      return out;
    }

    // ring 数量按框高决定：矮框两行足够，高框多采几行才能跟上色带变化
    const ringCount = U.clamp(Math.round(h / 18) + 1, 2, 6);
    const rows = [];

    for (let ri = 0; ri < ringCount; ri++) {
      const t = ringCount === 1 ? 0 : ri / (ringCount - 1);
      let row = null;

      if (ri === 0) {
        // 首行取框**上方**的颜色（这里最接近框内背景且不含文字）
        row = above ? bandAt(above, aboveH, true, 3) : below ? bandAt(below, belowH, false, 3) : null;
      } else if (ri === ringCount - 1) {
        row = below ? bandAt(below, belowH, false, 3) : above ? bandAt(above, aboveH, true, 3) : null;
      } else {
        // 中间行：只能从框的**左右两侧**取，框内已经被原文占了，取到的是文字像素
        const yOff = Math.round(t * (h - 1));
        const parts = [];
        if (left) parts.push(sideAt(left, leftW, yOff, true));
        if (right) parts.push(sideAt(right, rightW, yOff, false));
        if (parts.length === 2) {
          const a = parts[0];
          const b = parts[1];
          row = new Array(w);
          for (let cx = 0; cx < w; cx++) row[cx] = medianColor([a[cx], b[cx]]);
        } else if (parts.length === 1) {
          row = parts[0];
        }
      }

      if (!row) {
        // 兜底：框贴边且占满，框外一个像素都没有，只能从框内取
        row = new Array(w);
        for (let cx = 0; cx < w; cx++) row[cx] = pick(inner, w, cx, Math.round(t * (h - 1)));
      }
      rows.push(row);
    }

    // 汇总所有 ring 样本，判断背景是深是浅、是否均匀
    const all = [];
    for (let ri = 0; ri < rows.length; ri++) {
      for (let cx = 0; cx < rows[ri].length; cx++) all.push(rows[ri][cx]);
    }
    const bgColor = medianColor(all);
    const bgVar = colorVariance(all);
    const bgIsDark = luminance(bgColor) < 95;

    // 字色：取框内与背景亮度差足够大的像素的中位色，这样能保留彩色字
    let textColor = bgIsDark ? [245, 245, 245] : [24, 24, 24];
    const bgLum = luminance(bgColor);
    const darkPix = [];
    const lightPix = [];
    for (let i = 0; i < inner.length; i += 4) {
      const c = [inner[i], inner[i + 1], inner[i + 2]];
      const l = luminance(c);
      if (bgIsDark) {
        if (l > bgLum + 45) lightPix.push(c);
      } else if (l < bgLum - 45) {
        darkPix.push(c);
      }
    }
    const ink = bgIsDark ? lightPix : darkPix;
    // 采样点太少说明框内本来就没有明显的字（可能是去重后剩下的空框），用默认值更稳
    if (ink.length >= Math.max(6, (w * h) / 400)) {
      textColor = medianColor(ink);
      if (!bgIsDark) {
        // 略微压暗：中文小字在浅底上需要足够对比度才看得清
        textColor = [
          Math.round(textColor[0] * 0.92),
          Math.round(textColor[1] * 0.92),
          Math.round(textColor[2] * 0.92),
        ];
      }
    }

    return {
      rows: rows,
      uniform: bgVar < 6,
      bgColor: bgColor,
      bgIsDark: bgIsDark,
      textColor: textColor,
    };
  }

  /**
   * 把 ring 数据画成一条 1 像素高、w 像素宽的小图，
   * 再拉伸到目标框 —— 借助 canvas 的双线性插值自动得到**逐列垂直渐变**。
   * 比逐列 fillRect 快得多，也比刷一块平均色准确得多。
   */
  function paintBackground(ctx, box, info) {
    const x0 = Math.round(box.x);
    const y0 = Math.round(box.y);
    const w = Math.max(1, Math.round(box.w));
    const h = Math.max(1, Math.round(box.h));

    if (info.uniform) {
      ctx.fillStyle = rgbCss(info.bgColor);
      ctx.fillRect(x0, y0, w, h);
      return;
    }

    const rows = info.rows;
    const n = rows.length;
    const strip = U.createCanvas(w, n);
    const sctx = strip.getContext("2d");
    const img = sctx.createImageData(w, n);
    const d = img.data;
    for (let ri = 0; ri < n; ri++) {
      const row = rows[ri];
      for (let cx = 0; cx < w; cx++) {
        const c = row[Math.min(cx, row.length - 1)] || [255, 255, 255];
        const o = (ri * w + cx) * 4;
        d[o] = c[0];
        d[o + 1] = c[1];
        d[o + 2] = c[2];
        d[o + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(strip, 0, 0, w, n, x0, y0, w, h);
  }

  /* ============================================================
   * 主入口
   * ============================================================ */

  /**
   * 造一个 measure(str, fontPx, spacingEm)。
   *
   * 字距用 canvas 的 `letterSpacing`（Chrome/Edge 99+）。不支持时就退化成
   * 按字符数手工估算 —— 中文每字一个 em，这个估算对 CJK 足够准，
   * 总比完全不支持字距微调要好。
   */
  function makeMeasurer(ctx, fontStack, weight) {
    const w = weight || 500;
    const nativeSpacing = typeof ctx.letterSpacing === "string";
    return function (str, fontPx, spacingEm) {
      ctx.font = w + " " + fontPx + "px " + fontStack;
      const sp = spacingEm || 0;
      if (nativeSpacing) {
        ctx.letterSpacing = (sp * fontPx).toFixed(2) + "px";
        const width = ctx.measureText(str).width;
        ctx.letterSpacing = "0px";
        return width;
      }
      const base = ctx.measureText(str).width;
      const n = Array.from(String(str)).length;
      return base + sp * fontPx * Math.max(0, n - 1);
    };
  }

  /**
   * sourceCanvas: 原始页面/图片
   * items: [{x, y, w, h, src, dst}]  —— 画布像素坐标，左上角原点
   * opts:  {cover, fontStack, minFontSize, maxGrowY, signal, onProgress}
   *
   * 返回新画布（不改动 sourceCanvas），并把统计挂在 canvas._overlayStats 上。
   */
  function render(sourceCanvas, items, opts) {
    opts = opts || {};
    const canvas = U.cloneCanvas(sourceCanvas);
    const ctx = U.ctx2d(canvas, { willReadFrequently: true });
    // 采样一律读**原图**（sourceCanvas 没有被涂改过），
    // 不要读上面那张正在被写的 canvas —— 否则先画上去的补丁会污染后面的采样。
    const srcCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

    const stats = {
      total: items ? items.length : 0,
      drawn: 0,
      skippedSame: 0,
      skippedEmpty: 0,
      shrunk: 0,
      overflow: 0,
      grown: 0,
      inpainted: 0,
      inpaintPixels: 0,
      inpaintFallback: 0,
      erasedByFill: 0,
      erasedByRepair: 0,
      lowCoverage: 0,
      failed: 0,
      ms: 0,
    };

    const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

    if (!opts.cover || !items || !items.length) {
      canvas._overlayStats = stats;
      return canvas;
    }

    const fontStack = opts.fontStack || (global.PZPdf && global.PZPdf.FONT_STACK) || DEFAULT_FONT_STACK;
    const maxGrowY = opts.maxGrowY || 1.35;
    const minFontSize = opts.minFontSize || 6;
    const measure = makeMeasurer(ctx, fontStack, opts.weight);

    // 只处理真正需要覆盖的条目，减少邻居计算量
    const work = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dst = it.dst == null ? "" : String(it.dst);
      const src = it.src == null ? "" : String(it.src);
      if (!dst) {
        stats.skippedEmpty++;
        continue;
      }
      if (dst === src) {
        // 「保持原样」的情况：不动它
        stats.skippedSame++;
        continue;
      }
      if (!(it.w > 0) || !(it.h > 0)) {
        stats.failed++;
        continue;
      }
      work.push(it);
    }

    if (!work.length) {
      canvas._overlayStats = stats;
      return canvas;
    }

    const limits = computeNeighborLimits(work, canvas.width, canvas.height, {
      maxGrowY: maxGrowY,
      gap: opts.neighborGap == null ? 3 : opts.neighborGap,
    });

    for (let i = 0; i < work.length; i++) {
      if (opts.signal && opts.signal.aborted) break;
      const it = work[i];
      const lim = limits[i];

      try {
        // 先实测框内文字的真实几何（外接框 + 行数），不要直接信传进来的框。
        // 上游的框可能比文字宽（→ 中文左偏），也可能装着一整段（→ 字号算得过大）。
        const ink =
          opts.measureInk === false
            ? null
            : measureInk(srcCtx, it, canvas.width, canvas.height, {
                contrast: opts.inkContrast,
              });

        const textBox = ink
          ? { x: ink.x, y: ink.y, w: ink.w, h: ink.h }
          : { x: it.x, y: it.y, w: it.w, h: it.h };

        // 字号上限：
        //  · 正常情况下**不超过原文的单行高** —— 这是之前修"字体太大"定下的规矩；
        //  · 但原文本身很小的时候（8~9px 的标注），照搬就成了看不清的小字，
        //    用户反馈"有的字还是太小了"。所以给一个可读下限：允许放到
        //    max(原文单行高, 可读下限)。中文普通比英文短，框内往往有余量，
        //    排版函数会在宽高约束内尽量取大，取不到也不会硬撑。
        const readableFloor = opts.minReadableSize == null ? 11 : opts.minReadableSize;
        let sizeCap = opts.maxFontSize || Infinity;
        if (ink && ink.lineHeight > 0) {
          sizeCap = Math.min(sizeCap, Math.max(ink.lineHeight, readableFloor));
        }

        const laid = layoutText(measure, String(it.dst), textBox, {
          minFontSize: minFontSize,
          maxFontSize: sizeCap,
          allowTop: lim.top,
          allowBottom: lim.bottom,
          allowH: lim.allowH,
          // 横向可用空间：允许"轻微溢出"时不能越过邻居
          allowW: Math.max(1, lim.right - lim.left),
          minorOverflowMaxGlyphCount: opts.minorOverflowMaxGlyphCount,
          minorOverflowShrinkMinScale: opts.minorOverflowShrinkMinScale,
          fontFillRatio: opts.fontFillRatio,
          lineHeightRatio: opts.lineHeightRatio,
        });

        // 绘制起点：按原文的对齐方式定位。
        // 中文一般比英文短，如果原文是居中的标题，一律从左边起画就会明显偏左。
        let drawX = laid.x;
        if (ink && laid.widest > 0) {
          if (ink.alignment === "center") {
            drawX = ink.x + (ink.w - laid.widest) / 2;
          } else if (ink.alignment === "right") {
            drawX = ink.x + ink.w - laid.widest;
          }
        }

        // 去字范围 = 原框 ∪ 实际文字块 ∪ **真正画出来的中文范围**，再加一圈余量。
        //
        // 最后一项是"允许轻微溢出"能成立的前提：中文可能比原框宽一点，
        // 去字范围不跟着走的话，多出来的部分会被 clip 掉。
        //
        // 垂直方向的余量不能省：原文的 bbox 通常不含抗锯齿边缘和降部
        // （g/y/p 的下半截会伸出去），不留余量就会在中文下面留一道灰边。
        //
        // 余量比"刚好贴合"大一些（行高的 1/4），因为上游的框可能偏小；
        // 但**必须是固定上限、不能再迭代扩张** —— 见下面那段注释。
        const padX = Math.max(3, Math.round(it.h * 0.25));
        const padY = Math.max(3, Math.round(it.h * 0.3));
        const textL = drawX;
        const textR = drawX + Math.max(0, laid.widest);

        // 夹在邻居允许的范围内：宁可少擦一点，也绝不能压到旁边的文字。
        let bx = Math.max(Math.min(it.x - padX, textL - padX), lim.left);
        let by = Math.max(Math.min(it.y, laid.y) - padY, lim.top);
        let bx1 = Math.min(Math.max(it.x + it.w + padX, textR + padX), lim.right);
        let by1 = Math.min(Math.max(it.y + it.h, laid.y + laid.blockH) + padY, lim.bottom);
        if (bx1 <= bx) bx1 = Math.min(bx + 1, lim.right);
        if (by1 <= by) by1 = Math.min(by + 1, lim.bottom);
        const cover = { x: bx, y: by, w: bx1 - bx, h: by1 - by };

        // ⚠ 这里以前有一段 growCoverUntilClean：不断向外扩张直到"边缘干净"。
        // 那是错的，而且是"涂抹做得太差"的主因：
        // 文字旁边常常有表格线、边框、图案描边，它们永远不会让边缘变"干净"，
        // 于是扩张一路顶到上限，**把一大块表格线或图案擦掉**。
        // 更糟的是我当时用来衡量效果的指标是"边缘还有没有墨"，
        // 而擦掉线条正好让这个数字变好看 —— 指标本身在奖励错误行为。
        //
        // 现在改为：擦除范围由**文字掩膜**决定（见 PZInpaint），
        // 扩张只保留上面那个固定余量。
        if (opts.onCover) {
          opts.onCover(cover, { x: it.x, y: it.y, w: it.w, h: it.h });
        }

        // 字色/底色深浅从**原图**采样（这张画布已经被涂改过，读它会串味）
        const bg = sampleBackground(srcCtx, cover, canvas.width, canvas.height);

        // 去字：
        //  · fill   —— 采背景主色，把整块实心填掉。**保证零残留**，
        //               文字压在纯色底上时看不出痕迹（用户点名要这个）
        //  · repair —— 只擦文字像素再用扩散补回去，背景有图案/渐变时更自然，
        //               但依赖掩膜判断，判错会留残留
        let coverOk = false;
        if (global.PZInpaint && opts.inpaint !== false) {
          const inp = global.PZInpaint.coverText(srcCtx, ctx, cover, {
            mode: opts.eraseMode,
            ringWidth: opts.eraseRingWidth,
            contrast: opts.inkContrast,
            dilate: opts.inpaintDilate,
            minMaskRatio: opts.inpaintMinMaskRatio,
            fillColor: opts.eraseFillColor,
          });
          coverOk = !!inp.ok;
          if (coverOk) {
            stats.inpainted++;
            if (inp.mode === "fill") {
              stats.erasedByFill++;
              // 底色不纯（压在图案/渐变上）时纯色填充会是一块看得见的色块，
              // 记下来报给用户，而不是默默交出一张有痕迹的图
              if (inp.coverage < 0.7) stats.lowCoverage++;
            } else {
              stats.erasedByRepair++;
              stats.inpaintPixels += inp.maskCount || 0;
            }
          } else {
            stats.inpaintFallback++;
          }
        }
        if (!coverOk) {
          paintBackground(ctx, cover, bg);
        }

        ctx.save();
        // 裁剪到覆盖范围：宁可字被裁掉一点，也绝不压到相邻文字
        ctx.beginPath();
        ctx.rect(cover.x, cover.y, cover.w, cover.h);
        ctx.clip();

        // drawX 在上面就算好了（覆盖范围要用它）
        ctx.fillStyle = rgbCss(colorForItem(it, bg, opts));
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.font = "500 " + laid.fontSize + "px " + fontStack;
        // 字距是在排版阶段就定好的（收紧字距常常能保住更大的字号），
        // 绘制时必须用同一个值，否则量出来的宽度和画出来的对不上。
        const nativeSpacing = typeof ctx.letterSpacing === "string";
        if (nativeSpacing) {
          ctx.letterSpacing = ((laid.spacing || 0) * laid.fontSize).toFixed(2) + "px";
        }
        for (let li = 0; li < laid.lines.length; li++) {
          ctx.fillText(laid.lines[li], drawX, laid.y + li * laid.lineHeight);
        }
        if (nativeSpacing) ctx.letterSpacing = "0px";
        ctx.restore();

        stats.drawn++;
        if (laid.shrunk) stats.shrunk++;
        if (laid.overflow) stats.overflow++;
      } catch (err) {
        stats.failed++;
        if (opts.onLog) opts.onLog("覆盖失败：" + (err && err.message ? err.message : err));
      }

      if (opts.onProgress) opts.onProgress(i + 1, work.length);
    }

    const t1 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    stats.ms = t1 - t0;
    canvas._overlayStats = stats;
    return canvas;
  }

  global.PZOverlay = {
    render: render,
    // 纯逻辑，导出便于单测
    layoutText: layoutText,
    wrapText: wrapText,
    computeNeighborLimits: computeNeighborLimits,
    sampleBackground: sampleBackground,
    medianColor: medianColor,
    isCJK: isCJK,
    // 去字干净程度相关的内部函数（单测要用）
    measureInk: measureInk,
    classifyField: classifyField,
    colorForItem: colorForItem,
    inferAlignment: inferAlignment,
    DEFAULT_FONT_STACK: DEFAULT_FONT_STACK,
  };
})(typeof window !== "undefined" ? window : globalThis);