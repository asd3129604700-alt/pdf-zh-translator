/**
 * PZInpaint — 去字：文字掩膜 + 无缝修复
 *
 * 为什么不用"刷一块底色补丁"（原来就是这么做的，用户反馈"涂抹做得太差"）：
 *
 *  1. **补丁和背景对不上**。刷的是从框外采样出来的颜色，一旦背景是渐变、
 *     色块边界、纹理或图案，补丁就是一块看得见的涂抹痕迹。
 *  2. **会擦掉不该擦的东西**。原来的做法是"扩张到边缘干净为止"，
 *     可文字旁边常常有表格线、边框、图案描边 —— 这些永远不会"干净"，
 *     于是扩张一路顶到上限，**把一大块表格线或图案擦了**。
 *  3. 参考项目 ShinobuTranslator 用的是**文字掩膜 + 神经网络修复**
 *     （`aot_inpaint_512.onnx`，见它的 models.json）。这里不去下载 22MB 模型，
 *     而是用同一套思路的轻量版：**掩膜只覆盖文字像素**，再用拉普拉斯扩散
 *     把掩膜区域无缝补回去 —— 扩散解在边界上与周围严格连续，
 *     所以不会出现可见的矩形或色差。
 *
 * 三个关键取舍：
 *  · 长条状结构（表格线/边框）**不进掩膜**：它们是背景，应当保留。
 *  · 比字形大得多的连通块（图案、色块）也**不进掩膜**：那是插画不是字。
 *  · 掩膜向外膨胀 2px，把抗锯齿边一起吃掉，否则会留一圈灰边。
 */
