/**
 * 纯函数单测（Node 直接跑，不需要 DOM / 无头浏览器）
 *
 *   node test/run-tests.js
 *
 * 加载方式：这些 js 文件是"经典脚本 + IIFE"，会自己往 globalThis 上挂
 * PZUtil / PZImage / PZDetect，所以最省事的就是 eval 一下源码，
 * 然后直接用全局对象。不需要 module.exports，也不需要 mock DOM。
 *
 * 关于 PZUtil.createCanvas：Node 下它会抛错（没有 document），这是预期行为。
 * 本文件只测纯函数，画布适配层（downscale / prepareForOcr / sharpenCanvas …）
 * 留给浏览器里的 selftest.html 验证。
 *
 * 合成测试图说明（重要）：
 *   任务里建议"每行画 5 段 12px 宽的实心横条"来模拟文字。实心横条的
 *   墨密度 = 1.0，按本算法的设计它**就是**表格分隔线，会被墨密度上限
 *   （0.62）正确地排掉 —— 拿它当"文字"会因为参照物本身不像文字而误判算法。
 *   所以这里用"细笔画字形"（H/E/T/L/O/I，1px 笔画）来模拟真实文字，
 *   其墨密度落在 0.1~0.4，和真实英文行的实测密度一致；
 *   实心横条另开一个用例，专门验证它被当成分隔线排掉（这正是回归用例 3/4 的内容）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILES = ["js/util.js", "js/config.js", "js/imageproc.js", "js/detect.js"];
let missing = null;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    missing = missing || p;
    continue;
  }
  // 直接 eval：IIFE 会把接口挂到 globalThis
  eval(fs.readFileSync(p, "utf8"));
}
if (missing) {
  console.error("缺少文件：" + missing);
  process.exitCode = 1;
}

const U = globalThis.PZUtil;
const I = globalThis.PZImage;
const D = globalThis.PZDetect;

if (!missing && (!U || !I || !D)) {
  console.error("加载失败：PZUtil / PZImage / PZDetect 没有挂到 globalThis");
  process.exitCode = 1;
}

/* ============================================================
 * 断言与输出
 * ============================================================ */

let passed = 0;
let failed = 0;
const failures = [];

function section(title) {
  console.log("\n=== " + title + " ===");
}

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log("  [通过] " + label + (detail ? "  " + detail : ""));
  } else {
    failed++;
    failures.push(label);
    console.log("  [失败] " + label + (detail ? "  " + detail : ""));
  }
  return !!cond;
}

function near(actual, expected, tol, label, unit) {
  const good = Math.abs(actual - expected) <= tol;
  return ok(
    good,
    label,
    "实际 " + fmt(actual) + (unit || "") + "，期望 " + fmt(expected) + " ±" + tol
  );
}

function fmt(v) {
  return typeof v === "number" ? (Math.round(v * 100) / 100).toString() : String(v);
}

/* ============================================================
 * 合成测试图工具
 * ============================================================ */

function whiteImage(w, h) {
  return U.imageLike(w, h, 255);
}

function fillRect(img, x, y, w, h, v) {
  const W = img.width;
  const H = img.height;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * W + xx) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
}

function vbar(img, x, y, h) {
  fillRect(img, x, y, 1, h, 0);
}
function hbar(img, x, y, w) {
  fillRect(img, x, y, w, 1, 0);
}

/** 用 1px 细笔画画出类似字母的形状，尽量贴近真实字形的墨量分布 */
function drawGlyph(img, x, y, gw, gh, kind) {
  switch (kind) {
    case "H":
      vbar(img, x, y, gh);
      vbar(img, x + gw - 1, y, gh);
      hbar(img, x, y + (gh >> 1), gw);
      break;
    case "E":
      vbar(img, x, y, gh);
      hbar(img, x, y, gw - 2);
      hbar(img, x, y + (gh >> 1), gw - 3);
      hbar(img, x, y + gh - 1, gw - 2);
      break;
    case "T":
      hbar(img, x, y, gw);
      vbar(img, x + (gw >> 1), y, gh);
      break;
    case "L":
      vbar(img, x, y, gh);
      hbar(img, x, y + gh - 1, gw);
      break;
    case "O":
      vbar(img, x, y, gh);
      vbar(img, x + gw - 1, y, gh);
      hbar(img, x, y, gw);
      hbar(img, x, y + gh - 1, gw);
      break;
    default: // "I"
      vbar(img, x + (gw >> 1), y, gh);
      hbar(img, x, y, 3);
      hbar(img, x + gw - 3, y, 3);
      hbar(img, x, y + gh - 1, 3);
      hbar(img, x + gw - 3, y + gh - 1, 3);
      break;
  }
}

/**
 * 画一行"文字"。返回 {x,y,w,h}（= 真实墨迹外接框，用于和检测结果对比）。
 * spec: 形如 "HELLO"
 */
