/**
 * PZPdf — pdf.js 文字层提取 / 页面渲染 / jsPDF 导出
 *
 * 本模块**只负责「渲染原始页面」**。中文排版与覆盖在 PZOverlay.render 里，
 * 导出前由调用方把 canvas 交给 PZOverlay 处理。
 * 之所以要拆开：原实现把覆盖逻辑写在 pdf-engine.js（renderPageComposed），
 * 图片路径又另写一套（image-engine.overlayLines），两套字号策略不一致，
 * 同一份资料走 PDF 和走图片会得到不同的排版——这是排版问题的总根源。
 *
 * 三个必须守住的约定：
 *   1. **坐标系唯一**：对外一律「左上角原点、x 向右、y 向下、点单位」。
 *      pdf.js 的 transform 是左下角原点、y 向上，必须在 extractPage 内部换算掉。
 *      原实现把 `canvas.height - (line.y + line.h) * scale` 这种换算散落在渲染函数里，
 *      每处都得重新推一遍符号，是排版 bug 的温床。
 *   2. **页面尺寸保持原样**：画布只是提供像素分辨率，不决定 PDF 页面大小。
 *      原实现的 `k = 1600 / pxMax` 把大画布缩小贴到页面上，等效 DPI 反被压到 100 出头。
 *   3. **中文是栅格化的**，所以必须 PNG 无损嵌入；换成 JPEG 中文笔画会发虚。
 */