(function (global) {
  "use strict";

  const U = global.PZUtil;
  if (!U) throw new Error("PZInpaint 依赖 PZUtil，请先加载 js/util.js");

  /* ============================================================
   * 纯函数：只吃 {width, height, data}，Node 里可单测
   * ============================================================ */

  function luminanceOf(data, n) {
    const lum = new Float32Array(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return lum;
  }

  function medianOf(arr) {
    const a = Array.from(arr).sort(function (x, y) {
      return x - y;
    });
    return a.length ? a[a.length >> 1] : 0;
  }

  /**
   * 把"封闭空洞"补进掩膜。
   *
   * 为什么必须做：上面那个局部均值阈值**标不出实心块的内部** ——
   * 黑字笔画内部的局部均值也是黑的，条件 `gray < mean - C` 不成立，
   * 于是只有字的边缘一圈被标成墨，**笔画内部留着没被擦**，
   * 结果就是"擦过的字还看得见个影子"。（检测模块当初也踩过同一个坑。）
   *
   * 做法：从图像四条边界的非墨像素洪泛，没被淹到的就是封闭空洞 → 补进掩膜。
   * 顺带一个好处：大色块/图案的内部被填实后，会变成一个完整的大连通块，
   * 于是能被"比字形大得多"的判据正确排除掉，不会把图案涂掉。
   */
  function fillHoles(bin, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = [];

    for (let x = 0; x < w; x++) {
      if (!bin[x]) {
        outside[x] = 1;
        stack.push(x);
      }
      const b = (h - 1) * w + x;
      if (!bin[b]) {
        outside[b] = 1;
        stack.push(b);
      }
    }
    for (let y = 0; y < h; y++) {
      const l = y * w;
      if (!bin[l]) {
        outside[l] = 1;
        stack.push(l);
      }
      const r = y * w + w - 1;
      if (!bin[r]) {
        outside[r] = 1;
        stack.push(r);
      }
    }

    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) {
        const q = p - 1;
        if (!bin[q] && !outside[q]) {
          outside[q] = 1;
          stack.push(q);
        }
      }
      if (x < w - 1) {
        const q = p + 1;
        if (!bin[q] && !outside[q]) {
          outside[q] = 1;
          stack.push(q);
        }
      }
      if (y > 0) {
        const q = p - w;
        if (!bin[q] && !outside[q]) {
          outside[q] = 1;
          stack.push(q);
        }
      }
      if (y < h - 1) {
        const q = p + w;
        if (!bin[q] && !outside[q]) {
          outside[q] = 1;
          stack.push(q);
        }
      }
    }

    let added = 0;
    for (let i = 0; i < bin.length; i++) {
      if (!bin[i] && !outside[i]) {
        bin[i] = 1;
        added++;
      }
    }
    return added;
  }

  /** 局部窗口边长：取奇数。默认约为短边的 1/6，比单个字大一圈 */
  function oddWindow(requested, w, h) {
    const short = Math.max(1, Math.min(w, h));
    let n = requested == null ? Math.round(short / 6) : requested;
    n = Math.max(9, Math.min(n, short));
    if (n % 2 === 0) n++;
    return n;
  }

  /**
   * 连通域标记（显式栈，不用递归）。
   * 每标完一个就回调一次，让调用方决定保留还是丢弃 —— 不用把整张标签图存下来。
   */
  function eachComponent(bin, w, h, onComponent) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const pixels = [];
    let next = 0;

    for (let start = 0; start < bin.length; start++) {
      if (!bin[start] || labels[start]) continue;
      next++;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = next;
      pixels.length = 0;

      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;

      while (sp > 0) {
        const p = stack[--sp];
        pixels.push(p);
        const px = p % w;
        const py = (p / w) | 0;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;

        if (px > 0) {
          const q = p - 1;
          if (bin[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
        if (px < w - 1) {
          const q = p + 1;
          if (bin[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
        if (py > 0) {
          const q = p - w;
          if (bin[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
        if (py < h - 1) {
          const q = p + w;
          if (bin[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
      }

      onComponent({
        pixels: pixels.slice(),
        x0: x0,
        y0: y0,
        x1: x1,
        y1: y1,
        w: x1 - x0 + 1,
        h: y1 - y0 + 1,
        area: pixels.length,
      });
    }
  }

  /**
   * 生成文字掩膜。
   *
   * img: {width, height, data}（RGBA，会读不会改）
   * opts: { contrast, dilate, bgLum }
   *
   * 返回 { mask: Uint8Array(0/1), count, kept, dropped, bgLum, glyphHeight }
   */
  function buildMask(img, opts) {
    opts = opts || {};
    const w = img.width;
    const h = img.height;
    const n = w * h;
    const contrast = opts.contrast == null ? 38 : opts.contrast;
    const dilate = opts.dilate == null ? 2 : opts.dilate;

    const lum = luminanceOf(img.data, n);
    const bgLum = opts.bgLum == null ? medianOf(lum) : opts.bgLum;

    // 墨迹判定优先用**局部自适应阈值**（PZImage 里那份，检测阶段已经在用）。
    //
    // 为什么不只用"与全局中位亮度差 > C"：背景一有渐变或色带，
    // 渐变的暗端本身就会离全局中位很远，被整片误判成墨 ——
    // 掩膜于是覆盖大半个矩形，等于又变回"刷一块补丁"。
    // 局部阈值只看局部均值，平滑的背景变化不会被当成字。
    const ink = new Uint8Array(n);
    let inkCount = 0;
    const IMG = global.PZImage;
    const canAdaptive =
      IMG &&
      typeof IMG.adaptiveThreshold === "function" &&
      typeof IMG.toGray === "function" &&
      w >= 8 &&
      h >= 8;

    if (canAdaptive) {
      let gray = IMG.toGray(img);
      // adaptiveThreshold 只标"暗于局部均值"的像素；底色偏暗时先把灰度反相，
      // 这样浅色字也能被标出来。
      if (bgLum < 95 && typeof IMG.invertGray === "function") {
        const inv = IMG.invertGray(gray);
        if (inv) gray = inv;
      }
      const window = oddWindow(opts.window, w, h);
      const bin = IMG.adaptiveThreshold(gray, w, h, { window: window, C: contrast });
      const src = bin && bin.ink ? bin.ink : bin;
      if (src && src.length >= n) {
        for (let i = 0; i < n; i++) {
          if (src[i]) {
            ink[i] = 1;
            inkCount++;
          }
        }
      }
    }

    // 退化路径：没有 PZImage 时用全局中位阈值
    if (!inkCount) {
      for (let i = 0; i < n; i++) {
        if (Math.abs(lum[i] - bgLum) > contrast) {
          ink[i] = 1;
          inkCount++;
        }
      }
    }

    // 补上封闭空洞（实心笔画内部）—— 不做的话擦完还留个影子
    inkCount += fillHoles(ink, w, h);

    const comps = [];
    eachComponent(ink, w, h, function (c) {
      comps.push(c);
    });

    // 估计字高：取"面积加权"的中位高度，避免被几个大色块带偏。
    // 先用连通块高度排序取中位，忽略过大的块。
    let glyphHeight = 0;
    if (comps.length) {
      const hs = comps
        .map(function (c) {
          return c.h;
        })
        .sort(function (a, b) {
          return a - b;
        });
      glyphHeight = hs[hs.length >> 1];
    }
    // 没有参照物时给个宽松值，别把正常字误判成"大块"
    const maxGlyphH = Math.max(6, glyphHeight * 3 + 2);
    const maxGlyphArea = Math.max(64, glyphHeight * glyphHeight * 24);

    const keep = new Uint8Array(comps.length);
    let kept = 0;
    let dropped = 0;

    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      const longSide = Math.max(c.w, c.h);
      const shortSide = Math.max(1, Math.min(c.w, c.h));
      const ratio = longSide / shortSide;
      const fill = c.area / (c.w * c.h);

      // 长条状 + 实心 → 表格线 / 边框 / 下划线，是背景，保留不动
      const isLine = (ratio >= 8 && fill >= 0.7) || (shortSide <= 2 && ratio >= 5);
      // 比字形大得多的块 → 图案 / 色块 / 插画，不是字
      const isBlob = c.h > maxGlyphH || c.area > maxGlyphArea;

      if (isLine || isBlob) {
        dropped++;
        continue;
      }
      keep[i] = 1;
      kept++;
    }

    // 把保留的连通块画进掩膜
    const mask = new Uint8Array(n);
    for (let i = 0; i < comps.length; i++) {
      if (!keep[i]) continue;
      const px = comps[i].pixels;
      for (let k = 0; k < px.length; k++) mask[px[k]] = 1;
    }

    // 膨胀：把抗锯齿边缘一起吃掉，否则原文会留一圈灰边。
    // 十字 + 对角（切比雪夫距离），一次扩张就是一圈。
    for (let pass = 0; pass < dilate; pass++) {
      const prev = mask.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (prev[p]) continue;
          let hit = 0;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              if (prev[ny * w + nx]) {
                hit = 1;
                break;
              }
            }
          }
          if (hit) mask[p] = 1;
        }
      }
    }

    let count = 0;
    for (let i = 0; i < n; i++) if (mask[i]) count++;

    return {
      mask: mask,
      count: count,
      kept: kept,
      dropped: dropped,
      inkCount: inkCount,
      bgLum: bgLum,
      glyphHeight: glyphHeight,
    };
  }

  /**
   * 无缝修复：把掩膜区域的像素补成周围像素的调和插值。
   *
   * 用 Gauss-Seidel 逐点松弛（每次取四邻域平均），解出来的是拉普拉斯方程的解 ——
   * **在边界上与周围严格连续**，所以不会出现可见的矩形或色差，
   * 渐变底也能自然接上；图案上则会变成一块平滑过渡（比刷错颜色的补丁好得多）。
   *
   * 迭代次数按掩膜尺度缩放：细笔画几十次就收敛，大块要几百次。
   * 前后向交替扫描能明显加快信息传播。
   *
   * img 会被就地修改，返回 { iterations, pixelCount }。
   */
  function inpaint(img, mask, opts) {
    opts = opts || {};
    const w = img.width;
    const h = img.height;
    const d = img.data;

    // 收集掩膜像素
    const idx = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
    if (!idx.length) return { iterations: 0, pixelCount: 0 };

    // 先给掩膜一个**初始猜测**：取矩形内未掩膜像素的中位色。
    //
    // 不做这一步的话，掩膜里还是原文的黑色，扩散要从"全黑"慢慢爬到背景色，
    // 十几像素厚的笔画要几百次迭代才收敛（实测跑满上限还差 2%）。
    // 有了这个初值，几十次就够 —— 大图上这是几倍的差距。
    if (opts.seedFromBackground !== false) {
      const rs = [];
      const gs = [];
      const bs = [];
      for (let p = 0; p < w * h; p++) {
        if (mask[p]) continue;
        const o = p * 4;
        rs.push(d[o]);
        gs.push(d[o + 1]);
        bs.push(d[o + 2]);
      }
      if (rs.length) {
        const mid = function (a) {
          a.sort(function (x, y) {
            return x - y;
          });
          return a[a.length >> 1];
        };
        const mr = mid(rs);
        const mg = mid(gs);
        const mb = mid(bs);
        for (let k = 0; k < idx.length; k++) {
          const o = idx[k] * 4;
          d[o] = mr;
          d[o + 1] = mg;
          d[o + 2] = mb;
        }
      }
    }

    // 迭代次数不能按包围盒拍 —— 那是错的：
    // 三个分散的字，包围盒跨度很大，但每个字只有十几像素厚，
    // 收敛快慢由**厚度**决定而不是跨度。之前按跨度估出 59 次，
    // 结果字心只填到 204/255，留下一层灰影（"擦完还有残影"）。
    //
    // 所以改成：用 SOR 超松弛加速，并且**跑到收敛为止**（带上限）。
    // omega=1.85 在 Dirichlet 边界的 Laplace 问题上稳定，收敛快一个量级。
    const omega = opts.omega == null ? 1.85 : opts.omega;
    const maxIter = opts.maxIterations == null ? 600 : opts.maxIterations;
    const minIter = opts.minIterations == null ? 16 : opts.minIterations;
    const tol = opts.tolerance == null ? 0.4 : opts.tolerance;

    let used = 0;
    for (let it = 0; it < maxIter; it++) {
      const forward = it % 2 === 0;
      let maxDelta = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = forward ? idx[k] : idx[idx.length - 1 - k];
        const x = p % w;
        const y = (p / w) | 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let cnt = 0;
        if (x > 0) {
          const o = (p - 1) * 4;
          r += d[o];
          g += d[o + 1];
          b += d[o + 2];
          cnt++;
        }
        if (x < w - 1) {
          const o = (p + 1) * 4;
          r += d[o];
          g += d[o + 1];
          b += d[o + 2];
          cnt++;
        }
        if (y > 0) {
          const o = (p - w) * 4;
          r += d[o];
          g += d[o + 1];
          b += d[o + 2];
          cnt++;
        }
        if (y < h - 1) {
          const o = (p + w) * 4;
          r += d[o];
          g += d[o + 1];
          b += d[o + 2];
          cnt++;
        }
        if (!cnt) continue;

        const o = p * 4;
        const nr = d[o] + omega * (r / cnt - d[o]);
        const ng = d[o + 1] + omega * (g / cnt - d[o + 1]);
        const nb = d[o + 2] + omega * (b / cnt - d[o + 2]);
        const delta =
          Math.abs(nr - d[o]) + Math.abs(ng - d[o + 1]) + Math.abs(nb - d[o + 2]);
        if (delta > maxDelta) maxDelta = delta;
        d[o] = nr;
        d[o + 1] = ng;
        d[o + 2] = nb;
      }
      used = it + 1;
      // 收敛就停：继续跑只是浪费，而且大图上会很慢
      if (it + 1 >= minIter && maxDelta < tol * 3) break;
    }

    return { iterations: used, pixelCount: idx.length };
  }

  /* ============================================================
   * 背景主色：取"环上出现最多的那个颜色"
   * ============================================================ */

  /**
   * 找出出现次数最多的颜色（量化后统计）。
   *
   * 为什么用**众数**而不是中位数/均值：环上难免扫到一点别的东西
   * （相邻的图案、另一行字的边缘），中位数会被拉偏，均值更是被平均掉。
   * 众数问的是"这一圈里最常见的颜色是哪个"，那才是背景色。
   *
   * pixels: [[r,g,b], ...]
   * 返回 { color: [r,g,b], coverage: 0..1, unique: 桶数 }
   */
  function dominantColor(pixels, opts) {
    opts = opts || {};
    const step = opts.quantStep || 16; // 量化步长：抗 JPEG 噪声
    if (!pixels || !pixels.length) return { color: [255, 255, 255], coverage: 0, unique: 0 };

    const buckets = new Map();
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i];
      const key =
        ((c[0] / step) | 0) * 4096 + ((c[1] / step) | 0) * 64 + ((c[2] / step) | 0);
      let b = buckets.get(key);
      if (!b) {
        b = { n: 0, r: 0, g: 0, bl: 0 };
        buckets.set(key, b);
      }
      b.n++;
      b.r += c[0];
      b.g += c[1];
      b.bl += c[2];
    }

    let best = null;
    buckets.forEach(function (b) {
      if (!best || b.n > best.n) best = b;
    });
    return {
      color: [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.bl / best.n)],
      coverage: best.n / pixels.length,
      unique: buckets.size,
    };
  }

  /**
   * 找出"结构带"：整行（或整列）几乎铺满墨迹、而且**很薄**的连续带。
   *
   * 这是表格线、边框、下划线的形状特征，也是 ink 模式唯一要保护的东西。
   *
   * 为什么不再用"连通块是否跨到两条对边"：
   * 那一版在**字糊成一团**的图上会把整整一行文字连成一个跨边的连通块，
   * 于是被判成"表格线"、**整行一个字都没擦** ——
   * 这正是用户说的"有的去除不完整"。
   * 表格线真正的决定性特征是**薄**：一行字再糊也有 8~14px 厚，
   * 一条线（含边框）通常 1~4px，所以把"厚度 ≤ maxThick"作为硬条件。
   *
   * 用"整行/整列"而不是"连通块"还有一个好处：文字和线条粘在一起时
   * （字压着表格线、或字贴着边框），线条那一行照样被保护，字照样被擦掉。
   *
   * bin: Uint8Array(w*h) 的墨迹掩膜
   * 返回 { rows: Uint8Array(h), cols: Uint8Array(w) }
   */
  function findStructureBands(bin, w, h, opts) {
    opts = opts || {};
    const minFill = opts.minFill == null ? 0.85 : opts.minFill;
    const maxThick = opts.maxThick == null ? 6 : opts.maxThick;
    // 保护面积上限：一条带最多占整块的多少（按长度算）
    const maxShare = opts.maxShare == null ? 0.4 : opts.maxShare;

    const flags = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      const base = y * w;
      for (let x = 0; x < w; x++) if (bin[base + x]) c++;
      if (c >= w * minFill) flags[y] = 1;
    }
    const rows = new Uint8Array(h);
    markThinRuns(flags, rows, maxThick, Math.max(1, Math.round(h * maxShare)));

    flags.fill(0);
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let y = 0; y < h; y++) if (bin[y * w + x]) c++;
      if (c >= h * minFill) flags[x] = 1;
    }
    const cols = new Uint8Array(w);
    markThinRuns(flags, cols, maxThick, Math.max(1, Math.round(w * maxShare)));

    return { rows: rows, cols: cols };
  }

  /** 把 flags 里长度 ≤ maxThick 的连续段标进 out（总长度不超过 maxTotal） */
  function markThinRuns(flags, out, maxThick, maxTotal) {
    let start = -1;
    let total = 0;
    for (let i = 0; i <= flags.length; i++) {
      const on = i < flags.length && flags[i];
      if (on) {
        if (start < 0) start = i;
        continue;
      }
      if (start >= 0) {
        const len = i - start;
        if (len <= maxThick && total + len <= maxTotal) {
          for (let k = start; k < i; k++) out[k] = 1;
          total += len;
        }
        start = -1;
      }
    }
    return total;
  }

  /**
   * 采集矩形**外侧一环**的像素（不含矩形内部）。
   * 内外一起读一次，比多次 getImageData 便宜。
   */
  function collectRing(img, inner, ring) {
    const out = [];
    const d = img.data;
    const W = img.width;
    const H = img.height;
    for (let y = 0; y < H; y++) {
      const inY = y >= inner.y && y < inner.y + inner.h;
      for (let x = 0; x < W; x++) {
        if (inY && x >= inner.x && x < inner.x + inner.w) continue; // 矩形内部跳过
        // 只取紧贴矩形的几圈，太远的样本可能已经是别的东西了
        const dx = Math.max(inner.x - x, x - (inner.x + inner.w - 1), 0);
        const dy = Math.max(inner.y - y, y - (inner.y + inner.h - 1), 0);
        if (Math.max(dx, dy) > ring) continue;
        const o = (y * W + x) * 4;
        out.push([d[o], d[o + 1], d[o + 2]]);
      }
    }
    return out;
  }

  /* ============================================================
   * 高层入口：擦掉一块矩形里的原文
   * ============================================================ */

  /**
   * srcCtx: 读**原图**的上下文（必须是没被涂改过的）
   * dstCtx: 写结果的上下文（通常是正在画的那张画布）
   * rect:   {x, y, w, h} 画布像素坐标
   * opts:   { mode: "fill" | "repair", ringWidth, contrast, dilate, minMaskRatio }
   *
   * 两种模式：
   *  · **fill（默认，用户点名要的做法）**：采一圈背景主色，把整块**实心填掉**。
   *    优点是**保证零残留** —— 不做掩膜就没有"某个连通块被误判成图案、
   *    结果没擦掉"的风险。文字压在纯色/近似纯色底上时看不出任何痕迹。
   *  · **repair**：文字掩膜 + 无缝修复。背景是渐变、图案、纹理时更自然，
   *    但依赖掩膜判断得准；判错就会留残留。
   *
   * 为什么读写分开：掩膜与背景色都必须从**原图**取。如果从正在涂改的画布上读，
   * 前面画好的中文会被当成"文字"混进掩膜，然后被自己擦掉。
   *
   * 返回 { ok, mode, fill, coverage, maskCount?, filled?, iterations? }
   */
  function coverText(srcCtx, dstCtx, rect, opts) {
    opts = opts || {};
    const mode = opts.mode === "repair" ? "repair" : opts.mode === "fill" ? "fill" : "ink";
    const ring = opts.ringWidth == null ? 6 : opts.ringWidth;
    const W = srcCtx.canvas.width;
    const H = srcCtx.canvas.height;

    // 内矩形 = 要擦掉的区域；外矩形 = 内矩形 + 一圈，用来采背景色
    const ix0 = U.clamp(Math.floor(rect.x), 0, W);
    const iy0 = U.clamp(Math.floor(rect.y), 0, H);
    const ix1 = U.clamp(Math.ceil(rect.x + rect.w), ix0 + 1, W);
    const iy1 = U.clamp(Math.ceil(rect.y + rect.h), iy0 + 1, H);
    const innerW = ix1 - ix0;
    const innerH = iy1 - iy0;
    if (innerW < 3 || innerH < 3) return { ok: false, reason: "too-small" };

    const ox0 = U.clamp(ix0 - ring, 0, W);
    const oy0 = U.clamp(iy0 - ring, 0, H);
    const ox1 = U.clamp(ix1 + ring, ox0 + 1, W);
    const oy1 = U.clamp(iy1 + ring, oy0 + 1, H);

    let img;
    try {
      img = srcCtx.getImageData(ox0, oy0, ox1 - ox0, oy1 - oy0);
    } catch (e) {
      return { ok: false, reason: "read-failed" };
    }

    // 内矩形在外矩形里的相对位置
    const inner = { x: ix0 - ox0, y: iy0 - oy0, w: innerW, h: innerH };

    // ---------- 采背景主色 ----------
    const ringPixels = collectRing(img, inner, ring);
    const dom = dominantColor(ringPixels, { quantStep: opts.quantStep });
    const fillColor = opts.fillColor || dom.color;

    if (mode === "fill") {
      // 环上主色占比过低：底不是纯色（红条/彩底/邻行文字），
      // 整框刷主色会刷出难看的白块/色块，并盖掉旁边的字 —— 改回只擦墨迹。
      if (dom.coverage < 0.55) {
        return coverText(srcCtx, dstCtx, rect, Object.assign({}, opts, { mode: "ink" }));
      }
      const d = img.data;
      const iw = img.width;
      for (let y = inner.y; y < inner.y + inner.h; y++) {
        for (let x = inner.x; x < inner.x + inner.w; x++) {
          const o = (y * iw + x) * 4;
          d[o] = fillColor[0];
          d[o + 1] = fillColor[1];
          d[o + 2] = fillColor[2];
        }
      }
      dstCtx.putImageData(img, ox0, oy0);
      return {
        ok: true,
        mode: "fill",
        fill: fillColor,
        coverage: dom.coverage,
        unique: dom.unique,
        innerW: innerW,
        innerH: innerH,
      };
    }

    // ---------- ink：只把"和背景色不一样的像素"涂成背景色 ----------
    //
    // 这是用户点名的做法，也是三种里最贴合"把字擦掉"这个意图的：
    // 背景色既然能识别出来，就不用整块刷 —— 只动那些与背景色**不同**的像素。
    // 于是底色、图案、表格线全都原样不动，中文背后**不会有任何一块贴纸**。
    //
    // 判据是"与背景色的距离"，所以成败全在阈值和结构保护这两件事上：
    //  1) 阈值**自适应**：环上主色占比越高（底色越纯），越敢把阈值压低。
    //     纯底上压低阈值几乎没有代价 —— 那些像素本来就和底色差不多，
    //     涂成底色看不出区别；但它能把字边缘一圈浅灰（抗锯齿/JPEG 振铃）吃掉，
    //     修掉"去除不完整 / 留一层鬼影"。
    //  2) 结构保护改用"薄带"判据（findStructureBands）。上一版是"连通块跨到
    //     两条对边就保护"，在糊成一片的图上会把整行文字保护成"表格线"，
    //     结果那一行**完全没擦**。
    //  3) 灰边扩散：从掩膜出发，只要邻居"还不是纯底色"就再吃出去 1~2 圈。
    if (mode === "ink") {
      const d = img.data;
      const iw = img.width;
      const n = innerW * innerH;
      const fr = fillColor[0];
      const fg = fillColor[1];
      const fb = fillColor[2];

      // ---- 1) 每个像素到背景主色的距离 ----
      const dist = new Uint16Array(n);
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          const o = ((inner.y + y) * iw + (inner.x + x)) * 4;
          const dr = d[o] - fr;
          const dg = d[o + 1] - fg;
          const db = d[o + 2] - fb;
          dist[y * innerW + x] = Math.round(Math.sqrt(dr * dr + dg * dg + db * db));
        }
      }

      // ---- 2) 阈值自适应 ----
      const busyThr = opts.inkThreshold == null ? 44 : opts.inkThreshold;
      const flatThr = Math.min(busyThr, opts.inkThresholdFlat == null ? 16 : opts.inkThresholdFlat);
      const midThr = Math.min(busyThr, opts.inkThresholdMid == null ? 30 : opts.inkThresholdMid);
      const cov = dom.coverage || 0;
      const thr = cov >= 0.8 ? flatThr : cov >= 0.55 ? midThr : busyThr;

      const bin = new Uint8Array(n);
      let inkN = 0;
      for (let i = 0; i < n; i++) {
        if (dist[i] > thr) {
          bin[i] = 1;
          inkN++;
        }
      }

      // ---- 3) 保护结构带（表格线 / 边框 / 下划线）----
      const bands = findStructureBands(bin, innerW, innerH, {
        minFill: opts.lineFillRatio,
        maxThick: opts.lineMaxThickness,
      });
      let protectedRows = 0;
      for (let i = 0; i < innerH; i++) if (bands.rows[i]) protectedRows++;
      let protectedCols = 0;
      for (let i = 0; i < innerW; i++) if (bands.cols[i]) protectedCols++;

      // ---- 3b) 保护"明显不是字"的大块 ----
      //
      // 为什么必须有这一层：擦除范围是上游给的框，而框里**不保证只有字**
      // —— 实测一张装饰图，检测框里就套着整片插画（483×380、894×309）。
      // 判据只认"与底色不同"的话，插画会被整个涂成底色（等于在图里挖个白洞）。
      // 沿用 buildMask 里那套已经验证过的字形尺度判据：
      // 先取连通块高度的中位数当"字有多大"，再挑出比字大得多的块。
      const comps = [];
      eachComponent(bin, innerW, innerH, function (c) {
        comps.push(c);
      });
      // "字有多大"的参照物：优先用调用方给的原文单行高（PZOverlay 已经量过，
      // 那是最可靠的），拿不到才退回"连通块高度的中位数"。
      //
      // ⚠ 为什么不能只用中位数：块里只有一坨插画时，中位数就是那坨插画本身，
      // 于是"比字大得多"这个判据永远不成立，插画照样被涂掉。
      let glyphHeight = opts.glyphHeight > 0 ? opts.glyphHeight : 0;
      if (!glyphHeight) {
        const hs = comps
          .map(function (c) {
            return c.h;
          })
          .sort(function (a, b) {
            return a - b;
          });
        glyphHeight = hs.length ? hs[hs.length >> 1] : 0;
      }
      // 阈值比 buildMask 松一档：宁可漏保护一两个大块，也别把"糊成一团的多行字"
      // 当成插画保护下来（那正是用户说的"整块没擦"）。
      const blobH = Math.max(18, glyphHeight * (opts.blobHeightFactor || 4) + 8);

      // 逐像素保护掩膜：结构带（整行/整列）+ 大块
      const protect = new Uint8Array(n);
      for (let y = 0; y < innerH; y++) {
        if (!bands.rows[y]) continue;
        for (let x = 0; x < innerW; x++) protect[y * innerW + x] = 1;
      }
      for (let x = 0; x < innerW; x++) {
        if (!bands.cols[x]) continue;
        for (let y = 0; y < innerH; y++) protect[y * innerW + x] = 1;
      }
      let protectedBlobs = 0;
      let protectedStrips = 0;
      // 又细又长又实心的连通块也是线（不跨整块的那种：表格线只画到单元格边，
      // 或者一条下划线）。字形不可能是这个形状 —— 再小的字也有 8px 高。
      //
      // 卡得很死是有意的：形如"一行小字糊成一条"的连通块也是又长又实心，
      // 区别只在**厚度和实心度**（一行的厚度至少一个行高，实心度也远不到 0.85）。
      // 宁可漏保护一条粗边框，也不能把一行小字保护下来 —— 那正是用户的抱怨。
      const minStripLen = Math.max(24, glyphHeight * 3);
      const maxStripThick = Math.min(4, Math.max(2, opts.lineMaxThickness || 6));
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        // 细带已经保护过了，不要重复计数
        if (bands.rows[c.y0] && bands.rows[c.y1]) continue;
        // 判据只看**高度**，而且要求"比 4 行字还高"。
        //
        // 为什么不看面积：一行密排、糊成一条的文字连通块又宽又大，
        // 面积判据会把整行字保护下来 —— 那就绕回了"整行没擦"的老毛病
        // （实测一张装饰图，170×12 的文字行就栽在这上面）。
        // 只看高度的话，"一行字"永远等于一个行高，不可能被判成大块。
        if (c.h > blobH) {
          protectedBlobs++;
          const pxs = c.pixels;
          for (let k = 0; k < pxs.length; k++) protect[pxs[k]] = 1;
          continue;
        }
        const fill = c.area / Math.max(1, c.w * c.h);
        const horizontal = c.h <= maxStripThick && c.w >= minStripLen && fill >= 0.85;
        const vertical = c.w <= maxStripThick && c.h >= minStripLen && fill >= 0.85;
        if (horizontal || vertical) {
          protectedStrips++;
          const pxs = c.pixels;
          for (let k = 0; k < pxs.length; k++) protect[pxs[k]] = 1;
        }
      }

      const erase = new Uint8Array(n);
      let erased = 0;
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          const p = y * innerW + x;
          if (!bin[p] || protect[p]) continue;
          erase[p] = 1;
          erased++;
        }
      }

      // ---- 4) 灰边扩散 ----
      // 只沿着"还不是纯底色"的像素往外走，走固定圈数（默认 2）。
      // 不判模糊度、不做自适应迭代：圈数一多就会啃到图案上去。
      const haloGrow = opts.haloGrow == null ? 2 : opts.haloGrow;
      const haloDelta = Math.max(
        opts.haloDelta == null ? 14 : opts.haloDelta,
        Math.round(thr * 0.4)
      );
      let grown = erase;
      for (let step = 0; step < haloGrow; step++) {
        const next = grown.slice();
        let added = 0;
        for (let y = 0; y < innerH; y++) {
          for (let x = 0; x < innerW; x++) {
            const p = y * innerW + x;
            if (grown[p] || protect[p]) continue;
            if (dist[p] <= haloDelta) continue;
            if (
              (x > 0 && grown[p - 1]) ||
              (x < innerW - 1 && grown[p + 1]) ||
              (y > 0 && grown[p - innerW]) ||
              (y < innerH - 1 && grown[p + innerW])
            ) {
              next[p] = 1;
              added++;
            }
          }
        }
        grown = next;
        if (!added) break;
      }

      // ---- 5) 涂成背景色 ----
      let painted = 0;
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          if (!grown[y * innerW + x]) continue;
          const o = ((inner.y + y) * iw + (inner.x + x)) * 4;
          d[o] = fr;
          d[o + 1] = fg;
          d[o + 2] = fb;
          painted++;
        }
      }

      // ---- 6) 残墨统计 ----
      // 擦完还剩多少"明显不是底色"的像素（被保护的线条/插画不算）。这个数字是
      // 「去除不完整」唯一的客观依据 —— 之前那次翻车就是因为拿"边缘脏不脏"
      // 当指标，而擦掉表格线恰好能让那个数字变好看。
      const resDelta = opts.residualDelta == null ? 22 : opts.residualDelta;
      let residual = 0;
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          const p = y * innerW + x;
          if (grown[p] || protect[p]) continue;
          if (dist[p] > resDelta) residual++;
        }
      }

      dstCtx.putImageData(img, ox0, oy0);
      return {
        ok: true,
        mode: "ink",
        fill: fillColor,
        coverage: dom.coverage,
        unique: dom.unique,
        threshold: thr,
        inkCount: inkN,
        // 擦掉的像素占整块的比例。太小说明"这块里没有找到与背景色不同的字"
        // （可能背景色认错了，或者字色与底色太接近），调用方应据此提醒。
        ratio: erased / n,
        // 含灰边扩散后真正被涂掉的像素数
        erased: painted,
        residual: residual,
        residualRatio: residual / n,
        protectedRows: protectedRows,
        protectedCols: protectedCols,
        protectedBlobs: protectedBlobs,
        protectedStrips: protectedStrips,
        glyphHeight: glyphHeight,
        innerW: innerW,
        innerH: innerH,
      };
    }

    // ---------- repair：只擦文字像素，再用扩散补回去 ----------
    const built = buildMask(img, opts);
    const ratio = built.count / (innerW * innerH);
    if (built.count === 0 || ratio < (opts.minMaskRatio == null ? 0.004 : opts.minMaskRatio)) {
      return { ok: false, reason: "no-text-mask", maskCount: built.count, ratio: ratio };
    }

    const filled = inpaint(img, built.mask, opts);
    dstCtx.putImageData(img, ox0, oy0);

    return {
      ok: true,
      mode: "repair",
      fill: fillColor,
      coverage: dom.coverage,
      maskCount: built.count,
      ratio: ratio,
      kept: built.kept,
      dropped: built.dropped,
      filled: filled.pixelCount,
      iterations: filled.iterations,
      glyphHeight: built.glyphHeight,
    };
  }

  global.PZInpaint = {
    buildMask: buildMask,
    inpaint: inpaint,
    coverText: coverText,
    dominantColor: dominantColor,
    collectRing: collectRing,
    eachComponent: eachComponent,
    luminanceOf: luminanceOf,
    // 结构保护是纯逻辑，导出便于单测（"细带才算表格线"这条判据必须锁住：
    // 它一旦退回"跨边就保护"，糊字整行不擦的老问题就会回来）
    findStructureBands: findStructureBands,
    markThinRuns: markThinRuns,
  };
})(typeof window !== "undefined" ? window : globalThis);
