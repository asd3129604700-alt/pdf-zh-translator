/**
 * PZImage — 图像预处理层
 *
 * 设计要点（为什么这样拆）：
 * 1. 纯函数核心：只吃 {width,height,data} 这种和 ImageData 同形状的对象、以及 TypedArray，
 *    返回 TypedArray / 普通对象，完全不碰 DOM。这样 Node 里能直接对算法做单测，
 *    不用装无头浏览器（沙箱里也装不了）。
 * 2. 画布适配层：只有真的需要 drawImage / putImageData 的函数才走 PZUtil.createCanvas，
 *    统一画布工厂，方便测试时注入假的 canvas。
 * 3. 中间计算一律 Float64Array / Float32Array：
 *    积分图的累加值最大到 255 * 1600 * 1200 ≈ 4.9e8，平方和到 1.2e11，
 *    用 Int32/Uint16 会静默溢出，溢出后的阈值是错的，而且错得很难查。
 * 4. 输出图像数据用 Uint8ClampedArray：JS 引擎自动做 0..255 钳位与四舍五入，
 *    省掉手写 clamp 的分支，也少一个出错点。
 *
 * 经典脚本（非 ES module），挂到 window.PZImage。
 */
(function (global) {
  "use strict";

  function util() {
    if (!global.PZUtil) {
      throw new Error("PZImage 依赖 PZUtil，请先加载 js/util.js");
    }
    return global.PZUtil;
  }

  function num(v, d) {
    return typeof v === "number" && isFinite(v) ? v : d;
  }

  /** 强制成奇数：局部窗口用偶数边长会有半个像素的偏心，阈值图上会出现错位的条纹 */
  function odd(v) {
    let n = Math.max(1, Math.round(v));
    if (n % 2 === 0) n++;
    return n;
  }

  function clampInt(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ============================================================
   * 纯函数：色彩 / 直方图 / 阈值
   * ============================================================ */

  /**
   * 转灰度。用 Rec.601 权重（0.299/0.587/0.114）。
   * 不用简单的 (r+g+b)/3：那个公式对蓝色通道权重过高，
   * 规格表上常见的浅蓝底、蓝色标注会被算得比实际暗很多，二值化时整片变墨。
   */
  function toGray(img) {
    const w = img.width | 0;
    const h = img.height | 0;
    const src = img.data;
    const out = new Uint8ClampedArray(Math.max(0, w * h));
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      out[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }
    return out;
  }

  /**
   * 积分图（前缀和）。返回 (w+1)*(h+1) 的数组，第 0 行/列全 0，
   * 这样任意矩形求和都是 4 次减法，不用写边界分支。
   *
   * sq（平方和）默认一起算：Otsu 用不到，但 Sauvola 之类的"均值+标准差"阈值需要它，
   * 而且两遍循环合并成一遍比之后再扫一遍便宜。opts.sq === false 可以跳过（检测路径用不到）。
   */
  function integral(gray, w, h, opts) {
    w = w | 0;
    h = h | 0;
    const wantSq = !(opts && opts.sq === false);
    const stride = w + 1;
    const sum = new Float64Array(stride * (h + 1));
    const sq = wantSq ? new Float64Array(stride * (h + 1)) : null;
    for (let y = 0; y < h; y++) {
      const srcRow = y * w;
      const curRow = (y + 1) * stride;
      const prevRow = y * stride;
      let rowSum = 0;
      let rowSq = 0;
      for (let x = 0; x < w; x++) {
        const v = gray[srcRow + x];
        rowSum += v;
        sum[curRow + x + 1] = sum[prevRow + x + 1] + rowSum;
        if (wantSq) {
          rowSq += v * v;
          sq[curRow + x + 1] = sq[prevRow + x + 1] + rowSq;
        }
      }
    }
    return { sum: sum, sq: sq, w: w, h: h };
  }

  /**
   * 全局 Otsu 阈值。
   * 注意：全局阈值在"彩色底/渐变底"的规格表上会整片失效，
   * 所以检测主线用的是 adaptiveThreshold，这里保留 Otsu 主要用于
   * ① 判断图像极性（深底浅字还是浅底深字）② 单测里做基线对比。
   */
  function otsu(gray) {
    const hist = new Float64Array(256);
    const n = gray.length;
    if (!n) return 128;
    for (let i = 0; i < n; i++) hist[gray[i] | 0]++;
    let totalSum = 0;
    for (let t = 0; t < 256; t++) totalSum += t * hist[t];

    let sumB = 0;
    let wB = 0;
    let best = 0;
    let bestVar = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = n - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (totalSum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) {
        bestVar = between;
        best = t;
      }
    }
    // 完全单色的图（比如整张白纸）会得到 bestVar === 0；
    // 这时返回 128 而不是 0，避免把"没有直方图结构"误当成"全黑"。
    return bestVar > 0 ? best : 128;
  }

  /**
   * 局部自适应二值化：threshold = 局部均值 - C，返回 0/1（1 = 墨）。
   *
   * 为什么不用全局阈值：规格表常有彩色底、渐变底、深色面板，
   * 全局阈值只会在"大多数像素是浅色"的前提下成立，一旦底色变化就整片失效。
   * 局部均值天然跟随底色起伏，只要"字比它周围一圈更暗"就能被标成墨。
   *
   * 已知短板（务必知道）：纯局部均值法对"大面积实心暗块"的内部会失效
   * —— 块内部每个像素的局部均值也是暗的，于是块内部反而不被判成墨。
   * js/detect.js 的 binarizeForDetect 用"细窗口 ∪ 粗窗口"两套阈值来补这个洞。
   *
   * o: { window, C, integral }  window 为奇数边长；integral 可复用外部算好的积分图。
   */
  function adaptiveThreshold(gray, w, h, o) {
    o = o || {};
    w = w | 0;
    h = h | 0;
    const win = odd(Math.min(num(o.window, 15), Math.max(1, Math.min(w, h))));
    const C = num(o.C, 10);
    const ig =
      o.integral && o.integral.w === w && o.integral.h === h
        ? o.integral
        : integral(gray, w, h, { sq: false });
    const sum = ig.sum;
    const stride = w + 1;
    const r = (win - 1) >> 1;
    const out = new Uint8Array(Math.max(0, w * h));

    for (let y = 0; y < h; y++) {
      const y0 = y - r < 0 ? 0 : y - r;
      const y1 = y + r > h - 1 ? h - 1 : y + r;
      const rowA = y0 * stride;
      const rowB = (y1 + 1) * stride;
      const rows = y1 - y0 + 1;
      const srcRow = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r > w - 1 ? w - 1 : x + r;
        const area = rows * (x1 - x0 + 1);
        // 边界用"部分窗口"求均值：比补零/镜像更简单，且边界一圈本来也少有正文字
        const s =
          sum[rowB + x1 + 1] - sum[rowB + x0] - sum[rowA + x1 + 1] + sum[rowA + x0];
        if (gray[srcRow + x] < s / area - C) out[srcRow + x] = 1;
      }
    }
    return out;
  }

  /* ============================================================
   * 纯函数：滤波 / 清晰度
   * ============================================================ */

  var _tmpBlur = null;

  /**
   * 可分离盒式模糊，跑 n 遍 ≈ 高斯。返回 Float32Array（不钳位，供后续运算使用）。
   * 用滑动窗口而不是每个像素重算窗口和：O(n) 而不是 O(n*r)，r=2、n=2 时差别不大，
   * 但 radius 一大（比如做背景估计）就是几十倍的差距。
   */
  function boxBlurGray(gray, w, h, r, n) {
    w = w | 0;
    h = h | 0;
    r = Math.max(0, Math.round(num(r, 1)));
    n = Math.max(1, Math.round(num(n, 1)));
    const size = w * h;
    let src = new Float32Array(size);
    for (let i = 0; i < size; i++) src[i] = gray[i];
    if (r === 0 || !size) return src;

    if (!_tmpBlur || _tmpBlur.length < size) _tmpBlur = new Float32Array(size);
    const tmp = _tmpBlur.subarray(0, size);
    const div = 2 * r + 1;

    for (let pass = 0; pass < n; pass++) {
      // 水平
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[row + clampInt(k, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = acc / div;
          acc +=
            src[row + clampInt(x + r + 1, 0, w - 1)] -
            src[row + clampInt(x - r, 0, w - 1)];
        }
      }
      // 垂直（读 tmp 写 src）
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[clampInt(k, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          src[y * w + x] = acc / div;
          acc +=
            tmp[clampInt(y + r + 1, 0, h - 1) * w + x] -
            tmp[clampInt(y - r, 0, h - 1) * w + x];
        }
      }
    }
    return src;
  }

  /**
   * 反锐化掩膜（unsharp mask）：out = gray + amount * (gray - blur)。
   *
   * 为什么必须有这一步：客户给的电子截图很多是缩放过或 JPEG 压过的，
   * 字边缘是灰的（不是黑白跳变）。原实现只做了全局直方图拉伸，
   * 拉伸是单调映射，边缘的灰度落差并没有变大，字该糊还是糊；
   * 双线性放大更糟，等于把糊边插值得更宽。
   * 反锐化掩膜才真正把边缘的落差推大，是"让 Tesseract 看清小字"的关键一步。
   *
   * o: { radius, amount, threshold }
   * threshold 用来抑制噪点：只有落差超过它的像素才放大，
   * 否则 JPEG 块效应会被一并放大成"假笔画"。
   */
  function unsharpGray(gray, w, h, o) {
    o = o || {};
    const radius = Math.max(1, Math.round(num(o.radius, 2)));
    const amount = num(o.amount, 0.8);
    const threshold = Math.max(0, num(o.threshold, 0));
    const size = (w | 0) * (h | 0);
    const out = new Uint8ClampedArray(Math.max(0, size));
    if (!size) return out;
    if (amount <= 0) {
      for (let i = 0; i < size; i++) out[i] = gray[i];
      return out;
    }
    const blur = boxBlurGray(gray, w, h, radius, 1);
    for (let i = 0; i < size; i++) {
      const diff = gray[i] - blur[i];
      out[i] =
        threshold > 0 && (diff < 0 ? -diff : diff) < threshold
          ? gray[i]
          : gray[i] + amount * diff;
    }
    return out;
  }

  /**
   * 拉普拉斯方差 —— 清晰度指标，越大越锐。
   * 用 4 邻域核 [0,1,0; 1,-4,1; 0,1,0]：对"边缘陡不陡"敏感，
   * 而糊图的边缘是缓坡，二阶差分接近 0，方差自然很小。
   * 边界一圈跳过（补零会在图边造出一圈假的高响应，把糊图误判成锐图）。
   */
  function laplacianVariance(gray, w, h) {
    w = w | 0;
    h = h | 0;
    if (w < 3 || h < 3) return 0;
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const lap =
          4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap;
        sum2 += lap * lap;
        n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sum2 / n - mean * mean;
  }

  /** 墨像素占比。用于快速判断一张图/一个框是否"几乎全是墨"。 */
  function inkRatio(bin) {
    if (!bin || !bin.length) return 0;
    let c = 0;
    for (let i = 0; i < bin.length; i++) if (bin[i]) c++;
    return c / bin.length;
  }

  /** 反相灰度。深底浅字的图先反相，后续统一按"深墨浅底"处理。 */
  function invertGray(gray) {
    const out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = 255 - gray[i];
    return out;
  }

  /* ============================================================
   * 纯函数：缩放
   *
   * 为什么要自己写而不是都用 drawImage：
   * detect 的输入在 Node 单测里是"图像对象"而不是画布，
   * 检测流程必须能全程不碰 DOM；而且缩小用面平均（area average）
   * 比 drawImage 的双线性更能保住细笔画 —— 双线性只取 4 个采样点，
   * 1px 的笔画在 2 倍缩小时会被直接跳过，字就凭空消失了。
   * ============================================================ */

  function resizeImage(img, tw, th) {
    tw = Math.max(1, Math.round(tw));
    th = Math.max(1, Math.round(th));
    const sw = img.width | 0;
    const sh = img.height | 0;
    const src = img.data;
    const out = new Uint8ClampedArray(tw * th * 4);
    if (!sw || !sh) return { width: tw, height: th, data: out };

    const down = tw < sw || th < sh;
    const xRatio = sw / tw;
    const yRatio = sh / th;

    if (down) {
      for (let ty = 0; ty < th; ty++) {
        const y0 = Math.min(sh - 1, Math.floor(ty * yRatio));
        const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((ty + 1) * yRatio)));
        for (let tx = 0; tx < tw; tx++) {
          const x0 = Math.min(sw - 1, Math.floor(tx * xRatio));
          const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((tx + 1) * xRatio)));
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let n = 0;
          for (let y = y0; y < y1; y++) {
            let p = (y * sw + x0) * 4;
            for (let x = x0; x < x1; x++, p += 4) {
              r += src[p];
              g += src[p + 1];
              b += src[p + 2];
              a += src[p + 3];
              n++;
            }
          }
          const q = (ty * tw + tx) * 4;
          out[q] = r / n;
          out[q + 1] = g / n;
          out[q + 2] = b / n;
          out[q + 3] = a / n;
        }
      }
      return { width: tw, height: th, data: out };
    }

    // 放大用双线性（保持灰度连续，避免块状锯齿）
    for (let ty = 0; ty < th; ty++) {
      const sy = sh > 1 ? ((ty + 0.5) * yRatio - 0.5) : 0;
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
      const y1 = Math.min(sh - 1, y0 + 1);
      const wy = Math.max(0, Math.min(1, sy - y0));
      for (let tx = 0; tx < tw; tx++) {
        const sx = sw > 1 ? ((tx + 0.5) * xRatio - 0.5) : 0;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
        const x1 = Math.min(sw - 1, x0 + 1);
        const wx = Math.max(0, Math.min(1, sx - x0));
        const p00 = (y0 * sw + x0) * 4;
        const p01 = (y0 * sw + x1) * 4;
        const p10 = (y1 * sw + x0) * 4;
        const p11 = (y1 * sw + x1) * 4;
        const q = (ty * tw + tx) * 4;
        for (let c = 0; c < 4; c++) {
          const top = src[p00 + c] + (src[p01 + c] - src[p00 + c]) * wx;
          const bot = src[p10 + c] + (src[p11 + c] - src[p10 + c]) * wx;
          out[q + c] = top + (bot - top) * wy;
        }
      }
    }
    return { width: tw, height: th, data: out };
  }

  /** 只缩不放：返回图像对象。maxSide <= 0 表示不缩。 */
  function downscaleImage(img, maxSide) {
    const w = img.width | 0;
    const h = img.height | 0;
    const long = Math.max(w, h);
    const limit = num(maxSide, 0);
    if (!(limit > 0) || long <= limit) {
      return { width: w, height: h, data: img.data };
    }
    const s = limit / long;
    return resizeImage(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  }

  /* ============================================================
   * 画布适配层
   * ============================================================ */

  function canvasToImage(canvas) {
    const ctx = util().ctx2d(canvas);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function imageToCanvas(img) {
    const U = util();
    const c = U.createCanvas(img.width, img.height);
    const ctx = U.ctx2d(c);
    let id = ctx.createImageData ? ctx.createImageData(img.width, img.height) : null;
    if (!id) {
      if (typeof ImageData !== "function") {
        throw new Error("当前环境不支持 ImageData");
      }
      id = new ImageData(img.width, img.height);
    }
    id.data.set(img.data);
    ctx.putImageData(id, 0, 0);
    return c;
  }

  /**
   * 只缩不放，返回画布。
   * 走 drawImage 而不是纯 JS 缩放：浏览器里这一步是原生实现（有 SIMD / GPU 路径），
   * 比 JS 循环快一个数量级，检测前把 4000px 的图缩到 1600px 全靠它。
   */
  function downscale(canvas, maxSide) {
    const U = util();
    const w = canvas.width | 0;
    const h = canvas.height | 0;
    const long = Math.max(w, h);
    const limit = num(maxSide, 0);
    if (!(limit > 0) || long <= limit) return canvas;
    const s = limit / long;
    const dw = Math.max(1, Math.round(w * s));
    const dh = Math.max(1, Math.round(h * s));
    const c = U.createCanvas(dw, dh);
    const ctx = U.ctx2d(c);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, w, h, 0, 0, dw, dh);
    return c;
  }

  /**
   * 灰度拉伸：把 [lo, hi] 百分位线性映射到 [0, 255]，但增益设上限。
   * 上限很关键：整张图接近纯白时 lo≈hi，无限制的拉伸会把 JPEG 噪声
   * 放大成"满屏墨点"，反而害了后续二值化。
   */
  function grayStretch(gray, opts) {
    opts = opts || {};
    const loP = num(opts.loPercentile, 0.02);
    const hiP = num(opts.hiPercentile, 0.98);
    const maxGain = num(opts.maxGain, 1.6);
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
    const n = gray.length || 1;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let t = 0; t < 256; t++) {
      acc += hist[t];
      if (acc / n >= loP) {
        lo = t;
        break;
      }
    }
    acc = 0;
    for (let t = 0; t < 256; t++) {
      acc += hist[t];
      if (acc / n >= hiP) {
        hi = t;
        break;
      }
    }
    if (hi - lo < 8) return gray;
    let gain = 255 / (hi - lo);
    if (gain > maxGain) gain = maxGain;
    const out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - lo) * gain;
    return out;
  }

  /**
   * 先提亮（灰度拉伸）再反锐化，返回画布。
   * 顺序不能反：糊图的边缘落差本来就小，如果整体又偏灰（比如 60..200），
   * 反锐化推出来的落差还是落在中间灰阶里，仍不是黑白边缘。
   * 先把对比拉开，再推边缘，字才是真的"清晰"。
   */
  function sharpenCanvas(canvas, o) {
    o = o || {};
    const img = canvasToImage(canvas);
    let gray = toGray(img);
    if (o.stretch !== false) gray = grayStretch(gray, o);
    gray = unsharpGray(gray, img.width, img.height, {
      radius: num(o.radius, 2),
      amount: num(o.amount, 0.8),
      threshold: num(o.threshold, 0),
    });
    return grayImageToCanvas(gray, img.width, img.height);
  }

  function grayImageToCanvas(gray, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      const v = gray[p];
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    return imageToCanvas({ width: w, height: h, data: data });
  }

  /**
   * 清晰度评估，0..1（越大越锐）。
   * 用拉普拉斯方差过一条饱和曲线归一化：
   * 绝对数值和图像尺寸/内容强相关（大图边缘多、方差天然大），
   * 直接拿来当阈值不通用；归一化之后"要不要锐化"的判断才稳定。
   * 500 这个尺度是经验值：黑白分明的文字图 lv 通常几百到几千，
   * 被缩放过/JPEG 压过的小字图通常只有几十。
   */
  function measureSharpness(canvas) {
    const img = canvasToImage(canvas);
    const gray = toGray(img);
    const lv = laplacianVariance(gray, img.width, img.height);
    return lv / (lv + 500);
  }

  /**
   * OCR 前的准备：放大 → 反锐化掩膜 → 可选自适应二值化。
   *
   * 针对"像素干净但边缘不锐利"的截图：
   * - 小字在整图里一个字符只有 5~8px，识别引擎基本认不出，先放大到 16~32px；
   * - 放大本身不会增加信息，所以紧跟一次反锐化，把糊掉的笔画边缘拉回来；
   * - 锐化强度按清晰度自动决定：本来就锐的图过度锐化会在笔画外侧产生白色光晕，
   *   光晕会跟相邻笔画黏在一起，OCR 反而更差。
   * - 输出灰度图：OCR 只用亮度，彩色信息是干扰，而且体积更小。
   */
  function prepareForOcr(canvas, o) {
    o = o || {};
    const U = util();
    const zoom = Math.max(0.25, Math.min(4, num(o.zoom, 2)));
    let amount = typeof o.amount === "number" ? o.amount : null;
    if (o.sharpen === false) amount = 0;
    if (amount == null) {
      const sharp = measureSharpness(canvas);
      amount = sharp < 0.35 ? 0.9 : sharp < 0.6 ? 0.6 : 0.3;
    }

    let src = canvas;
    if (Math.abs(zoom - 1) > 0.01) {
      const dw = Math.max(1, Math.round(canvas.width * zoom));
      const dh = Math.max(1, Math.round(canvas.height * zoom));
      const c = U.createCanvas(dw, dh);
      const ctx = U.ctx2d(c);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, dw, dh);
      src = c;
    }

    const img = canvasToImage(src);
    let gray = toGray(img);
    if (amount > 0) {
      gray = unsharpGray(gray, img.width, img.height, {
        radius: num(o.radius, 2),
        amount: amount,
        threshold: num(o.threshold, 0),
      });
    }
    if (o.binarize) {
      const bin = adaptiveThreshold(gray, img.width, img.height, {
        window: o.window,
        C: num(o.C, 10),
      });
      const bw = new Uint8ClampedArray(gray.length);
      for (let i = 0; i < bin.length; i++) bw[i] = bin[i] ? 0 : 255;
      gray = bw;
    }
    return grayImageToCanvas(gray, img.width, img.height);
  }

  global.PZImage = {
    // 纯函数
    toGray: toGray,
    integral: integral,
    otsu: otsu,
    adaptiveThreshold: adaptiveThreshold,
    boxBlurGray: boxBlurGray,
    unsharpGray: unsharpGray,
    laplacianVariance: laplacianVariance,
    inkRatio: inkRatio,
    invertGray: invertGray,
    grayStretch: grayStretch,
    resizeImage: resizeImage,
    downscaleImage: downscaleImage,
    // 画布适配层
    canvasToImage: canvasToImage,
    imageToCanvas: imageToCanvas,
    downscale: downscale,
    sharpenCanvas: sharpenCanvas,
    prepareForOcr: prepareForOcr,
    measureSharpness: measureSharpness,
  };
})(typeof window !== "undefined" ? window : globalThis);