function drawText(img, x, y, spec, o) {
  o = o || {};
  const gw = o.glyphW || 7;
  const gh = o.glyphH || 10;
  const gap = o.gap == null ? 4 : o.gap;
  const pitch = gw + gap;
  const v = o.dark == null ? 0 : o.dark;
  for (let i = 0; i < spec.length; i++) {
    drawGlyph(img, x + i * pitch, y, gw, gh, spec[i]);
  }
  if (v !== 0) {
    // 需要非纯黑时再覆盖一遍（目前用不到，留着方便调试）
  }
  return { x: x, y: y, w: spec.length * pitch - gap, h: gh };
}

/** 统计框内真实墨像素占框面积的比例，用来展示"真实文字行"的墨密度 */
function boxInkDensity(img, box) {
  let ink = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] < 128) ink++;
    }
  }
  return ink / (box.w * box.h);
}

function linesNear(res, y, tol) {
  return res.lines.filter(function (l) {
    return Math.abs(l.y + l.h / 2 - y) <= tol;
  });
}

function boxesOverlap(a, b) {
  return U.intersectArea(a, b) > 0;
}

/* ============================================================
 * 1. 二值化 / Otsu
 * ============================================================ */

section("1. PZImage.toGray / otsu / adaptiveThreshold");
(function () {
  const img = whiteImage(240, 120);
  const truth = drawText(img, 20, 40, "HELLO", { glyphW: 7, glyphH: 10 });
  const gray = I.toGray(img);

  // toGray：纯黑 → 0，纯白 → 255
  ok(gray[0] === 255, "toGray 把白底映成 255", "实际 " + gray[0]);
  const blackIdx = (truth.y + 1) * img.width + truth.x;
  ok(gray[blackIdx] === 0, "toGray 把黑字映成 0", "实际 " + gray[blackIdx]);

  // 积分图：和暴力求和对比（矩形 y∈[10,30)、x∈[15,45)，右/下开区间）
  const ig = I.integral(gray, img.width, img.height);
  let brute = 0;
  for (let y = 10; y < 30; y++)
    for (let x = 15; x < 45; x++) brute += gray[y * img.width + x];
  const fast =
    ig.sum[30 * (img.width + 1) + 45] -
    ig.sum[30 * (img.width + 1) + 15] -
    ig.sum[10 * (img.width + 1) + 45] +
    ig.sum[10 * (img.width + 1) + 15];
  ok(fast === brute, "integral 的矩形求和与暴力求和一致", fast + " vs " + brute);

  // Otsu：这张合成图是纯双峰（0 和 255），Otsu 的阈值语义是"较暗那一类的最大灰度"，
  // 所以 t 会正好落在暗峰上，判墨要用 <=。
  const t = I.otsu(gray);
  let black = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] === 0) black++;
  let otsuInk = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] <= t) otsuInk++;
  ok(otsuInk === black, "otsu 在纯双峰图上恰好分出全部文字像素", otsuInk + "/" + black);
  console.log("      otsu 阈值 t=" + t + "（纯双峰图上落在暗峰，属正常）");
  ok(t <= 40, "otsu 阈值贴近暗峰（没有把白底误分进来）", "t=" + t);

  // 自适应阈值
  const bin = I.adaptiveThreshold(gray, img.width, img.height, { window: 15, C: 10 });
  let inkHit = 0;
  let bgFalse = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] === 0) {
      if (bin[i]) inkHit++;
    } else if (gray[i] === 255 && bin[i]) {
      bgFalse++;
    }
  }
  const recall = inkHit / black;
  ok(recall >= 0.98, "adaptiveThreshold 召回文字像素 ≥98%", (recall * 100).toFixed(1) + "%");
  ok(bgFalse === 0, "adaptiveThreshold 不把白底判成墨", "误判 " + bgFalse + " px");

  const ratio = I.inkRatio(bin);
  const trueRatio = black / gray.length;
  near(ratio, trueRatio, 0.01, "inkRatio 与真实墨占比一致");

  // 局部法在"彩色底/渐变底"上要能工作（全局阈值会在这里失效）
  const grad = whiteImage(240, 120);
  for (let y = 0; y < 120; y++) {
    const v = Math.round(120 + (y / 119) * 135); // 上下渐变底
    for (let x = 0; x < 240; x++) {
      const i = (y * 240 + x) * 4;
      grad.data[i] = v;
      grad.data[i + 1] = v;
      grad.data[i + 2] = v;
    }
  }
  const gBox = drawText(grad, 20, 50, "TEST", { glyphW: 7, glyphH: 10 });
  const gGray = I.toGray(grad);
  const gBin = I.adaptiveThreshold(gGray, 240, 120, { window: 15, C: 10 });
  let gInk = 0;
  let gTotal = 0;
  for (let y = gBox.y; y < gBox.y + gBox.h; y++) {
    for (let x = gBox.x; x < gBox.x + gBox.w; x++) {
      gTotal++;
      if (gBin[y * 240 + x]) gInk++;
    }
  }
  const gOtsu = I.otsu(gGray);
  let gOtsuInk = 0;
  for (let i = 0; i < gGray.length; i++) if (gGray[i] <= gOtsu) gOtsuInk++;
  ok(gInk > 0, "渐变底上局部阈值仍能标出墨", "字框内墨占比 " + (gInk / gTotal).toFixed(3));
  ok(
    gOtsuInk > gGray.length * 0.2,
    "同一张图上全局 Otsu 整片失效（说明为什么必须用局部阈值）",
    "全局阈值把 " + ((gOtsuInk / gGray.length) * 100).toFixed(1) + "% 的像素判成墨"
  );
})();

