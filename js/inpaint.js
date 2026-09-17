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
        // 主色占环上样本的比例。接近 1 说明底色确实纯，填出来看不出痕迹；
        // 偏低说明这块压在图案/渐变上，纯色填充会是一块看得见的色块。
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
    // 相比 repair（掩膜 + 扩散）：这里不需要"哪些连通块是线条/图案"的判断，
    // 因为判据就是"与背景色不同"，文字必然满足、纯色背景必然不满足，
    // 少了一层会判错的启发式 —— 之前"擦完还有残留"就是栽在那层判断上。
    if (mode === "ink") {
      const d = img.data;
      const iw = img.width;
      const n = innerW * innerH;
      const thr = opts.inkThreshold == null ? 44 : opts.inkThreshold;
      const thr2 = thr * thr;

      const bin = new Uint8Array(n);
      let inkN = 0;
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          const o = ((inner.y + y) * iw + (inner.x + x)) * 4;
          const dr = d[o] - fillColor[0];
          const dg = d[o + 1] - fillColor[1];
          const db = d[o + 2] - fillColor[2];
          if (dr * dr + dg * dg + db * db > thr2) {
            bin[y * innerW + x] = 1;
            inkN++;
          }
        }
      }

      // 横穿/纵穿整块的连通域是表格线、边框这类背景结构，不能擦。
      // 判据用"是否同时贴到两条相对的边"，比宽高比更稳：
      // 一行密排的小字也可能很宽，但它不会同时贴住左右边界。
      const keep = new Uint8Array(n);
      eachComponent(bin, innerW, innerH, function (c) {
        const spansX = c.x0 <= 0 && c.x1 >= innerW - 1;
        const spansY = c.y0 <= 0 && c.y1 >= innerH - 1;
        if (spansX || spansY) return;
        for (let k = 0; k < c.pixels.length; k++) keep[c.pixels[k]] = 1;
      });

      // 膨胀 1px：抗锯齿最外圈的颜色可能刚好卡在阈值内，不扩一圈会留灰边
      const grown = keep.slice();
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          const p = y * innerW + x;
          if (keep[p]) continue;
          let hit = 0;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= innerH) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= innerW) continue;
              if (keep[ny * innerW + nx]) {
                hit = 1;
                break;
              }
            }
          }
          if (hit) grown[p] = 1;
        }
      }

      let erased = 0;
      for (let y = 0; y < innerH; y++) {
        for (let x = 0; x < innerW; x++) {
          if (!grown[y * innerW + x]) continue;
          const o = ((inner.y + y) * iw + (inner.x + x)) * 4;
          d[o] = fillColor[0];
          d[o + 1] = fillColor[1];
          d[o + 2] = fillColor[2];
          erased++;
        }
      }

      dstCtx.putImageData(img, ox0, oy0);
      return {
        ok: true,
        mode: "ink",
        fill: fillColor,
        coverage: dom.coverage,
        unique: dom.unique,
        inkCount: inkN,
        // 擦掉的像素占整块的比例。太小说明"这块里没有找到与背景色不同的字"
        // （可能背景色认错了，或者字色与底色太接近），调用方应据此提醒。
        ratio: erased / n,
        erased: erased,
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
  };
})(typeof window !== "undefined" ? window : globalThis);