(function (global) {
  "use strict";

  const PDFJS_WORKER =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const FONT_STACK =
    '"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",SimHei,sans-serif';

  // 字形的基线上下比例：基线以上 0.85 字高、以下 0.30 字高，合计 1.15。
  // 用固定比例而不是读字体度量，是因为 pdf.js 的 text item 不带 ascent/descent，
  // 而这个比例足够覆盖常见西文字体的可见范围。
  const ASCENT = 0.85;
  const DESCENT = 0.3;

  function util() {
    const u = global.PZUtil;
    if (!u || typeof u.createCanvas !== "function") {
      throw new Error("PZPdf 依赖 js/util.js（PZUtil），请先加载它");
    }
    return u;
  }

  /** PDF 渲染倍率：优先取配置，配置缺失时退到一个保守值 */
  function defaultRenderScale() {
    const cfg = global.PZConfig;
    if (cfg && cfg.LIMITS && cfg.LIMITS.pdfRenderScale) return cfg.LIMITS.pdfRenderScale;
    return 2.5;
  }

  /* ============================================================
   * 加载
   * ============================================================ */

  function setWorkerSrc(src) {
    if (!global.pdfjsLib) throw new Error("pdf.js 未加载（需要先引入 pdf.min.js）");
    global.pdfjsLib.GlobalWorkerOptions.workerSrc = src || PDFJS_WORKER;
  }

  async function loadDocument(arrayBuffer) {
    if (!global.pdfjsLib) throw new Error("pdf.js 未加载（需要先引入 pdf.min.js）");
    if (!arrayBuffer) throw new Error("loadDocument 需要 ArrayBuffer");
    setWorkerSrc();
    // 不缓存、不共享 worker：多份文件来回切换时共享 worker 会串状态
    const loadingTask = global.pdfjsLib.getDocument({
      data: arrayBuffer,
      isEvalSupported: false,
    });
    return await loadingTask.promise;
  }

  /* ============================================================
   * 文字层
   * ============================================================ */

  /**
   * 清理 Illustrator / pdf.js 留下的连字占位符。
   * Illustrator 导出的 PDF 会把 fi / fl / ffi 拆成 "/fi" 这种字形名，
   * 不清掉就会在译文里冒出一堆斜杠。
   */
  function cleanPdfText(s) {
    if (!s) return "";
    return String(s)
      .replace(/\/f_/g, "f")
      .replace(/\/_\//g, "")
      .replace(/\/ffl/g, "ffl")
      .replace(/\/ff/g, "ff")
      .replace(/\/fi/g, "fi")
      .replace(/\/fl/g, "fl")
      .replace(/\uFFFD/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * 2x3 仿射矩阵相乘，约定与 pdf.js 的 Util.transform 一致（行向量 [a b c d e f]）。
   * 自己实现而不是调用 pdfjsLib.Util，是为了让本文件在缺少 Util 的场景下也能算。
   */
  function matrixMul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  /**
   * 单个 text item → 外接框（左上角原点、点单位）。
   *
   * 单位说明（很关键，弄错会把框宽放大 fontSize 倍）：
   *   - extractPage 一律用 getViewport({scale:1})，此时「设备空间」与「页面点」是 1:1；
   *   - item.width 就是这一段的横向advance，单位是点（已经含了 fontSize），
   *     所以**不能**再乘 m[0]（m[0] 本身就是 fontSize × 字宽缩放）；
   *   - 前进方向取 (m[0], m[1]) 的单位向量，这样页面旋转 90° 时也是对的；
   *   - 字高取 hypot(m[2], m[3])，等于变换后的 fontSize。
   */
  function itemToBox(item, viewport) {
    const tx = (item && item.transform) || [1, 0, 0, 1, 0, 0];
    const base = viewport && viewport.transform ? viewport.transform : [1, 0, 0, -1, 0, 0];
    const m = matrixMul(base, tx);
    const raw = cleanPdfText(item && item.str);
    const fontHeight = Math.hypot(m[2], m[3]) || Math.abs(Number(item && item.height)) || 10;

    let advance = Number(item && item.width);
    if (!isFinite(advance) || advance <= 0) {
      // 少数 PDF 的 item.width 是 0（字形宽度缺失），用字高估一个下限，
      // 宁可框宽一点也不要退化成 0 宽（0 宽的框在覆盖阶段会被当成噪声丢掉）
      advance = Math.max(fontHeight * 0.5, (raw ? raw.length : 1) * fontHeight * 0.5);
    }

    let dx = m[0];
    let dy = m[1];
    const dl = Math.hypot(dx, dy);
    if (!dl) {
      dx = 1;
      dy = 0;
    } else {
      dx /= dl;
      dy /= dl;
    }

    const x0 = m[4];
    const y0 = m[5]; // 基线起点（左上角原点，y 向下）
    const x1 = x0 + dx * advance;
    const y1 = y0 + dy * advance;

    // 字形的「上方向」在设备坐标里就是 (m[2], m[3]) 的单位向量：
    // 普通页面上它是 (0, -1)，即屏幕上的向上，正好抵掉 pdf.js 的 y 翻转。
    let ux = m[2];
    let uy = m[3];
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;

    const rise = fontHeight * ASCENT;
    const drop = fontHeight * DESCENT;
    const xs = [x0 + ux * rise, x0 - ux * drop, x1 + ux * rise, x1 - ux * drop];
    const ys = [y0 + uy * rise, y0 - uy * drop, y1 + uy * rise, y1 - uy * drop];
    const minX = Math.min.apply(null, xs);
    const minY = Math.min.apply(null, ys);

    return {
      x: minX,
      y: minY,
      w: Math.max.apply(null, xs) - minX,
      h: Math.max.apply(null, ys) - minY,
      fontHeight: fontHeight,
      baseY: (y0 + y1) / 2, // 只在 groupItems 内部用于「同一基线」判断
      raw: raw,
    };
  }

  /** 相邻两段之间该不该补空格：靠间距和原串的首尾空白判断，不无脑加 */
  function needSpace(prev, next) {
    if (!prev || !next) return false;
    if (/\s$/.test(prev.raw) || /^\s/.test(next.raw)) return false;
    const gap = next.x - (prev.x + prev.w);
    return gap > Math.max(1.2, Math.min(prev.fontHeight, next.fontHeight) * 0.18);
  }

  /**
   * 按基线把 text item 合并成行，并拼出可读的整行文字。
   * 同一基线的多段（PDF 里一个单词常常被拆成好几段）必须合并，
   * 否则翻译是逐段进行的，术语和语序全乱。
   */
  function groupItems(items, viewport) {
    const boxes = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      if (!it || !it.str) continue;
      const box = itemToBox(it, viewport);
      if (box.w <= 0 || box.h <= 0 || !box.raw) continue;
      boxes.push(box);
    }

    // 左上角原点、y 向下：y 小的在上面，所以是升序
    boxes.sort(function (a, b) {
      if (Math.abs(a.baseY - b.baseY) > 3) return a.baseY - b.baseY;
      return a.x - b.x;
    });

    const lines = [];
    const used = new Array(boxes.length).fill(false);

    for (let i = 0; i < boxes.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const parts = [boxes[i]];
      const line = {
        x: boxes[i].x,
        y: boxes[i].y,
        w: boxes[i].w,
        h: boxes[i].h,
        fontHeight: boxes[i].fontHeight,
        baseY: boxes[i].baseY,
      };

      let grew = true;
      let guard = 0;
      while (grew && guard < 200) {
        grew = false;
        guard++;
        for (let j = 0; j < boxes.length; j++) {
          if (used[j]) continue;
          const b = boxes[j];
          // 同一基线：基线差不超过 0.35 字高（不同字号混排时用较大的一方）
          const tol = Math.max(3, Math.max(line.fontHeight, b.fontHeight) * 0.35);
          if (Math.abs(b.baseY - line.baseY) > tol) continue;
          // 水平相邻：b 落在 line 的左右邻近范围内
          const nearRight = b.x < line.x + line.w + Math.max(12, line.fontHeight * 1.2);
          const nearLeft = b.x + b.w > line.x - Math.max(8, line.fontHeight);
          if (!nearRight || !nearLeft) continue;
          used[j] = true;
          parts.push(b);
          // 先算右/下边界再更新 x/y：否则新 x 变小之后，
          // "line.x + line.w" 已经不是原来的右边界了，合并出来的行宽会莫名变窄
          const right = Math.max(line.x + line.w, b.x + b.w);
          const bottom = Math.max(line.y + line.h, b.y + b.h);
          line.x = Math.min(line.x, b.x);
          line.y = Math.min(line.y, b.y);
          line.w = right - line.x;
          line.h = bottom - line.y;
          line.fontHeight = Math.max(line.fontHeight, b.fontHeight);
          grew = true;
        }
      }

      parts.sort(function (p, q) {
        return p.x - q.x;
      });
      let text = "";
      for (let k = 0; k < parts.length; k++) {
        if (k > 0 && needSpace(parts[k - 1], parts[k])) text += " ";
        text += parts[k].raw;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push({
        x: line.x,
        y: line.y,
        w: line.w,
        h: line.h,
        fontHeight: line.fontHeight,
        text: text,
        parts: parts.length,
      });
    }

    lines.sort(function (a, b) {
      return a.y - b.y || a.x - b.x;
    });
    return { lines: lines, boxes: boxes };
  }

  /**
   * 提取一页的文字与版面。坐标**已经换成左上角原点、点单位**，
   * 外部拿到就能直接乘渲染倍率用，不需要任何 y 翻转。
   */
  async function extractPage(doc, pageNo) {
    if (!doc || typeof doc.getPage !== "function") {
      throw new Error("extractPage 需要 pdf.js 的文档对象（loadDocument 的返回值）");
    }
    const n = Math.max(1, Math.floor(Number(pageNo) || 1));
    const page = await doc.getPage(n);
    // 一律用 scale=1 取 viewport：此时 widthPt/heightPt 就是 PDF 页面点数
    // （且已经算进 /Rotate，旋转页拿到的也是「看上去」的宽高）
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const grouped = groupItems(content.items, viewport);
    return {
      page: page,
      pageNo: n,
      widthPt: viewport.width,
      heightPt: viewport.height,
      lines: grouped.lines,
      stats: { items: content.items.length, lines: grouped.lines.length },
    };
  }

  /* ============================================================
   * 渲染（只渲染原始页面，不画中文）
   * ============================================================ */

  /**
   * 渲染原始页面到画布。尺寸 = widthPt × scale。
   * **这里不画任何中文**：中文覆盖统一由 PZOverlay.render(canvas, items) 负责，
   * 保证 PDF 与图片两条路走同一套排版引擎。
   */
  async function renderPage(page, scale) {
    const U = util();
    if (!page || typeof page.render !== "function") {
      throw new Error("renderPage 需要 pdf.js 的 page 对象");
    }
    const s = Number(scale) > 0 ? Number(scale) : defaultRenderScale();
    const viewport = page.getViewport({ scale: s });
    const canvas = U.createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = U.ctx2d(canvas);
    // 先铺白：有些 PDF 的页面背景是透明的，不铺白导出 PNG 会是黑底
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport, background: "#ffffff" }).promise;
    return canvas;
  }

  /* ============================================================
   * 导出
   * ============================================================ */

  /** 等效 DPI：画布像素数 ÷ 页面点数 × 72。仅仅用于日志与自检 */
  function effectiveDpi(canvas, wPt) {
    if (!canvas || !wPt) return 0;
    return (72 * canvas.width) / wPt;
  }

  /**
   * 决定这一页的 PDF 页面尺寸（点）。
   *
   * 修复的 bug：原实现 k = 1600 / pxMax，把画布**缩小**贴到页面上，
   * 页面尺寸跟着画布走，等效 DPI = 72 × pxMax / 1600 —— 画布越大反而越糊。
   * 正确做法是：页面尺寸来自 PDF 本身（extractPage 的 widthPt/heightPt），
   * 画布只贡献像素，等效 DPI = 72 × 渲染倍率。
   */
  function pageSizeFor(canvas, given, scale) {
    if (given && Number(given.wPt) > 0 && Number(given.hPt) > 0) {
      const wPt = Number(given.wPt);
      const hPt = Number(given.hPt);
      return { wPt: wPt, hPt: hPt, dpi: effectiveDpi(canvas, wPt), exact: true };
    }
    if (Number(scale) > 0) {
      // 调用方没有给原始页面尺寸，但告诉了渲染倍率 → 也能反推出真实点数
      const s = Number(scale);
      return {
        wPt: canvas.width / s,
        hPt: canvas.height / s,
        dpi: 72 * s,
        exact: true,
      };
    }
    // 都没有：按 72dpi 认定「1 像素 = 1 点」。宽高比必然是对的，
    // 但绝对尺寸很可能与原始 PDF 不同，所以下面会 console.warn。
    return { wPt: canvas.width, hPt: canvas.height, dpi: 72, exact: false };
  }

  /**
   * 多张画布 → 一个多页 jsPDF。
   * opts: { pageSizes: [{wPt,hPt}], scale }
   */
  function canvasesToPdf(canvases, opts) {
    opts = opts || {};
    if (!canvases || !canvases.length) throw new Error("没有可导出的页面");
    const jsPDF = global.jspdf && global.jspdf.jsPDF;
    if (!jsPDF) throw new Error("jsPDF 未加载（需要先引入 jspdf.umd.min.js）");

    const pageSizes = opts.pageSizes || null;
    if (!pageSizes || !pageSizes.length) {
      console.warn(
        "[PZPdf] canvasesToPdf 未收到 pageSizes，退化到按 72dpi 换算页面尺寸：" +
          "宽高比正确，但页面点数可能与原始 PDF 不一致。请调用方传入 extractPage 的 widthPt/heightPt。"
      );
    }

    let pdf = null;
    let warned = false;
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i];
      if (!canvas) throw new Error("第 " + (i + 1) + " 页画布为空");
      const size = pageSizeFor(canvas, pageSizes && pageSizes[i], opts.scale);
      if (!size.exact && !warned) {
        console.warn(
          "[PZPdf] 第 " + (i + 1) + " 页缺少原始尺寸，按 " + canvas.width + "×" + canvas.height +
            " 点（72dpi）出页，等效 DPI 实测 " + size.dpi.toFixed(1)
        );
        warned = true;
      }
      const orientation = size.wPt >= size.hPt ? "landscape" : "portrait";
      if (i === 0) {
        pdf = new jsPDF({
          orientation: orientation,
          unit: "pt",
          format: [size.wPt, size.hPt],
          compress: true,
        });
      } else {
        pdf.addPage([size.wPt, size.hPt], orientation);
      }
      // 必须 PNG：中文是 PZOverlay 栅格化画上去的，JPEG 的块效应会把笔画糊成一团，
      // 小字号尤其明显。PNG 无损，代价只是文件略大。
      const data = canvas.toDataURL("image/png");
      pdf.addImage(data, "PNG", 0, 0, size.wPt, size.hPt, undefined, "FAST");
    }
    return pdf;
  }

  function download(pdf, filename) {
    if (!pdf) throw new Error("download 需要 jsPDF 实例");
    pdf.save(filename || "translated.pdf");
  }

  global.PZPdf = {
    // 契约接口
    loadDocument: loadDocument,
    extractPage: extractPage,
    renderPage: renderPage,
    canvasesToPdf: canvasesToPdf,
    download: download,
    FONT_STACK: FONT_STACK,
    // 供调用方/自检使用的细粒度接口
    cleanPdfText: cleanPdfText,
    itemToBox: itemToBox,
    groupItems: groupItems,
    setWorkerSrc: setWorkerSrc,
    defaultRenderScale: defaultRenderScale,
    pageSizeFor: pageSizeFor,
    effectiveDpi: effectiveDpi,
    PDFJS_WORKER: PDFJS_WORKER,
  };
})(typeof window !== "undefined" ? window : globalThis);