/* ============================================================
 * 2. 检测器能找到 6 行
 * ============================================================ */

section("2. PZDetect.detect 找到 6 行（含反例混在同一张图里）");
const MAIN = (function () {
  const img = whiteImage(800, 600);
  const expected = [];
  const ys = [50, 80, 110, 140, 170, 200];
  for (let i = 0; i < ys.length; i++) {
    expected.push(drawText(img, 80, ys[i], "HELLO", { glyphW: 7, glyphH: 10 }));
  }
  // 反例 1：贯穿全宽的实心分隔线（表格边框），8px 高 —— 高度足够，只能靠墨密度排掉
  fillRect(img, 0, 400, 800, 8, 0);
  // 反例 2：200×80 实心色块（图标/色卡）
  fillRect(img, 100, 460, 200, 80, 0);
  const res = D.detectImage(img, {});
  console.log(
    "  检测尺度 scale=" +
      fmt(res.stats.scale) +
      "，连通域=" +
      res.stats.components +
      "，保留组件=" +
      res.stats.kept +
      "，行=" +
      res.stats.lines +
      "，区域=" +
      res.stats.regions +
      "，耗时=" +
      fmt(res.stats.ms) +
      "ms"
  );
  console.log(
    "  真实文字行墨密度=" +
      expected
        .map(function (b) {
          return boxInkDensity(img, b).toFixed(2);
        })
        .join(" / ")
  );
  return { img: img, expected: expected, res: res };
})();

(function () {
  const res = MAIN.res;
  ok(res.lines.length === 6, "恰好检测到 6 行文字", "实际 " + res.lines.length + " 行");
  for (let i = 0; i < MAIN.expected.length; i++) {
    const b = MAIN.expected[i];
    const hit = res.lines.filter(function (l) {
      return Math.abs(l.y - b.y) <= 4;
    });
    ok(
      hit.length === 1,
      "第 " + (i + 1) + " 行 y=" + b.y + " 命中且只命中一次",
      hit.length ? "查到 y=" + hit[0].y + " h=" + hit[0].h : "未查到"
    );
    if (hit.length === 1) {
      const dens = hit[0].w * hit[0].h > 0 ? " 宽高=" + hit[0].w + "×" + hit[0].h : "";
      console.log("       → 检测框 y=" + hit[0].y + dens);
    }
  }
  ok(res.regions.length >= 1, "至少聚出 1 个区域", "实际 " + res.regions.length + " 个");
  const inRegions = res.regions.reduce(function (s, r) {
    return s + r.lines.length;
  }, 0);
  ok(inRegions === res.lines.length, "每一条行都归属于某个区域", inRegions + "/" + res.lines.length);
  // 坐标合理性
  ok(
    res.lines.every(function (l) {
      return l.w > 20 && l.h >= 6 && l.x >= 0 && l.y >= 0 && l.x + l.w <= res.width;
    }),
    "所有行框都在图内且尺寸合理"
  );
})();

/* ============================================================
 * 3. 回归：实心线条不能被当成文字
 * ============================================================ */

section("3. 回归测试：表格边框 / 实心线条不被当成文字行");
(function () {
  const img = whiteImage(800, 600);
  drawText(img, 60, 60, "TITLE", { glyphW: 7, glyphH: 10 });
  fillRect(img, 0, 300, 800, 1, 0); // 1px 满宽实心线
  fillRect(img, 0, 320, 800, 2, 0); // 2px 满宽实心线
  fillRect(img, 0, 350, 800, 8, 0); // 8px 满宽实心线（高度已过关，只剩墨密度能挡）

  const gray = I.toGray(img);
  const bin = D.binarizeForDetect(gray, 800, 600, {});
  const lineInk = (function () {
    let c = 0;
    for (let x = 0; x < 800; x++) if (bin[354 * 800 + x]) c++;
    return c / 800;
  })();
  ok(lineInk >= 0.95, "8px 实心线在二值图里确实是墨（不是二值化漏了）", "墨占比 " + lineInk.toFixed(3));

  const res = D.detectImage(img, {});
  console.log("  检测到 " + res.lines.length + " 行，耗时 " + fmt(res.stats.ms) + "ms");
  ok(res.lines.length === 1, "只剩 1 行真文字", "实际 " + res.lines.length);
  for (const y of [300, 320, 350]) {
    ok(linesNear(res, y, 6).length === 0, "y=" + y + " 的实心线未被当成文字行");
  }
  ok(linesNear(res, 65, 6).length === 1, "y=60 的真文字被找到");

  // 直接对组件过滤做断言，避免"其实是行高没到"这种巧合
  const comps = [
    { id: 0, x: 0, y: 0, w: 800, h: 8, area: 6400, ink: 6400, rows: 8, rowCoverage: 1, density: 1 },
    { id: 1, x: 0, y: 0, w: 60, h: 10, area: 200, ink: 190, rows: 10, rowCoverage: 1, density: 0.32 },
  ];
  const kept = D.filterComponents(comps, { minLineHeight: 6, maxLineHeight: 168, glyphHeight: 10 });
  ok(kept.length === 1 && kept[0].id === 1, "filterComponents 保留文字、排掉实心线条");
  const verdict = D.validateBox(comps[0], { minLineHeight: 6, maxLineHeight: 168, glyphHeight: 10 });
  ok(verdict.reason === "density_high", "实心线条被拒的原因正是墨密度过高", "reason=" + verdict.reason);
})();

