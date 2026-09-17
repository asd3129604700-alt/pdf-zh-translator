/**
 * PZDetect — 纯 JS 文字区域检测
 *
 * 为什么要有这个模块：原实现用 Tesseract 做"多尺度全图探测"来找文字框，
 * 一张图最多 68 次串行 OCR —— 又慢、又不可靠（Tesseract 的版面分析在
 * 小字和规格表上本来就容易崩）。检测只需要回答"哪里有字"，
 * 不需要认识字，所以完全可以用二值化 + 形态学 + 连通域自己做，
 * 一次几百毫秒，且不依赖任何 OCR。
 *
 * 流水线（每一步都单独导出，单测可以逐段验证）：
 *   PZImage.downscaleImage → 长边缩到 maxSide（检测不需要全分辨率，缩了才够快）
 *   binarizeForDetect→ 局部自适应二值化（细窗口 ∪ 粗窗口，见下）
 *   removeSolidBlobs → 去掉大块实心墨（深色面板/色卡/大图标，避免"连坐"掉旁边的文字）
 *   removeLongLines  → 去掉表格线/图框（又长又细的水平带）
 *   estimateTextHeight → 从行投影估字高（清理之后再估一次更准）
 *   dilateBinary     → 水平膨胀，把相邻字形黏成词/行
 *   connectedComponents → 游程 + 并查集两遍法（绝不用递归 DFS，1600px 必爆栈）
 *   filterComponents → 高度 / 墨密度 / 宽高比 / 行覆盖率过滤
 *   componentsToLines→ 组件合并成行
 *   linesToRegions   → 行聚类成区域（复用 PZUtil.groupBoxesIntoBlocks）
 *   最后按 1/scale 还原回原图坐标
 *
 * 坐标系：全程"左上角原点、x 向右、y 向下"，对外返回的也是原图坐标。
 *
 * 经典脚本（非 ES module），挂到 window.PZDetect。
 */