/* ============================================================
 * 4. 回归：实心色块 / 空心边框都不能被当成文字
 * ============================================================ */

section("4. 回归测试：实心色块与空心边框不被当成文字");
(function () {
  const img = whiteImage(800, 600);
  drawText(img, 60, 60, "HELLO", { glyphW: 7, glyphH: 10 });
  fillRect(img, 100, 200, 200, 80, 0); // 实心色块
  // 空心边框：只有上下左右四条边有墨
  fillRect(img, 450, 200, 200, 80, 0);
  fillRect(img, 452, 202, 196, 76, 255);

  const gray = I.toGray(img);
  const bin = D.binarizeForDetect(gray, 800, 600, {});
  let blockInk = 0;
  for (let y = 230; y < 250; y++) for (let x = 180; x < 220; x++) if (bin[y * 800 + x]) blockInk++;
  ok(blockInk === 20 * 40, "实心色块内部在二值图里是墨（粗窗口补上了局部均值法的盲区）", blockInk + "/800");

  const res = D.detectImage(img, {});
  console.log(
    "  检测到 " +
      res.lines.length +
      " 行；被表格线清除步骤删掉的墨像素 = " +
      res.stats.linePixelsRemoved
  );
  ok(res.lines.length === 1, "只剩 1 行真文字", "实际 " + res.lines.length);
  ok(res.stats.linePixelsRemoved > 0, "图框的横边被 removeLongLines 清掉了");
  ok(
    !res.lines.some(function (l) {
      return boxesOverlap(l, { x: 100, y: 200, w: 200, h: 80 });
    }),
    "实心色块（200×80 @100,200）未被当成文字"
  );
  ok(
    !res.lines.some(function (l) {
      return boxesOverlap(l, { x: 450, y: 200, w: 200, h: 80 });
    }),
    "空心边框（200×80 @450,200）未被当成文字"
  );
  ok(linesNear(res, 240, 45).length === 0, "y≈240 那一带没有任何检测框");
  ok(
    !res.lines.some(function (l) {
      return boxesOverlap(l, { x: 100, y: 200, w: 200, h: 80 }) ||
        boxesOverlap(l, { x: 450, y: 200, w: 200, h: 80 });
    }),
    "没有任何检测框与两个反例重叠"
  );

  const comps = [
    { id: 0, x: 0, y: 0, w: 200, h: 80, area: 16000, ink: 16000, rows: 80, rowCoverage: 1, density: 1 },
    { id: 1, x: 0, y: 0, w: 200, h: 80, area: 1200, ink: 1120, rows: 5, rowCoverage: 0.06, density: 0.07 },
    { id: 2, x: 0, y: 0, w: 55, h: 10, area: 200, ink: 180, rows: 10, rowCoverage: 1, density: 0.33 },
  ];
  const fopts = { minLineHeight: 6, maxLineHeight: 168, glyphHeight: 10 };
  const kept = D.filterComponents(comps, fopts);
  ok(kept.length === 1 && kept[0].id === 2, "filterComponents 只保留文字组件");
  ok(
    D.validateBox(comps[0], fopts).reason === "density_high",
    "实心色块 → density_high",
    D.validateBox(comps[0], fopts).reason
  );
  const hollow = D.validateBox(comps[1], fopts);
  ok(
    hollow.reason === "rows_sparse" || hollow.reason === "density_low",
    "空心边框 → " + hollow.reason + "（墨太少 / 有空行的行）"
  );

  // 只有"框 / 色块"、完全没有文字的图：不能凭空报出文字行。
  // 这一类最容易漏掉：没有文字时行投影会把框高当成"字高"，
  // 于是"长线清除"的阈值（3×字高）大过框的边长就失效了 —— 所以字高必须有上限。
  const onlyFrame = whiteImage(800, 600);
  fillRect(onlyFrame, 100, 150, 200, 120, 0);
  fillRect(onlyFrame, 104, 154, 192, 112, 255); // 边厚 4px 的空心框
  const fr = D.detectImage(onlyFrame, {});
  ok(fr.lines.length === 0, "只有空心框的图：0 行文字", "实际 " + fr.lines.length + " 行，字高估计 " + fr.stats.charHeight);

  const onlyBlob = whiteImage(800, 600);
  fillRect(onlyBlob, 100, 100, 600, 300, 0);
  const bb = D.detectImage(onlyBlob, {});
  ok(bb.lines.length === 0, "只有一大块实心色块的图：0 行文字", "实际 " + bb.lines.length + " 行");
})();