(function (global) {
  "use strict";

  function util() {
    if (!global.PZUtil) throw new Error("PZDetect 依赖 PZUtil，请先加载 js/util.js");
    return global.PZUtil;
  }

  function image() {
    if (!global.PZImage) throw new Error("PZDetect 依赖 PZImage，请先加载 js/imageproc.js");
    return global.PZImage;
  }

  function num(v, d) {
    return typeof v === "number" && isFinite(v) ? v : d;
  }

  function odd(v) {
    let n = Math.max(1, Math.round(v));
    if (n % 2 === 0) n++;
    return n;
  }

  function now() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  /* ============================================================
   * 默认参数（全部可以被 opts / PZConfig.LIMITS 覆盖）
   * ============================================================ */

  const DEFAULTS = {
    maxSide: 1600, // 检测尺度长边上限
    minLineHeight: 6, // 判定为文字行的最小行高（检测尺度）
    maxLineHeightRatio: 0.28, // 行高不得超过图高的这个比例
    maxRegions: 40, // 最多输出多少区域
    regionPad: 6, // 区域外扩（检测尺度）

    // 二值化
    window: 0, // 0 = 自动 max(15, round(短边/40))，强制奇数
    C: 10, // 局部均值 - C
    coarseWindowFactor: 6, // 粗窗口 = max(3*细窗口, 短边/该值)
    autoInvert: true, // 深底浅字自动反相

    // 表格线 / 图框清除
    lineMinLength: 0, // 0 = 自动 3 × 字高
    lineLengthFactor: 3,
    lineThicknessFactor: 0.6,

    // 大块实心墨清除（深色面板、色卡、大图标）
    solidMinThickness: 0, // 0 = 自动 0.8 × 字高
    solidThicknessFactor: 0.8,
    solidMaxThicknessRatio: 0.125, // 结构元不超过短边的这个比例

    // 形态学 / 过滤
    dilateFactor: 0.6, // 结构元宽度 = factor × 估计字高
    maxDilateWidth: 25,
    minDensity: 0.06, // 文字行的墨密度下限
    maxDensity: 0.62, // 上限：实心线条/色块接近 1，会被排掉
    minAspect: 0.4,
    // 宽高比上限。规范给的是 80，但实测太紧：检测尺度下一条"7px 小字铺满整幅宽度"
    // 的正文行，宽高比 = 1600/7 ≈ 229，会被误杀 —— 而这恰恰是用户最常遇到、
    // 最怕漏的那种小字长行。真正要挡的"贯穿整页的细横线"已经由
    // removeLongLines（长度+厚度判据）和墨密度上限（≈1.0）两道防线拦住了，
    // 宽高比不需要再承担这个职责，所以放宽到 400。
    maxAspect: 400,
    minRowCoverage: 0.25, // 框内"有墨的行"占比下限，专治空心边框
    glyphMaxFactor: 2, // 小于 2×字高的组件豁免墨密度上限（标点、项目符号）
    glyphExemptMaxSide: 32, // 豁免的绝对上限，防止大标题把字高估大后放过大色块
    minInk: 3,

    // 行合并 / 区域聚类
    lineOverlap: 0.6, // 垂直重叠比例阈值
    lineGapFactor: 1.6, // 水平间距 < factor × 行高
    regionVGap: 0, // 0 = 由字高推算
    regionHGap: 0,
    blockAlignTol: 0.35,
  };

  function resolveOpts(opts) {
    opts = opts || {};
    // 默认值从 PZConfig.LIMITS 取（架构约定：算法里不写死运行参数）。
    // 优先级：opts > opts.limits（调用方整体传入的一份配置）> PZConfig.LIMITS > 内置兜底。
    const LIMITS = (global.PZConfig && global.PZConfig.LIMITS) || {};
    const L = opts.limits || LIMITS;
    const o = {};
    const keys = Object.keys(DEFAULTS);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      o[k] = DEFAULTS[k];
    }
    o.maxSide = num(opts.maxSide, num(L.detectMaxSide, num(LIMITS.detectMaxSide, o.maxSide)));
    o.minLineHeight = num(
      opts.minLineHeight,
      num(L.detectMinLineHeight, num(LIMITS.detectMinLineHeight, o.minLineHeight))
    );
    o.maxLineHeightRatio = num(
      opts.maxLineHeightRatio,
      num(L.detectMaxLineHeightRatio, num(LIMITS.detectMaxLineHeightRatio, o.maxLineHeightRatio))
    );
    o.maxRegions = num(
      opts.maxRegions,
      num(L.detectMaxRegions, num(LIMITS.detectMaxRegions, o.maxRegions))
    );
    o.regionPad = num(
      opts.regionPad,
      num(L.detectRegionPad, num(LIMITS.detectRegionPad, o.regionPad))
    );
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (opts[k] != null) o[k] = opts[k];
    }
    return o;
  }

  /* ============================================================
   * 1. 二值化
   * ============================================================ */

  /**
   * 检测专用二值化：细窗口和粗窗口两套"局部均值 - C"取并集。
   *
   * 为什么必须是局部自适应：规格表常有彩色底、渐变底、深色面板，
   * 全局 Otsu 在这些图上会整片失效（要么全白要么全黑）。
   *
   * 为什么还要一个"粗窗口"：纯局部均值法有个著名缺陷 ——
   * 大面积实心暗块（色块、图标、粗表格填充）的内部，局部均值本身也是暗的，
   * 于是内部反而不被判成墨，只留下一圈"空心环"。这圈环的墨密度
   * 大约 0.4~0.75，正好落在文字行的 0.06~0.62 里，会被误判成文字。
   * 用一个大得多的窗口再算一次均值：大窗口会被周围的白底拉高，
   * 于是实心块的内部也被完整标成墨，墨密度直接到 ≈1.0，
   * 被墨密度上限干净地排掉。两个窗口共用一个积分图，额外代价很小。
   *
   * o: { window, C, coarseWindow, coarseWindowFactor, autoInvert }
   */
  function binarizeForDetect(gray, w, h, opts) {
    const o = opts || {};
    const PZ = image();
    w = w | 0;
    h = h | 0;
    const out = new Uint8Array(Math.max(0, w * h));
    if (w < 3 || h < 3) return out;

    const shortSide = Math.min(w, h);
    const win = odd(Math.min(num(o.window, 0) || Math.max(15, Math.round(shortSide / 40)), shortSide));
    const C = num(o.C, 10);
    const coarse = odd(
      Math.min(
        num(o.coarseWindow, 0) ||
          Math.max(win * 3, Math.round(shortSide / num(o.coarseWindowFactor, 6))),
        shortSide
      )
    );

    let g = gray;
    if (o.autoInvert !== false) {
      // 极性判断：深底浅字（暗色 UI 截图、深色面板）用"更深=墨"的规则
      // 一个墨点也找不到，先反相统一成"深墨浅底"。
      // 抽样统计即可，极性不需要精确到每个像素。
      // 用 <=（Otsu 的阈值语义是"背景类的最大灰度"），否则在纯双峰图上
      // t 会正好落在暗峰上，深底浅字的图会漏掉反相。
      const t = PZ.otsu(gray);
      let dark = 0;
      let samples = 0;
      const step = 4;
      for (let i = 0; i < gray.length; i += step) {
        samples++;
        if (gray[i] <= t) dark++;
      }
      if (samples && dark / samples > 0.6) g = PZ.invertGray(gray);
    }

    const ig = PZ.integral(g, w, h, { sq: false });
    const fine = PZ.adaptiveThreshold(g, w, h, { window: win, C: C, integral: ig });
    const coarseBin = PZ.adaptiveThreshold(g, w, h, {
      window: coarse,
      C: num(o.coarseC, C),
      integral: ig,
    });
    for (let i = 0; i < out.length; i++) {
      out[i] = fine[i] || coarseBin[i] ? 1 : 0;
    }
    return out;
  }

  /* ============================================================
   * 2. 字高估计 / 水平膨胀
   * ============================================================ */

  /**
   * 从行墨量投影估"典型文字行高"（检测尺度）。
   *
   * 用它决定膨胀结构元的宽度：结构元太宽会把相距很远的两个标签连成一行，
   * 太窄则一个词被拆成好几个组件。所以宁可估得偏小一点。
   * 用中位数而不是均值：规格表里总有几个大标题，
   * 均值会被它们拉高，中位数对小字更友好。
   */
  function estimateTextHeight(bin, w, h, opts) {
    const o = opts || {};
    w = w | 0;
    h = h | 0;
    const minH = Math.max(1, Math.round(num(o.minLineHeight, 6)));
    const maxH = Math.max(minH + 1, Math.round(num(o.maxLineHeight, Math.max(1, h * 0.28))));
    const fallback = Math.max(minH, Math.round(num(o.fallback, Math.min(w, h) / 150)));
    // 上限：字高不可能超过短边的 1/16。
    // 为什么必须卡一下：如果整幅图只有一个大空心框（或只有一块面板），
    // 行投影会给出"一条 120px 高的字行"，后面的长线清除阈值（3×字高）
    // 就会大于框的边长，横边清不掉，空心框最后会被当成文字行。
    const cap = Math.max(minH, Math.round(Math.min(w, h) * num(o.maxHeightCapRatio, 1 / 16)));
    if (w < 3 || h < 3) return Math.min(fallback, cap);

    const counts = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let c = 0;
      for (let x = 0; x < w; x++) if (bin[row + x]) c++;
      counts[y] = c;
    }
    // 每行至少要有这么点墨才算"这一行有字"，滤掉孤立噪点撑出来的假行
    const thr = Math.max(2, Math.round(w * 0.004));
    const heights = [];
    let y = 0;
    while (y < h) {
      if (counts[y] >= thr) {
        let y1 = y;
        while (y1 + 1 < h && counts[y1 + 1] >= thr) y1++;
        const bh = y1 - y + 1;
        if (bh >= minH && bh <= maxH) heights.push(bh);
        y = y1 + 1;
      } else {
        y++;
      }
    }
    if (!heights.length) return Math.min(fallback, cap);
    heights.sort(function (a, b) {
      return a - b;
    });
    return Math.min(heights[(heights.length - 1) >> 1], cap);
  }

  /** 膨胀结构元宽度：0.6 × 字高，夹到 [3, maxDilateWidth]，强制奇数。 */
  function dilateWidthFor(estHeight, opts) {
    const o = opts || {};
    const f = num(o.dilateFactor, 0.6);
    const maxW = num(o.maxDilateWidth, 25);
    return odd(Math.min(maxW, Math.max(3, Math.round(f * num(estHeight, 6)))));
  }

  /**
   * 二值膨胀。默认只用水平结构元（kw × 1）。
   *
   * 为什么要膨胀：一个字的笔画是断开的（i 的点、引号、以及"边缘不锐利"的
   * 截图里被二值化切断的细笔画），不黏起来的话连通域会把一个词切成十几个，
   * 后续的行/区域合并会被噪声主导。水平膨胀只沿着文字排列方向黏合，
   * 不会把上下两行糊在一起。
   *
   * 实现是"两次单向扫"而不是窗口内取 max：O(n) 且没有边界分支。
   */
  function dilateBinary(bin, w, h, opts) {
    const o = opts || {};
    w = w | 0;
    h = h | 0;
    const n = Math.max(0, w * h);
    const kw = odd(Math.max(1, Math.round(num(o.kw, num(o.width, 3)))));
    const kh = odd(Math.max(1, Math.round(num(o.kh, 1))));
    const rx = (kw - 1) >> 1;
    const ry = (kh - 1) >> 1;
    const out = new Uint8Array(n);
    if (!n) return out;
    if (rx === 0 && ry === 0) {
      out.set(bin.subarray ? bin.subarray(0, n) : bin);
      return out;
    }

    if (rx > 0) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let d = rx + 1;
        for (let x = 0; x < w; x++) {
          d = bin[row + x] ? 0 : d + 1;
          if (d <= rx) out[row + x] = 1;
        }
        d = rx + 1;
        for (let x = w - 1; x >= 0; x--) {
          d = bin[row + x] ? 0 : d + 1;
          if (d <= rx) out[row + x] = 1;
        }
      }
    } else {
      out.set(bin.subarray ? bin.subarray(0, n) : bin);
    }

    if (ry > 0) {
      const src = out.slice();
      for (let x = 0; x < w; x++) {
        let d = ry + 1;
        for (let y = 0; y < h; y++) {
          const i = y * w + x;
          d = src[i] ? 0 : d + 1;
          if (d <= ry) out[i] = 1;
        }
        d = ry + 1;
        for (let y = h - 1; y >= 0; y--) {
          const i = y * w + x;
          d = src[i] ? 0 : d + 1;
          if (d <= ry) out[i] = 1;
        }
      }
    }
    return out;
  }

  /* ============================================================
   * 3. 去掉表格线 / 图框
   * ============================================================ */

  /**
   * 去掉"又长又细的直线"：表格边框、分隔线、图框。
   *
   * 为什么必须单独做这一步：一条 2px 粗、闭合的 200×80 图框，
   * 它的墨密度只有 0.069，比真实文字行（0.15~0.35）还低，
   * 单靠墨密度下限根本挡不住（阈值再往上抬就会误杀"字距很大的标题"）；
   * 而它的行覆盖率是 1.0（左右两条竖边让每一行都有墨），也挡不住。
   * 但它对 OCR 是纯噪声：把图框当文字区域送去识别，既浪费请求，
   * 又会让模型在框线附近瞎猜。
   *
   * 判据：先找"长度 ≥ 3×字高"的水平游程（真实文字的笔画很短，
   * 一个字母的横笔画最多 1 个字宽，绝不会到 3 倍字高），
   * 再用"同一 x 区间在相邻行的覆盖率 ≥ 0.6"量出这条带的厚度，
   * 厚度 ≤ 0.6×字高才认定为线。厚度这一条是为了保护实心色块：
   * 色块虽然有很长的游程，但厚度是几十像素，不会被误删。
   *
   * 只处理水平线：竖线（表格竖框）本来就过不了宽高比下限，不用多此一举。
   *
   * 返回新的 Uint8Array（不修改入参），并把被删掉的像素数挂在 .removed 上。
   */
  function removeLongLines(bin, w, h, opts) {
    const o = opts || {};
    const charH = num(o.charHeight, 10);
    const minLen = Math.max(
      8,
      Math.round(num(o.minLength, 0) || charH * num(o.lengthFactor, 3))
    );
    const maxThick = Math.max(
      1,
      Math.round(num(o.maxThickness, 0) || Math.max(3, charH * num(o.thicknessFactor, 0.6)))
    );
    const out = new Uint8Array(bin.length);
    out.set(bin);
    out.removed = 0;
    if (minLen > w) return out;

    // 逐行收集游程（扁平存 x0,x1），行区间由 rowStart/rowEnd 指出。
    // 用游程而不是逐像素扫：判断厚度时要反复查"某一行在某个 x 区间的覆盖率"，
    // 查游程是 O(该行游程数)，逐像素就是 O(区间长度)，在满页横线的图上差几十倍。
    const runs = [];
    const rowStart = new Int32Array(h);
    const rowEnd = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      rowStart[y] = runs.length >> 1;
      const row = y * w;
      let x = 0;
      while (x < w) {
        if (bin[row + x]) {
          let j = x;
          while (j + 1 < w && bin[row + j + 1]) j++;
          runs.push(x, j + 1);
          x = j + 1;
        } else {
          x++;
        }
      }
      rowEnd[y] = runs.length >> 1;
    }

    function covers(row, x0, x1) {
      const need = (x1 - x0) * 0.6;
      for (let r = rowStart[row]; r < rowEnd[row]; r++) {
        const a = runs[r * 2];
        const b = runs[r * 2 + 1];
        const ov = Math.min(b, x1) - Math.max(a, x0);
        if (ov >= need) return true;
      }
      return false;
    }

    for (let y = 0; y < h; y++) {
      for (let r = rowStart[y]; r < rowEnd[y]; r++) {
        const x0 = runs[r * 2];
        const x1 = runs[r * 2 + 1];
        if (x1 - x0 < minLen) continue;
        let top = y;
        let bot = y;
        while (top - 1 >= 0 && covers(top - 1, x0, x1)) top--;
        while (bot + 1 < h && covers(bot + 1, x0, x1)) bot++;
        if (bot - top + 1 > maxThick) continue; // 够厚 → 是色块/图片，不是线
        for (let yy = top; yy <= bot; yy++) {
          const off = yy * w;
          for (let k = x0; k < x1; k++) out[off + k] = 0;
        }
        // 只从带的第一行统计一次，否则 2px 厚的线会被数两遍
        if (y === top) out.removed += (bot - top + 1) * (x1 - x0);
      }
    }
    return out;
  }

  /* ============================================================
   * 4. 去掉大块实心墨
   * ============================================================ */

  /**
   * 去掉"大块实心墨"：深色面板、色卡、大图标、粗色块。
   *
   * 为什么需要这一步：规格表上常见"深色标题栏 / 色卡 / 产品图"紧挨着文字。
   * 这类色块被二值化后是一片实心墨，只要它和旁边的文字行在相邻行上有
   * 任何一列重叠，连通域就会把它们黏成一个整体；那个整体的尺寸和墨密度
   * 都不像文字，于是被整体否决 —— 连带把旁边的真文字一起丢掉。
   * 这是"漏识别"里最隐蔽的一类：二值化没错，是"连坐"了。
   *
   * 做法是形态学开运算做尺寸过滤：先腐蚀（要求 k×k 邻域全为墨）再膨胀回去。
   * 比结构元小的结构（也就是文字笔画）会被腐蚀抹掉，开运算结果里就没有它们；
   * 只有"长和厚都超过 k"的实心块能留下来，然后把留下的部分从掩膜里减掉。
   * k 取 0.8×字高：正常文字的笔画宽度远小于字高，绝不会被误删；
   * 而一个实心块要想存活必须两个方向都超过 0.8 字高，正常字形不可能。
   *
   * 复用 dilateBinary：腐蚀 = 对"非墨"做膨胀再取反（形态学对偶），不用再写一遍。
   */
  function removeSolidBlobs(bin, w, h, opts) {
    const o = opts || {};
    const charH = num(o.charHeight, 10);
    const minW = Math.min(w, h);
    let k = odd(
      Math.max(3, Math.round(num(o.minThickness, 0) || charH * num(o.thicknessFactor, 0.8)))
    );
    // 兜底上限：字高估得离谱时，也不允许结构元大到把整幅图吃掉
    const cap = Math.max(3, Math.round(minW * num(o.maxThicknessRatio, 0.125)));
    if (k > cap) k = odd(cap);

    const out = new Uint8Array(bin.length);
    out.set(bin);
    out.removed = 0;
    if (k < 3 || minW < k) return out;

    // inv = NOT bin；d1 = dilate(inv) = NOT erode(bin)；d2 = dilate(NOT d1) = opening
    const inv = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) inv[i] = bin[i] ? 0 : 1;
    const d1 = dilateBinary(inv, w, h, { kw: k, kh: k });
    const notD1 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) notD1[i] = d1[i] ? 0 : 1;
    const opening = dilateBinary(notD1, w, h, { kw: k, kh: k });

    let removed = 0;
    for (let i = 0; i < bin.length; i++) {
      if (bin[i] && opening[i]) {
        out[i] = 0;
        removed++;
      }
    }
    out.removed = removed;
    return out;
  }

  /* ============================================================
   * 5. 连通域标记
   * ============================================================ */

  /**
   * 连通域标记：逐行提取游程（run）→ 相邻行游程重叠则并查集合并 → 汇总 bbox。
   *
   * 为什么不用递归 DFS：1600×1200 的图上一条表格边框就是 1600 长的连通路径，
   * 递归深度直接爆栈。显式栈的 BFS 能work，但要给每个像素存栈帧，慢且占内存。
   *
   * 为什么用游程而不是逐像素两遍法：二值化+膨胀后的图，一行的墨是成段出现的，
   * 游程数量比像素数少一两个数量级（文字行尤其明显），
   * 并查集只跑在"段"上，1600×1200 的实际耗时才几毫秒。
   *
   * 同时统计 rawInk：每个游程覆盖范围内、**未膨胀**掩膜里的墨像素数。
   * 这一点很关键 —— 墨密度必须用原始墨量算。膨胀会沿着水平方向把
   * 笔画之间的空隙填满，用膨胀后的面积算密度，正常文字也会接近 1.0，
   * 那"密度过滤"就完全失效了。
   *
   * opts: { raw }  未膨胀的墨掩膜（强烈建议传，否则密度会用膨胀后的面积算，偏大）
   * 返回：组件数组 [{id,x,y,w,h,area,ink,rows,rowCoverage,density}]，并附带 .count
   */
  function connectedComponents(bin, w, h, opts) {
    const o = opts || {};
    const raw = o.raw || null;
    w = w | 0;
    h = h | 0;
    const comps = [];
    comps.count = 0;
    if (w < 1 || h < 1) return comps;

    const parent = []; // 并查集，下标 = 游程下标
    const runs = []; // {y, x0, x1}
    const runInk = [];
    const runRow = [];

    function find(i) {
      let r = i;
      while (parent[r] !== r) {
        parent[r] = parent[parent[r]]; // 路径折半：顺手压缩，避免长链
        r = parent[r];
      }
      return r;
    }
    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    let prevLo = -1;
    let prevHi = -1;
    let runCount = 0; // 游程个数（runs 是扁平的 x0,x1 对，所以不能直接用 runs.length 当下标）

    for (let y = 0; y < h; y++) {
      const row = y * w;
      const curLo = runCount;
      let x = 0;
      while (x < w) {
        if (bin[row + x]) {
          let j = x;
          while (j + 1 < w && bin[row + j + 1]) j++;
          const x0 = x;
          const x1 = j + 1;
          let ink = 0;
          if (raw) {
            for (let k = x0; k < x1; k++) if (raw[row + k]) ink++;
          } else {
            ink = x1 - x0;
          }
          const idx = runCount++;
          runs.push(x0, x1);
          runRow.push(y);
          runInk.push(ink);
          parent.push(idx);
          x = x1;
        } else {
          x++;
        }
      }
      const curHi = runCount;

      if (prevLo >= 0) {
        // 两指针扫上一行与本行的游程：x 区间相接或重叠就并到一起。
        // 用"相接也算"（<=）而不是严格重叠：斜笔画逐行只错开 1px 时，
        // 严格重叠会把一个字母的下半截判成另一个组件。
        let i = prevLo;
        let k = curLo;
        while (i < prevHi && k < curHi) {
          const ax0 = runs[i * 2];
          const ax1 = runs[i * 2 + 1];
          const bx0 = runs[k * 2];
          const bx1 = runs[k * 2 + 1];
          if (ax1 < bx0) i++;
          else if (bx1 < ax0) k++;
          else {
            union(i, k);
            if (ax1 < bx1) i++;
            else k++;
          }
        }
      }
      prevLo = curLo;
      prevHi = curHi;
    }

    const rootIndex = new Map();
    for (let i = 0; i < runCount; i++) {
      const root = find(i);
      let ci = rootIndex.get(root);
      if (ci === undefined) {
        ci = comps.length;
        rootIndex.set(root, ci);
        comps.push({
          id: ci,
          x: 1 << 30,
          y: 1 << 30,
          x1: -1,
          y1: -1,
          area: 0,
          ink: 0,
          rows: 0,
          _lastRow: -1,
          rowCoverage: 0,
          density: 0,
        });
      }
      const c = comps[ci];
      const x0 = runs[i * 2];
      const x1 = runs[i * 2 + 1]; // 右开
      const ry = runRow[i];
      if (x0 < c.x) c.x = x0;
      if (x1 > c.x1) c.x1 = x1;
      if (ry < c.y) c.y = ry;
      if (ry + 1 > c.y1) c.y1 = ry + 1; // 统一成"右开/下开"，宽度高度就是减法
      c.area += x1 - x0;
      c.ink += runInk[i];
      if (c._lastRow !== ry) {
        c.rows++;
        c._lastRow = ry;
      }
    }

    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      c.w = c.x1 - c.x;
      c.h = c.y1 - c.y;
      c.rowCoverage = c.h > 0 ? Math.min(1, c.rows / c.h) : 0;
      c.density = c.w * c.h > 0 ? c.ink / (c.w * c.h) : 0;
      delete c._lastRow;
    }
    comps.count = comps.length;
    return comps;
  }

  /* ============================================================
   * 6. 过滤
   * ============================================================ */

  /**
   * 单个框的"像不像文字行"校验。组件和行共用这套规则（行的下限更严）。
   *
   * 四条规则，按重要性排：
   * 1) 墨密度 = 墨像素数 / (w×h) 落在 [0.06, 0.62] —— 这条最关键。
   *    一条实心横线（表格边框、分隔线）密度接近 1.0；
   *    一个大而空的框（未填色的表格单元格、图框）密度接近 0；
   *    真正的文字行，字与字、笔画之间的空隙占大头，密度稳定落在中间。
   *    （例外：尺寸只有一两个字符那么大的实心块，大多是句点、项目符号、
   *      "±"这种符号，密度天然高，硬卡会丢标点，所以给一个小尺寸豁免。）
   * 2) 高度落在 [minLineHeight, 图高 × maxLineHeightRatio]。
   * 3) 宽高比落在 [0.4, 400]：比 0.4 还窄的"细高条"是表格竖线；
   *    比 400 还宽的"细长条"基本只可能是贯穿整页的横线
   *    （注意：真实的长文字行宽高比可以到 200 上下，上限不能按"一个词的形状"来定）。
   * 4) 行覆盖率：框内有墨的行数 / h。空心边框只有上下两条边有墨，
   *    覆盖率极低；文字行的 bbox 是紧贴字形的，几乎每一行都有墨。
   *    这条补上了"边框墨密度刚好卡在阈值边缘"的漏洞。
   */
  function validateBox(box, opts) {
    const o = opts || {};
    const w = num(box.w, 0);
    const h = num(box.h, 0);
    if (!(w >= 1) || !(h >= 1)) return { ok: false, reason: "empty" };

    const minH = num(o.minLineHeight, 6);
    const maxH = num(o.maxLineHeight, Infinity);
    if (h < minH) return { ok: false, reason: "too_short" };
    if (h > maxH) return { ok: false, reason: "too_tall" };

    const ink = typeof box.ink === "number" ? box.ink : num(box.area, 0);
    if (ink < num(o.minInk, 3)) return { ok: false, reason: "too_little_ink" };
    const density = ink / (w * h);

    if (density < num(o.minDensity, 0.06)) return { ok: false, reason: "density_low" };

    const glyphH = num(o.glyphHeight, 0);
    const cap = Math.min(
      glyphH > 0 ? glyphH * num(o.glyphMaxFactor, 2) : 0,
      num(o.glyphExemptMaxSide, 32)
    );
    const exempt = o.glyphExempt !== false && cap > 0 && w <= cap && h <= cap;
    if (!exempt && density > num(o.maxDensity, 0.62)) {
      return { ok: false, reason: "density_high" };
    }

    // 宽高比放在墨密度之后判断：贯穿整页的分隔线同时满足"墨密度 1.0"和
    // "宽高比过大"两个条件，先报 density_high 才能一眼看出是密度规则在起作用。
    const aspect = w / h;
    if (aspect < num(o.minAspect, 0.4)) return { ok: false, reason: "too_narrow" };
    if (aspect > num(o.maxAspect, 400)) return { ok: false, reason: "too_wide" };

    if (o.checkRows !== false && typeof box.rowCoverage === "number") {
      if (box.rowCoverage < num(o.minRowCoverage, 0.25)) {
        return { ok: false, reason: "rows_sparse" };
      }
    }
    return { ok: true, reason: null, density: density, exempt: exempt };
  }

  /** 过滤组件。返回保留下来的组件（不修改入参，用 validateBox 查询被拒原因）。 */
  function filterComponents(comps, opts) {
    const o = normalizeFilterOpts(comps, opts);
    const out = [];
    for (let i = 0; i < comps.length; i++) {
      if (validateBox(comps[i], o).ok) out.push(comps[i]);
    }
    out.count = out.length;
    return out;
  }

  /** 过滤行（规则同组件，但行高下限用"行高标准"，不再放宽）。 */
  function filterLines(lines, opts) {
    const o = normalizeFilterOpts(lines, opts);
    o.checkRows = false; // 行是多个组件并出来的，行覆盖率会被重复计数顶到 1，没有区分力
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (validateBox(lines[i], o).ok) out.push(lines[i]);
    }
    out.count = out.length;
    return out;
  }

  function normalizeFilterOpts(boxes, opts) {
    const o = {};
    const src = opts || {};
    for (const k in src) o[k] = src[k];
    // 字高缺省时自己估：取所有框高度的中位数（中位数对个别大标题不敏感）
    if (o.glyphHeight == null) {
      const hs = [];
      for (let i = 0; i < boxes.length; i++) {
        const hh = num(boxes[i].h, 0);
        if (hh >= num(o.minLineHeight, 1)) hs.push(hh);
      }
      if (hs.length) {
        hs.sort(function (a, b) {
          return a - b;
        });
        o.glyphHeight = hs[(hs.length - 1) >> 1];
      }
    }
    return o;
  }

  /* ============================================================
   * 6. 组件 → 行
   * ============================================================ */

  /**
   * 把组件合并成文字行。
   * 合并条件：垂直重叠 > 60% 且水平间距 < 1.6 × 行高。
   *
   * 水平间距限制不能省：规格表上"标签 …… 数值"常常在同一水平线上，
   * 中间隔着一大片空白，无限制合并会把整行表格横着连成一条超长"文字行"，
   * 送进 OCR 时框内一半是空白，识别质量反而下降。
   */
  function componentsToLines(comps, opts) {
    const o = opts || {};
    const ovNeed = num(o.overlap, 0.6);
    const gapFactor = num(o.gapFactor, 1.6);
    const items = comps.slice().sort(function (a, b) {
      return a.y - b.y || a.x - b.x;
    });
    const used = new Array(items.length).fill(false);
    const lines = [];

    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const first = items[i];
      let x = first.x;
      let y = first.y;
      let x1 = first.x + first.w;
      let y1 = first.y + first.h;
      let ink = num(first.ink, 0);
      let count = 1;

      let grew = true;
      let guard = 0;
      while (grew && guard < 60) {
        grew = false;
        guard++;
        for (let j = 0; j < items.length; j++) {
          if (used[j]) continue;
          const b = items[j];
          const bx1 = b.x + b.w;
          const by1 = b.y + b.h;
          const ov = Math.min(y1, by1) - Math.max(y, b.y);
          const minH = Math.min(y1 - y, b.h);
          if (!(ov > ovNeed * minH)) continue;
          const gapX = Math.max(0, Math.max(x - bx1, b.x - x1));
          const lineH = Math.max(y1 - y, b.h);
          if (gapX > gapFactor * lineH) continue;
          used[j] = true;
          count++;
          x = Math.min(x, b.x);
          y = Math.min(y, b.y);
          x1 = Math.max(x1, bx1);
          y1 = Math.max(y1, by1);
          ink += num(b.ink, 0);
          grew = true;
        }
      }

      const lw = Math.max(1, x1 - x);
      const lh = Math.max(1, y1 - y);
      lines.push({
        x: x,
        y: y,
        w: lw,
        h: lh,
        ink: ink,
        density: ink / (lw * lh),
        count: count,
      });
    }

    lines.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > Math.max(a.h, b.h) * 0.6) return a.y - b.y;
      return a.x - b.x;
    });
    return lines;
  }

  /* ============================================================
   * 7. 行 → 区域
   * ============================================================ */

  /**
   * 行聚类成区域，交给 PZUtil.groupBoxesIntoBlocks（同一套几何逻辑，别写第二份）。
   *
   * 区域数超上限时不是"砍掉多余的"（砍掉就是丢字，正是用户最痛的地方），
   * 而是逐步放大间距阈值重新聚类：宁可区域大一点、请求粗一点，
   * 也不能让某段文字根本没被送进识别流程。
   */
  function linesToRegions(lines, opts) {
    const o = opts || {};
    const U = util();
    if (!lines || !lines.length) return [];

    const maxRegions = Math.max(1, Math.round(num(o.maxRegions, 40)));
    let vGap = Math.max(2, Math.round(num(o.vGap, 14)));
    let hGap = Math.max(4, Math.round(num(o.hGap, 40)));

    let blocks = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      blocks = U.groupBoxesIntoBlocks(lines, {
        vGap: vGap,
        hGap: hGap,
        alignTol: num(o.alignTol, 0.35),
      });
      if (blocks.length <= maxRegions) break;
      vGap = Math.round(vGap * 1.8);
      hGap = Math.round(hGap * 1.8);
    }

    const regions = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      // groupBoxesIntoBlocks 的 members 就是传进去的原始行对象，ink 直接可用
      const raw = b.members || [];
      const members = raw.map(function (m) {
        return { x: m.x, y: m.y, w: m.w, h: m.h };
      });
      const w = Math.max(1, b.w);
      const h = Math.max(1, b.h);
      let ink = 0;
      for (let k = 0; k < raw.length; k++) ink += num(raw[k].ink, 0);
      const density = ink / (w * h);
      regions.push({
        x: b.x,
        y: b.y,
        w: w,
        h: h,
        lines: members,
        ink: ink,
        density: density,
        score: scoreRegion(members.length, density, o),
      });
    }

    // 超出上限时才按 score 截断（正常情况下前面的"放大间距重聚类"已经解决了）
    let dropped = 0;
    if (regions.length > maxRegions) {
      const ranked = regions.slice().sort(function (a, b) {
        return b.score - a.score || b.ink - a.ink;
      });
      const keep = new Set(ranked.slice(0, maxRegions));
      dropped = regions.length - keep.size;
      for (let i = regions.length - 1; i >= 0; i--) {
        if (!keep.has(regions[i])) regions.splice(i, 1);
      }
    }
    regions.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > Math.max(a.h, b.h) * 0.5) return a.y - b.y;
      return a.x - b.x;
    });
    regions.dropped = dropped;
    return regions;
  }

  /**
   * 区域优先级：行数越多越像"一段正文"，墨密度越接近文字区间越可信。
   * 只在必须截断区域数时用到，不参与检测结果本身。
   */
  function scoreRegion(lineCount, density, opts) {
    const o = opts || {};
    const lo = num(o.minDensity, 0.06);
    const hi = num(o.maxDensity, 0.62);
    const densScore = density >= lo && density <= hi ? 1 : 0.35;
    const n = Math.max(1, Math.min(lineCount, 6));
    const s = 0.5 * densScore + 0.12 * n;
    return s > 1 ? 1 : s;
  }

  /* ============================================================
   * 8. 主入口
   * ============================================================ */

  function isImageLike(v) {
    return (
      !!v &&
      typeof v.width === "number" &&
      typeof v.height === "number" &&
      !!v.data &&
      typeof v.data.length === "number"
    );
  }

  /**
   * 拿到"检测用的缩小图"。
   * 画布走原生 drawImage（快），图像对象走纯 JS 面平均（Node 可测）。
   * 两者都保证 scale <= 1，返回的 scale 用于把坐标还原回原图。
   */
  function downscaleForDetect(source, maxSide) {
    const PZ = image();
    if (isImageLike(source)) {
      const img = PZ.downscaleImage(source, maxSide);
      return { img: img, scale: source.width > 0 ? img.width / source.width : 1 };
    }
    const c = PZ.downscale(source, maxSide);
    return {
      img: PZ.canvasToImage(c),
      scale: source.width > 0 ? c.width / source.width : 1,
    };
  }

  /**
   * 纯函数检测：输入 {width,height,data}，输出区域/行（坐标为输入的坐标）。
   * 单测直接调这个，不需要 canvas。
   */
  function detectImage(img, opts) {
    const t0 = now();
    const PZ = image();
    const o = resolveOpts(opts);
    const out = {
      width: img.width | 0,
      height: img.height | 0,
      regions: [],
      lines: [],
      stats: {
        scale: 1,
        components: 0,
        kept: 0,
        lines: 0,
        regions: 0,
        dropped: 0,
        charHeight: 0,
        dilateWidth: 0,
        ms: 0,
      },
    };
    if (out.width < 3 || out.height < 3) return out;

    // 1) 缩到长边 maxSide —— 检测不需要全分辨率，1600 已经足够看清 6px 的字，
    //    而且连通域的开销是像素数级别的，全分辨率跑 4000px 的图会慢十倍。
    const scaled = downscaleForDetect(img, o.maxSide);
    const small = scaled.img;
    const sw = small.width | 0;
    const sh = small.height | 0;
    out.stats.scale = scaled.scale;
    if (sw < 3 || sh < 3) return out;

    // 2) 二值化 → 清掉表格线/图框 → 估字高
    const gray = PZ.toGray(small);
    const raw0 = binarizeForDetect(gray, sw, sh, o);
    const maxH = Math.max(
      o.minLineHeight + 1,
      Math.round(sh * num(o.maxLineHeightRatio, 0.28))
    );
    const estOpts = { minLineHeight: o.minLineHeight, maxLineHeight: maxH };
    const est0 = estimateTextHeight(raw0, sw, sh, estOpts);
    // 先清大块实心墨（深色面板/色卡），再清细长表格线，最后用干净掩膜重新估字高
    const solid = removeSolidBlobs(raw0, sw, sh, {
      charHeight: est0,
      minThickness: o.solidMinThickness,
      thicknessFactor: o.solidThicknessFactor,
      maxThicknessRatio: o.solidMaxThicknessRatio,
    });
    const raw = removeLongLines(solid, sw, sh, {
      charHeight: est0,
      minLength: o.lineMinLength,
      lengthFactor: o.lineLengthFactor,
      thicknessFactor: o.lineThicknessFactor,
    });
    const charHeight =
      raw.removed > 0 || solid.removed > 0 ? estimateTextHeight(raw, sw, sh, estOpts) : est0;
    out.stats.charHeight = charHeight;
    out.stats.linePixelsRemoved = raw.removed;
    out.stats.blobPixelsRemoved = solid.removed;

    // 3) 水平膨胀 → 连通域
    const kw = dilateWidthFor(charHeight, o);
    out.stats.dilateWidth = kw;
    const dil = kw > 1 ? dilateBinary(raw, sw, sh, { kw: kw, kh: 1 }) : raw;
    const comps = connectedComponents(dil, sw, sh, { raw: raw });
    out.stats.components = comps.length;

    // 4) 组件过滤
    //    注意：组件层的高度下限放宽到 minLineHeight/2。
    //    行高是"从最高字母顶到最低字母底"，而单个字母（a、e、o）只有 x-height，
    //    大约是行高的 60%。用行高标准卡组件，会先把小写的、没有升降部的词整词丢掉。
    const filterOpts = {
      minLineHeight: Math.max(2, Math.round(o.minLineHeight * 0.5)),
      maxLineHeight: maxH,
      minDensity: o.minDensity,
      maxDensity: o.maxDensity,
      minAspect: o.minAspect,
      maxAspect: o.maxAspect,
      minRowCoverage: o.minRowCoverage,
      minInk: o.minInk,
      glyphHeight: charHeight,
      glyphMaxFactor: o.glyphMaxFactor,
      glyphExemptMaxSide: o.glyphExemptMaxSide,
      checkRows: true,
    };
    const keptComps = filterComponents(comps, filterOpts);
    out.stats.kept = keptComps.length;

    // 5) 组件 → 行 → 行过滤 → 区域
    const allLines = componentsToLines(keptComps, {
      overlap: o.lineOverlap,
      gapFactor: o.lineGapFactor,
    });
    const textLines = filterLines(allLines, {
      minLineHeight: o.minLineHeight,
      maxLineHeight: maxH,
      minDensity: o.minDensity,
      maxDensity: o.maxDensity,
      minAspect: o.minAspect,
      maxAspect: o.maxAspect,
      minInk: o.minInk,
      glyphHeight: charHeight,
      glyphMaxFactor: o.glyphMaxFactor,
      glyphExemptMaxSide: o.glyphExemptMaxSide,
      checkRows: false,
    });
    out.stats.lines = textLines.length;

    const regionBase = linesToRegions(textLines, {
      maxRegions: o.maxRegions,
      minDensity: o.minDensity,
      maxDensity: o.maxDensity,
      alignTol: o.blockAlignTol,
      // 区域聚类的间距按字高缩放：图上的字多大，行距/列距就多大，
      // 写死像素值会让小字图被拆得太碎、大字图被糊成一片。
      vGap: o.regionVGap || Math.max(6, Math.round(charHeight * 1.4)),
      hGap: o.regionHGap || Math.max(16, Math.round(charHeight * 4)),
    });
    out.stats.regions = regionBase.length;
    out.stats.dropped = regionBase.dropped || 0;

    // 6) 还原到原图坐标（1/scale），区域再外扩 regionPad
    const rect = util().toRect;
    const inv = 1 / (scaled.scale || 1);
    const pad = Math.max(0, Math.round(o.regionPad));

    out.lines = textLines.map(function (l) {
      const r = rect(l);
      return mapRect(r, inv, 0, out.width, out.height);
    });

    out.regions = regionBase.map(function (rg) {
      const r = rect(rg);
      const region = mapRect(r, inv, pad, out.width, out.height);
      region.lines = (rg.lines || []).map(function (l) {
        return mapRect(rect(l), inv, 0, out.width, out.height);
      });
      region.score = rg.score;
      region.ink = rg.ink;
      region.density = rg.density;
      return region;
    });

    out.stats.ms = Math.round((now() - t0) * 10) / 10;
    return out;
  }

  /** 检测尺度坐标 → 原图坐标，可选外扩 pad（pad 也在检测尺度上） */
  function mapRect(r, inv, pad, W, H) {
    const x0 = Math.max(0, Math.floor((r.x - pad) * inv));
    const y0 = Math.max(0, Math.floor((r.y - pad) * inv));
    const x1 = Math.min(W, Math.ceil((r.x + r.w + pad) * inv));
    const y1 = Math.min(H, Math.ceil((r.y + r.h + pad) * inv));
    return {
      x: x0,
      y: y0,
      w: Math.max(1, x1 - x0),
      h: Math.max(1, y1 - y0),
    };
  }

  /**
   * 主入口：接受 canvas，也接受 {width,height,data}（Node 单测用）。
   * 返回：
   * {
   *   width, height,
   *   regions: [{x,y,w,h,lines:[{x,y,w,h}],score,ink,density}],
   *   lines:   [{x,y,w,h}],
   *   stats:   {scale, components, kept, ms, ...}
   * }
   */
  function detect(source, opts) {
    if (!source) throw new Error("PZDetect.detect: 缺少输入图像");
    if (!isImageLike(source) && typeof source.width !== "number") {
      throw new Error("PZDetect.detect: 输入既不是 canvas 也不是图像对象");
    }
    const img = isImageLike(source) ? source : image().canvasToImage(source);
    return detectImage(img, opts);
  }

  global.PZDetect = {
    DEFAULTS: DEFAULTS,
    resolveOpts: resolveOpts,
    // 算法各步骤（单测逐段验证用）
    binarizeForDetect: binarizeForDetect,
    estimateTextHeight: estimateTextHeight,
    dilateWidthFor: dilateWidthFor,
    removeLongLines: removeLongLines,
    removeSolidBlobs: removeSolidBlobs,
    dilateBinary: dilateBinary,
    connectedComponents: connectedComponents,
    validateBox: validateBox,
    filterComponents: filterComponents,
    componentsToLines: componentsToLines,
    filterLines: filterLines,
    linesToRegions: linesToRegions,
    scoreRegion: scoreRegion,
    downscaleForDetect: downscaleForDetect,
    // 主入口
    detectImage: detectImage,
    detect: detect,
  };
})(typeof window !== "undefined" ? window : globalThis);