/* ============================================================
 * 5. 逐段验证：膨胀 / 连通域 / 组件合并成行 / 字高估计
 * ============================================================ */

section("5. 算法各步骤单独验证");
(function () {
  // 5.1 水平膨胀把相邻字形黏在一起
  const w = 60;
  const h = 20;
  const bin = new Uint8Array(w * h);
  fillRect2(bin, w, 10, 5, 3, 3, 1); // 墨块 [10,13)×[5,8)
  fillRect2(bin, w, 16, 5, 3, 3, 1); // 与上一块水平相距 3px
  const compsNarrow = D.connectedComponents(bin, w, h, {});
  ok(compsNarrow.length === 2, "不膨胀时是两个组件", "实际 " + compsNarrow.length);
  const dil = D.dilateBinary(bin, w, h, { kw: 7 });
  const compsWide = D.connectedComponents(dil, w, h, { raw: bin });
  ok(compsWide.length === 1, "水平膨胀后黏成 1 个组件", "实际 " + compsWide.length);
  const c = compsWide[0];
  near(c.x, 7, 0, "膨胀后左边界外扩 3px");
  near(c.w, 15, 0, "膨胀后宽度 = 原跨度 + 2×3");
  ok(c.h === 3, "水平膨胀不改高度（h=" + c.h + "）");
  ok(c.ink === 18, "rawInk 统计的是未膨胀的墨量（" + c.ink + "）");
  near(c.density, 18 / (15 * 3), 0.001, "墨密度用的是原始墨量 / bbox 面积");

  // 5.2 连通域：分离的两块不该被并到一起
  const bin2 = new Uint8Array(40 * 40);
  fillRect2(bin2, 40, 5, 5, 5, 5, 1);
  fillRect2(bin2, 40, 25, 5, 5, 5, 1);
  const comps2 = D.connectedComponents(bin2, 40, 40, {});
  ok(comps2.length === 2, "分离的两块 → 2 个组件", "实际 " + comps2.length);
  ok(
    comps2[0].x === 5 && comps2[0].y === 5 && comps2[1].x === 25 && comps2[1].y === 5,
    "组件 bbox 正确"
  );

  // 5.3 连通域：长横线 + 大量像素不能爆栈（递归 DFS 在这里就死了）
  const bigW = 1600;
  const bigH = 200;
  const big = new Uint8Array(bigW * bigH);
  fillRect2(big, bigW, 0, 50, bigW, 1, 1); // 1600 长的横线
  let bigComps = null;
  let blew = false;
  try {
    bigComps = D.connectedComponents(big, bigW, bigH, {});
  } catch (e) {
    blew = true;
  }
  ok(!blew && bigComps && bigComps.length === 1, "1600×200 上的长横线不爆栈且是 1 个组件");

  // 5.4 字高估计
  const strip = new Uint8Array(800 * 600);
  const yBands = [50, 80, 110, 140, 170, 200];
  for (const y of yBands) fillRect2(strip, 800, 80, y, 300, 10, 1);
  const est = D.estimateTextHeight(strip, 800, 600, { minLineHeight: 6, maxLineHeight: 168 });
  ok(est === 10, "字高估计 = 10（六条 10px 高的行带）", "实际 " + est);
  ok(D.dilateWidthFor(10, {}) === 7, "字高 10 → 膨胀宽度 7（0.6×10 取奇）", "实际 " + D.dilateWidthFor(10, {}));

  // 5.5 组件 → 行
  const comps3 = [
    { x: 10, y: 10, w: 40, h: 10, ink: 100 },
    { x: 56, y: 10, w: 40, h: 10, ink: 100 }, // 同一行，间隔 6 < 1.6×10
    { x: 300, y: 10, w: 40, h: 10, ink: 100 }, // 同一行但隔了 204，不该并进去
    { x: 10, y: 40, w: 40, h: 10, ink: 100 }, // 下一行
  ];
  const lines3 = D.componentsToLines(comps3, {});
  ok(lines3.length === 3, "组件合并出 3 行（两个近的并成 1 行）", "实际 " + lines3.length);
  ok(lines3[0].x === 10 && lines3[0].w === 86, "同一行的两个组件并成一个 86 宽的行框");
  ok(lines3[0].ink === 200, "行墨量是成员之和");

  // 5.7 removeLongLines：只删"又长又细"的横带
  const mw = 400;
  const mh = 120;
  const mask = new Uint8Array(mw * mh);
  fillRect2(mask, mw, 20, 10, 300, 2, 1); // 长 300、厚 2 的表格线 → 该删
  fillRect2(mask, mw, 20, 60, 60, 40, 1); // 60×40 实心块 → 够厚，该留
  fillRect2(mask, mw, 200, 30, 12, 2, 1); // 12×2 的短笔画 → 不够长，该留
  const cleaned = D.removeLongLines(mask, mw, mh, { charHeight: 10 });
  ok(cleaned.removed === 600, "长细线被清掉 600 像素", "实际 " + cleaned.removed);
  ok(cleaned[10 * mw + 100] === 0 && cleaned[11 * mw + 100] === 0, "长细线位置已清空");
  ok(cleaned[70 * mw + 30] === 1, "厚实心块被保留（厚度判据起作用）");
  ok(cleaned[30 * mw + 205] === 1, "短笔画被保留（长度判据起作用）");
  ok(mask[10 * mw + 100] === 1, "removeLongLines 不修改入参");

  // 5.8 行 → 区域（含间距放大重聚类，不丢字）
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ x: 10 + (i % 10) * 100, y: 10 + Math.floor(i / 10) * 60, w: 60, h: 10, ink: 100 });
  }
  const regions = D.linesToRegions(many, { maxRegions: 4, vGap: 14, hGap: 40 });
  ok(regions.length <= 4, "区域数被压到上限内", "实际 " + regions.length);
  const covered = regions.reduce(function (s, r) {
    return s + r.lines.length;
  }, 0);
  ok(covered === 60, "所有行都还在某个区域里（不靠丢弃来满足上限）", covered + "/60");
})();

function fillRect2(bin, w, x, y, rw, rh, v) {
  for (let yy = y; yy < y + rh; yy++) {
    for (let xx = x; xx < x + rw; xx++) bin[yy * w + xx] = v;
  }
}

/* ============================================================
 * 6. groupBoxesIntoBlocks：同段合并 / 远块分离
 * ============================================================ */

section("6. PZUtil.groupBoxesIntoBlocks");
(function () {
  const near3 = [
    { x: 100, y: 100, w: 200, h: 12 },
    { x: 100, y: 120, w: 200, h: 12 },
    { x: 100, y: 140, w: 200, h: 12 },
  ];
  const far = { x: 600, y: 400, w: 100, h: 12 };
  const blocks = U.groupBoxesIntoBlocks(near3.concat([far]), { vGap: 14, hGap: 40 });
  ok(blocks.length === 2, "相邻三行并成 1 块、远处的块单独成 1 块", "实际 " + blocks.length + " 块");
  const big = blocks.filter(function (b) {
    return b.count === 3;
  });
  ok(big.length === 1, "有一段包含 3 行", "count=" + blocks.map(function (b) { return b.count; }).join(","));
  if (big.length) {
    ok(
      big[0].x === 100 && big[0].y === 100 && big[0].w === 200 && big[0].h === 52,
      "合并后的块包围盒正确",
      JSON.stringify({ x: big[0].x, y: big[0].y, w: big[0].w, h: big[0].h })
    );
  }
  const single = blocks.filter(function (b) {
    return b.count === 1;
  });
  ok(single.length === 1 && single[0].x === 600, "远处的块没有被吸进来");

  // 水平相邻（同一视觉行）也应该并成一块
  const rowBlocks = U.groupBoxesIntoBlocks(
    [
      { x: 100, y: 100, w: 80, h: 12 },
      { x: 190, y: 100, w: 80, h: 12 },
    ],
    { vGap: 14, hGap: 40 }
  );
  ok(rowBlocks.length === 1, "同一行的两段并成 1 块", "实际 " + rowBlocks.length);
})();

/* ============================================================
 * 7. 反锐化掩膜提升清晰度
 * ============================================================ */

section("7. PZImage.unsharpGray / laplacianVariance");
(function () {
  const img = whiteImage(320, 140);
  drawText(img, 20, 40, "HELLO", { glyphW: 7, glyphH: 10 });
  drawText(img, 20, 90, "TESTO", { glyphW: 7, glyphH: 10 });
  const gray = I.toGray(img);
  const sharpLv = I.laplacianVariance(gray, 320, 140);

  // 用两遍盒式模糊模拟"被缩放/JPEG 压过、边缘不锐利"的截图
  const blurredRaw = I.boxBlurGray(gray, 320, 140, 2, 2);
  const blurred = Uint8ClampedArray.from(blurredRaw);
  const blurLv = I.laplacianVariance(blurred, 320, 140);
  const fixed = I.unsharpGray(blurred, 320, 140, { radius: 2, amount: 1.0 });
  const fixedLv = I.laplacianVariance(fixed, 320, 140);

  console.log(
    "  拉普拉斯方差：原图 " + fmt(sharpLv) + " → 模糊后 " + fmt(blurLv) + " → 反锐化后 " + fmt(fixedLv)
  );
  ok(blurLv < sharpLv, "盒式模糊确实降低了清晰度", fmt(blurLv) + " < " + fmt(sharpLv));
  ok(
    fixedLv > blurLv * 1.5,
    "反锐化掩膜让清晰度显著回升（>1.5 倍）",
    "提升 " + (fixedLv / Math.max(1e-6, blurLv)).toFixed(2) + " 倍"
  );

  // 锐化后二值化召回应该变好（这才是"解决小字漏识别"的实际效果）
  function inkRecall(g) {
    const bin = I.adaptiveThreshold(g, 320, 140, { window: 15, C: 10 });
    let hit = 0;
    let total = 0;
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] === 0) {
        total++;
        if (bin[i]) hit++;
      }
    }
    return hit / total;
  }
  const rBlur = inkRecall(blurred);
  const rFixed = inkRecall(fixed);
  console.log("  笔画召回率：模糊后 " + (rBlur * 100).toFixed(1) + "% → 锐化后 " + (rFixPercent(rFixed)));
  ok(rFixed >= rBlur, "锐化后笔画召回率不下降", (rBlur * 100).toFixed(1) + "% → " + (rFixed * 100).toFixed(1) + "%");
  function rFixPercent(v) {
    return (v * 100).toFixed(1) + "%";
  }

  // threshold 参数：小于落差的噪声不该被放大
  const flat = new Uint8ClampedArray(64 * 64).fill(200);
  flat[32 * 64 + 32] = 206;
  const withThr = I.unsharpGray(flat, 64, 64, { radius: 1, amount: 1, threshold: 8 });
  ok(withThr[32 * 64 + 32] === 206, "threshold 能挡住微小噪声不被放大");
})();

/* ============================================================
 * 8. 缩放 + 坐标还原（大图路径）
 * ============================================================ */

section("8. 长边缩放与坐标还原");
(function () {
  const img = whiteImage(2400, 1800);
  const expected = [
    drawText(img, 300, 600, "HELLO", { glyphW: 14, glyphH: 20, gap: 8 }),
    drawText(img, 300, 700, "TESTO", { glyphW: 14, glyphH: 20, gap: 8 }),
  ];
  const res = D.detectImage(img, { maxSide: 1600 });
  console.log(
    "  scale=" + fmt(res.stats.scale) + "，行=" + res.lines.length + "，耗时 " + fmt(res.stats.ms) + "ms"
  );
  near(res.stats.scale, 1600 / 2400, 0.01, "检测尺度 = 1600/2400");
  ok(res.width === 2400 && res.height === 1800, "返回的仍是原图尺寸");
  for (const b of expected) {
    const hit = linesNear(res, b.y + b.h / 2, 10);
    ok(hit.length === 1, "原图 y=" + b.y + " 的行被找回", hit.length ? "还原到 y=" + hit[0].y : "未找到");
  }
  // 缩小后不许漏检：检测尺度下字高应约 13px
  ok(res.stats.charHeight >= 8, "缩到 1600 后字高估计合理", "charHeight=" + res.stats.charHeight);
})();

/* ============================================================
 * 9. 空白图 / 纯深色图不误检
 * ============================================================ */

section("9. 空白图与纯色图不产生误检");
(function () {
  const blank = D.detectImage(whiteImage(600, 400), {});
  ok(blank.lines.length === 0 && blank.regions.length === 0, "全白图：0 行 0 区域");
  ok(blank.stats.components === 0, "全白图：0 个连通域", "实际 " + blank.stats.components);

  const black = U.imageLike(600, 400, 0);
  const blackRes = D.detectImage(black, {});
  ok(blackRes.lines.length === 0, "全黑图：0 行（自动极性判断不会把纯色当字）", "实际 " + blackRes.lines.length);

  // 深底浅字：反相后应该能找到
  const dark = U.imageLike(600, 300, 30);
  const gbox = drawText(dark, 40, 100, "HELLO", { glyphW: 7, glyphH: 10, dark: 255 });
  for (let y = gbox.y; y < gbox.y + gbox.h; y++) {
    for (let x = gbox.x; x < gbox.x + gbox.w; x++) {
      const i = (y * 600 + x) * 4;
      if (dark.data[i] === 0) {
        dark.data[i] = 255;
        dark.data[i + 1] = 255;
        dark.data[i + 2] = 255;
      }
    }
  }
  const darkRes = D.detectImage(dark, {});
  ok(darkRes.lines.length >= 1, "深底浅字（反相后）能找到行", "实际 " + darkRes.lines.length + " 行");
})();

/* ============================================================
 * 10. 性能：1600×1200 全流程
 * ============================================================ */

section("10. 性能（1600×1200 满页文字）");
(function () {
  const img = whiteImage(1600, 1200);
  let rows = 0;
  for (let y = 40; y < 1160; y += 46) {
    drawText(img, 60, y, "MATERIAL", { glyphW: 6, glyphH: 9, gap: 3 });
    drawText(img, 900, y, "PANTONE", { glyphW: 6, glyphH: 9, gap: 3 });
    rows += 2;
  }
  // 再来几条贯穿全宽的表格线，让连通域碰到长游程（真实规格表就是这样）
  for (let y = 30; y < 1200; y += 92) fillRect(img, 0, y, 1600, 2, 0);

  D.detectImage(img, {}); // 预热 JIT
  const t0 = Date.now();
  const res = D.detectImage(img, {});
  const ms = Date.now() - t0;
  console.log(
    "  " + rows + " 行文字 + 13 条表格线：耗时 " + ms + "ms（stats.ms=" + fmt(res.stats.ms) + "）"
  );
  console.log(
    "  连通域 " +
      res.stats.components +
      "，保留 " +
      res.stats.kept +
      "，行 " +
      res.stats.lines +
      "，区域 " +
      res.stats.regions +
      "，字高 " +
      res.stats.charHeight
  );
  ok(ms < 300, "全流程 < 300ms", "实际 " + ms + "ms");
  ok(res.lines.length > rows * 0.6, "大部分文字行被检出", res.lines.length + "/" + rows);
  ok(res.stats.regions <= 40, "区域数不超过上限", "实际 " + res.stats.regions);
})();

/* ============================================================
 * 11. 边界：纯函数不碰 DOM，画布适配层在 Node 下按预期抛错
 * ============================================================ */

section("11. 纯函数 / 画布适配层的边界");
(function () {
  const fakeCanvas = {
    width: 2000,
    height: 1000,
    getContext: function () {
      throw new Error("不该走到这里");
    },
  };
  let err = null;
  try {
    I.downscale(fakeCanvas, 100);
  } catch (e) {
    err = e;
  }
  ok(
    !!err && /document/.test(err.message),
    "画布适配层在 Node 下抛的是 PZUtil 的缺 document 错误（预期行为）",
    err ? err.message : "没有抛错"
  );

  // 同一份输入走纯函数路径必须能跑通（检测主线的所有步骤都是纯函数）
  let pureOk = true;
  try {
    D.detectImage(U.imageLike(200, 100, 255), {});
  } catch (e) {
    pureOk = false;
    console.log("      异常：" + e.message);
  }
  ok(pureOk, "detectImage 全程不需要 canvas，Node 里可直接跑");
})();

/* ============================================================
 * 12. 密排小字 / 彩色渐变底（用户真实场景）
 * ============================================================ */

section("12. 密排小字与彩色渐变底");
(function () {
  // 5×7 的"T"形小字（1px 笔画），字距 3px、行距 14px，5 列铺满整幅宽度。
  // 这一条专门盯两件事：① 整行小字连成一个超宽组件时不能被宽高比上限误杀；
  // ② 行墨量很低的细笔画不能被二值化漏掉。
  const w = 1600;
  const h = 1200;
  const img = whiteImage(w, h);
  let rows = 0;
  for (let y = 20; y < 1180; y += 14) {
    rows++;
    for (let x = 20; x < 1580; x += 8) {
      fillRect(img, x, y, 5, 1, 0); // 顶横
      fillRect(img, x + 2, y, 1, 7, 0); // 竖笔
    }
  }
  const res = D.detectImage(img, {});
  console.log(
    "  密排小字：" +
      rows +
      " 行 → 检出 " +
      res.stats.lines +
      " 行，耗时 " +
      fmt(res.stats.ms) +
      "ms，字高 " +
      res.stats.charHeight +
      "，区域 " +
      res.stats.regions
  );
  const bands = [];
  for (const l of res.lines) if (bands.indexOf(l.y) < 0) bands.push(l.y);
  ok(bands.length === rows, "整幅宽度的密排小字全部检出", bands.length + "/" + rows);
  const wide = res.lines.filter(function (l) {
    return l.w > 1000 && l.h <= 10;
  });
  ok(wide.length > 0, "超宽小字行没有被宽高比上限误杀", "最宽 " + (wide[0] ? wide[0].w : 0) + "px");
  ok(res.stats.ms < 800, "密排小字全流程耗时可控", fmt(res.stats.ms) + "ms");

  // 彩色渐变底 + 深色色块上压小字：全局阈值在这种图上会整片失效
  const img2 = whiteImage(w, h);
  for (let y = 0; y < h; y++) {
    const v = Math.round(180 + 70 * Math.sin(y / 120));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img2.data[i] = v;
      img2.data[i + 1] = Math.min(255, v + 30);
      img2.data[i + 2] = Math.min(255, v + 60);
    }
  }
  fillRect(img2, 0, 200, w, 200, 90); // 深色面板（灰 90，字 20 → 对比度 70，接近真实）
  let drawn = 0;
  for (let y = 40; y < 1120; y += 30) {
    for (let x = 40; x < 1500; x += 40) {
      drawn++;
      fillRect(img2, x, y, 7, 1, 20);
      fillRect(img2, x + 3, y, 1, 10, 20);
    }
  }
  const res2 = D.detectImage(img2, {});
  console.log(
    "  渐变彩底 + 深色面板：" +
      drawn +
      " 处小字 → 检出 " +
      res2.stats.lines +
      " 行，耗时 " +
      fmt(res2.stats.ms) +
      "ms，字高 " +
      res2.stats.charHeight
  );
  ok(res2.lines.length > drawn * 0.7, "彩底/深色底上的小字大部分检出", res2.lines.length + "/" + drawn);
  ok(res2.stats.ms < 800, "彩底图耗时可控", fmt(res2.stats.ms) + "ms");
})();

/* ============================================================
 * 汇总
 * ============================================================ */

console.log("\n============================================");
console.log("通过 " + passed + " / 失败 " + failed);
if (failed) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
  process.exitCode = 1;
} else {
  console.log("全部通过 ✅");
}
console.log("============================================");
