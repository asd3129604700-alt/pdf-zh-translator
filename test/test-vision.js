/**
 * test/test-vision.js — PZVision 纯逻辑单测（Node 直跑，不需要浏览器 / 不联网）
 *
 *   node test/test-vision.js
 *
 * 为什么用 eval 加载：util.js / config.js / vision.js 是经典脚本（IIFE 挂全局），
 * 不是 ES module，所以不能用 require。它们在文件末尾会把对象挂到
 * `typeof window !== "undefined" ? window : globalThis` —— Node 里就是 globalThis。
 *
 * 涉及网络的 translate / testKey / listModels 这里不测（要真 Key），
 * 只测能用手算验证的纯逻辑：坐标映射、畸形输出解析、去重、端点拼接、裁切放大、提示词。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function loadScript(rel) {
  const file = path.join(ROOT, rel);
  // indent 传入 0，避免 eval 把顶层声明提升进模块作用域后互相打架
  eval(fs.readFileSync(file, "utf8"));
}

loadScript(path.join("js", "util.js"));
loadScript(path.join("js", "config.js"));
loadScript(path.join("js", "vision.js"));

const U = globalThis.PZUtil;
const C = globalThis.PZConfig;
const V = globalThis.PZVision;

if (!U || !C || !V) {
  console.error("加载脚本失败：PZUtil / PZConfig / PZVision 未挂到 globalThis");
  process.exit(1);
}

/* ============================================================
 * 假画布：Node 里没有 document，而 PZUtil.cropCanvas 需要真画布。
 * 用 PZUtil.setCanvasFactory 注入一个最小实现（不能直接替换
 * PZUtil.createCanvas —— cropCanvas 闭包引用的是模块私有工厂，改了没用）。
 * ============================================================ */

function makeFakeCanvas(w, h) {
  const ctx = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "",
    fillRect: function () {},
    drawImage: function () {},
  };
  return {
    width: Math.max(1, Math.round(w || 1)),
    height: Math.max(1, Math.round(h || 1)),
    getContext: function () { return ctx; },
    toDataURL: function () { return "data:image/jpeg;base64,AAAA"; },
  };
}

const REAL_FACTORY = function (w, h) {
  if (typeof document === "undefined") {
    throw new Error("当前环境没有 document，请先调用 PZUtil.setCanvasFactory 注入");
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w || 1));
  c.height = Math.max(1, Math.round(h || 1));
  return c;
};

U.setCanvasFactory(function (w, h) { return makeFakeCanvas(w, h); });

/* ============================================================
 * 迷你断言框架
 * ============================================================ */

let passed = 0;
let failed = 0;
const failures = [];
let currentSection = "";

function section(title) {
  currentSection = title;
  console.log("\n" + "=".repeat(66));
  console.log("【" + title + "】");
  console.log("=".repeat(66));
}

function ok(msg) {
  passed++;
  console.log("  ✓ " + msg);
}

function fail(msg, detail) {
  failed++;
  failures.push("[" + currentSection + "] " + msg + (detail ? " — " + detail : ""));
  console.log("  ✗ " + msg + (detail ? "\n      " + detail : ""));
}

function check(cond, msg, detail) {
  if (cond) ok(msg);
  else fail(msg, detail);
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(msg);
  else fail(msg, "期望 " + e + "，实际 " + a);
}

function near(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) <= tol) ok(msg);
  else fail(msg, "期望 ≈" + expected + "（±" + tol + "），实际 " + actual);
}

function throws(fn, msg) {
  try {
    fn();
  } catch (e) {
    ok(msg);
    return;
  }
  fail(msg, "本应抛错但没有");
}

/* ============================================================
 * 1. _mapBoxFromCrop —— 裁切图坐标 → 整图坐标
 * ============================================================ */

section("1. _mapBoxFromCrop 坐标映射");

(function testMapping() {
  // ══════════════════════════════════════════════════════════════════
  // 语义（先把语义写死，期望值一律从语义推出来，绝不照抄实现输出）：
  //
  //   _cropOffset.x / .y   = 裁切框在**整图**中的左上角（原图像素）
  //   _cropOffset.srcW/.srcH = 裁切框在**放大前**的尺寸（原图像素）
  //   _cropOffset.scale    = 放大倍数
  //   ⇒ 交给模型的裁切画布尺寸 = srcW*scale × srcH*scale
  //
  // 模型返回的 box 是对**放大后的裁切画布**做 0-1000 归一化的，所以：
  //   cropX = (box/1000) * srcW * scale        （裁切画布内的像素）
  //   fullX = offset.x + cropX / scale
  //         = offset.x + (box/1000) * srcW      （scale 约掉，不参与计算）
  //
  // 三条硬性质：
  //   P1 满幅 box → 映射回裁切框本身：{x, y, srcW, srcH}
  //   P2 映射结果与 scale 无关（同一块裁切换倍数，结果必须一样）
  //   P3 fullX = ox + (box/1000)*srcW 这条线性关系（下面用逐点算术验证）
  // ══════════════════════════════════════════════════════════════════

  // —— 与 test-integration.js 第 [2] 节完全一致的基准 fixture ——
  const off = { x: 100, y: 50, scale: 2, srcW: 100, srcH: 60 };
  const IMG_W = 1000;
  const IMG_H = 800;

  // P1：满幅 box 必须正好还原成裁切框本身（不受 scale 影响）
  eq(
    V._mapBoxFromCrop([0, 0, 1000, 1000], off, IMG_W, IMG_H),
    { x: 100, y: 50, w: 100, h: 60 },
    "P1 满幅 box → 裁切框本身 {x:100,y:50,w:100,h:60}"
  );

  // 半幅：box 250..750 → fullX 100+0.25*100=125 .. 100+0.75*100=175
  eq(
    V._mapBoxFromCrop([250, 250, 750, 750], off, IMG_W, IMG_H),
    { x: 125, y: 65, w: 50, h: 30 },
    "半幅 box [250,250,750,750] → {x:125,y:65,w:50,h:30}"
  );

  // ★ P2：换放大倍数，结果必须一模一样。
  // 多除一次 scale 的写法会让这里第 3 条开始崩（4 倍时坐标缩成 1/4）。
  [1, 2, 3.5, 4].forEach(function (s) {
    const got = V._mapBoxFromCrop(
      [0, 0, 1000, 1000],
      { x: 100, y: 50, scale: s, srcW: 100, srcH: 60 },
      IMG_W,
      IMG_H
    );
    eq(got, { x: 100, y: 50, w: 100, h: 60 }, "P2 scale=" + s + " 时结果与 scale=1 相同");
  });

  // P3：线性关系逐点验证 —— fullX 必须等于 ox + (box/1000)*srcW
  [0, 100, 250, 500, 750, 1000].forEach(function (bx) {
    const got = V._mapBoxFromCrop([bx, 0, bx, 0], off, IMG_W, IMG_H);
    near(got.x, 100 + (bx / 1000) * 100, 0.001, "P3 box x=" + bx + " → fullX = 100 + box/10");
  });

  // ── 下面是别的边界行为，期望值同样由语义算出 ──

  // 起点平移的正面证据：同尺寸裁切，offset.x=0 与 offset.x=100 → 结果相差正好 100
  const atZero = V._mapBoxFromCrop(
    [0, 0, 1000, 1000],
    { x: 0, y: 0, scale: 2, srcW: 100, srcH: 60 },
    IMG_W,
    IMG_H
  );
  eq(atZero, { x: 0, y: 0, w: 100, h: 60 }, "offset 为 0 时从原点开始");
  near(100 - atZero.x, 100, 0.001, "offset.x 被正确地平移了 +100");

  // 对象形态的 box 与数组形态结果一致
  eq(
    V._mapBoxFromCrop({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, off, IMG_W, IMG_H),
    { x: 100, y: 50, w: 100, h: 60 },
    "对象形态的 box 与数组形态一致"
  );

  // 0-1 小数归一化
  eq(
    V._mapBoxFromCrop([0, 0, 1, 1], off, IMG_W, IMG_H),
    { x: 100, y: 50, w: 100, h: 60 },
    "0-1 归一化的小数也能正确映射"
  );

  // 满幅 [0,0,1000,1000] 不能被误当成 0-1 小数再乘一次 1000
  eq(
    V._normalizeBox1000([0, 0, 1000, 1000]),
    [0, 0, 1000, 1000],
    "[0,0,1000,1000] 就是满幅框，不被二次缩放"
  );

  // 与 PZUtil.cropCanvas 的真输出对拍（这是"srcW 是放大前尺寸"最直接的证据）。
  // 原图 600×400，裁 {x:120,y:80,w:150,h:60}、pad=6、scale=3：
  //   裁切框 = x 114..276、y 74..146 → srcW=162、srcH=72
  //   cropCanvas 画布 = round(162*3) × round(72*3) = 486×216
  {
    const src = makeFakeCanvas(600, 400);
    const crop = U.cropCanvas(src, { x: 120, y: 80, w: 150, h: 60 }, { pad: 6, scale: 3 });
    eq(
      V._mapBoxFromCrop([0, 0, 1000, 1000], crop._cropOffset, 600, 400),
      { x: 114, y: 74, w: 162, h: 72 },
      "与 cropCanvas 真输出对拍：满幅 box 映射回裁切框本身（含 pad=6）"
    );
    eq(crop._cropOffset.scale, 3, "cropCanvas 回填了 scale=3");
    eq(crop._cropOffset.srcW, 162, "cropCanvas 的 srcW 是放大前宽度 162");
    eq(
      crop.width,
      Math.round(crop._cropOffset.srcW * crop._cropOffset.scale),
      "round(srcW*scale) === 画布宽 486（srcW 确实是放大前尺寸）"
    );
    // 同一个 cropCanvas 结果，换 scale 描述也必须得到同一块坐标
    eq(
      V._mapBoxFromCrop([0, 0, 1000, 1000], { x: 114, y: 74, scale: 1, srcW: 162, srcH: 72 }, 600, 400),
      { x: 114, y: 74, w: 162, h: 72 },
      "同一块裁切用 scale=1 描述 → 同一结果（与 scale 无关）"
    );
  }

  // 越界钳制：box [-500,-500,2000,2000] 的处理顺序是【先取绝对值、再钳到 80..1080】：
  //   |−500| = 500（不是 80！），|2000| = 2000 → 钳到 1080
  //   于是中间值 = [500, 500, 1080, 1080]
  //   fullX = 100 + 500/10 = 150 … 100 + 1080/10 = 208   → w = 58
  //   fullY =  50 + 500/10 =  80 …  50 + 1080/10 = 114.8 → h = 34.8
  // 之所以先取绝对值：模型用负数表示"往左上超出一点点"，取绝对值才留得住贴边的像素；
  // 之后 ±80/1080 的溢出带是第二道保护。硬约束只有两条 —— 绝不越界、绝不零宽零高。
  const clamped = V._mapBoxFromCrop([-500, -500, 2000, 2000], off, IMG_W, IMG_H);
  // 用 near 而不是 eq：h 是 (1080-500)/1000*60 = 34.800000000000004，浮点尾巴不该当失败
  near(clamped.x, 150, 0.001, "越界输入：x 收进溢出带 = 100 + 500/10");
  near(clamped.y, 80, 0.001, "越界输入：y 收进溢出带 = 50 + 500/10");
  near(clamped.w, 58, 0.001, "越界输入：w = (1080-500)/1000*100");
  near(clamped.h, 34.8, 0.001, "越界输入：h = (1080-500)/1000*60");
  check(
    clamped.x >= 0 && clamped.y >= 0 &&
      clamped.x + clamped.w <= IMG_W && clamped.y + clamped.h <= IMG_H,
    "越界输入的框绝不越出整图",
    JSON.stringify(clamped)
  );
  check(clamped.w > 0 && clamped.h > 0, "越界输入不会产生零宽零高的框", JSON.stringify(clamped));

  // 裁切块本身贴着整图右/下边界 → 也不能越界
  const clipEdge = V._mapBoxFromCrop(
    [-500, -500, 2000, 2000],
    { x: 950, y: 760, scale: 2, srcW: 100, srcH: 60 },
    IMG_W,
    IMG_H
  );
  check(
    clipEdge.x + clipEdge.w <= IMG_W && clipEdge.y + clipEdge.h <= IMG_H,
    "裁切块贴右下边界时结果不越界",
    JSON.stringify(clipEdge)
  );

  // 贴边文字：模型给 -5 / 1010 这种"贴着边的越界"，不能把那一截丢掉。
  // -5 会被取绝对值当成 5（模型表达"向左超一点点"的常见写法），
  // 于是起点落在裁切起点右边 0.5px —— 比整段文字丢掉划算得多。
  const rEdge = V._mapBoxFromCrop([-5, 995, 200, 1010], off, IMG_W, IMG_H);
  near(rEdge.x, 100.5, 0.6, "略越左边界（-5）的框仍从裁切起点附近开始");
  check(rEdge.w > 15, "贴边文字没有被压成零宽", JSON.stringify(rEdge));
  check(rEdge.y + rEdge.h <= IMG_H, "贴下边界的框没有越出整图", JSON.stringify(rEdge));

  // 退化 box（模型给成一个点）必须补出最小尺寸，且保证 x1 > x0 + 1
  const degen = V._mapBoxFromCrop([500, 500, 500, 500], off, IMG_W, IMG_H);
  check(degen.w > 1 && degen.h > 1, "退化点被补成有面积的框", JSON.stringify(degen));

  // box 完全缺失 → 用按图算的兜底框，不能缩成一个 2px 的点
  const noBox = V._mapBoxFromCrop(null, null, 800, 600);
  check(noBox.w >= 24 && noBox.h >= 12, "缺 box 时兜底框有实际尺寸", JSON.stringify(noBox));

  // 没有 _cropOffset（整图那一条路径的退化形态）→ 等价于 offset(0,0)、scale 1、srcW=W
  eq(
    V._mapBoxFromCrop([0, 0, 1000, 1000], null, 800, 600),
    { x: 0, y: 0, w: 800, h: 600 },
    "无 offset 时按整图映射"
  );
  // 整图兜底那条路径的真实形态：{x:0,y:0,scale:f,srcW:W,srcH:H}
  // f=0.5（原图 1600 缩到 800）→ 满幅 box 必须映射回整张 1600×1200
  eq(
    V._mapBoxFromCrop([0, 0, 1000, 1000], { x: 0, y: 0, scale: 0.5, srcW: 1600, srcH: 1200 }, 1600, 1200),
    { x: 0, y: 0, w: 1600, h: 1200 },
    "整图兜底：缩图 0.5 倍时满幅 box 仍映射回整张原图"
  );
  // 缩图时 scale<1，若算式里写了 /scale 就会放大 2 倍并越界 —— 这条盯住它
  eq(
    V._mapBoxFromCrop([0, 0, 500, 500], { x: 0, y: 0, scale: 0.5, srcW: 1600, srcH: 1200 }, 1600, 1200),
    { x: 0, y: 0, w: 800, h: 600 },
    "整图兜底：缩图 0.5 倍时半幅 box 映射正确（scale<1 也不放大）"
  );

  // srcW/srcH 缺失的情形：退化到「裁切画布尺寸 / scale」
  // 画布 400 宽、scale 2 → 覆盖原图 400/2 = 200px
  eq(
    V._mapBoxFromCrop([0, 0, 1000, 1000], { x: 10, y: 20, scale: 2, width: 400, height: 400 }, 1000, 1000),
    { x: 10, y: 20, w: 200, h: 200 },
    "srcW/srcH 缺失时能从画布宽高反推"
  );
  eq(
    V._mapBoxFromCrop([0, 0, 1000, 1000], { x: 10, y: 20, scale: 1, width: 400, height: 400 }, 1000, 1000),
    { x: 10, y: 20, w: 400, h: 400 },
    "scale=1 时同一张裁切画布覆盖 400px（反推公式跟着 scale 走）"
  );

  // 极小图：不能出现 w=0 或者负数
  const r9 = V._mapBoxFromCrop([0, 0, 1000, 1000], { x: 0, y: 0, scale: 1, srcW: 1, srcH: 1 }, 1, 1);
  check(r9.w >= 1 && r9.h >= 1 && r9.x >= 0 && r9.y >= 0, "1×1 的极端图也不产生非法框", JSON.stringify(r9));
})();

/* ============================================================
 * 2. _parseItems —— 畸形模型输出
 * ============================================================ */

section("2. _parseItems 畸形输出解析");

(function testParse() {
  // 2.1 markdown 代码块 + 外层包 {items:[...]} + doc 字段
  {
    const raw =
      "好的，以下是识别结果：\n```json\n" +
      JSON.stringify({
        items: [
          { text: "MATERIAL SPEC", translation: "材质规格", box: [10, 20, 300, 60] },
          { text: "SEPARATE PIECE", translation: "独立部件", box: [10, 80, 320, 120] },
        ],
      }) +
      "\n```\n希望有帮助！";
    const items = V._parseItems(raw);
    eq(items.length, 2, "markdown 代码块 + {items:[...]} 能解析出 2 条");
    eq(items[0].src, "MATERIAL SPEC", "第 1 条原文正确");
    eq(items[0].dst, "材质规格", "第 1 条译文正确");
    eq(items[0].box, [10, 20, 300, 60], "第 1 条坐标正确");
  }

  // 2.2 bbox_2d（Gemini 常见）+ content 当原文
  {
    const raw = JSON.stringify([
      { content: "PMS 185C", translation: "PMS 185C", bbox_2d: [100, 200, 400, 260] },
    ]);
    const items = V._parseItems(raw);
    eq(items.length, 1, "bbox_2d 字段名能识别");
    eq(items[0].src, "PMS 185C", "content 字段被当作原文");
    eq(items[0].box, [100, 200, 400, 260], "bbox_2d 坐标正确");
  }

  // 2.3 中文字段名 + box 是对象
  {
    const raw = JSON.stringify({
      data: [
        { 原文: "EMBROIDERY", 译文: "刺绣", box: { x0: 5, y0: 6, x1: 105, y1: 46 } },
        { 原文: "APPLIQUE", 译文: "贴布绣", bbox: { x: 200, y: 30, w: 150, h: 40 } },
      ],
    });
    const items = V._parseItems(raw);
    eq(items.length, 2, "中文字段名 + {data:[...]} 能解析");
    eq(items[0].src, "EMBROIDERY", "原文取自「原文」字段");
    eq(items[0].dst, "刺绣", "译文取自「译文」字段");
    eq(items[0].box, [5, 6, 105, 46], "x0/y0/x1/y1 对象形态的框正确");
    eq(items[1].box, [200, 30, 350, 70], "x/y/w/h 对象形态的框被换算成 x0y0x1y1");
  }

  // 2.4 平铺坐标字段（x0/y0/x1/y1 直接在条目上，原实现就是这种）
  {
    const raw = JSON.stringify([
      { text: "GRADIENT", translation: "渐变", x0: 0, y0: 0, x1: 500, y1: 100 },
    ]);
    const items = V._parseItems(raw);
    eq(items.length, 1, "平铺 x0/y0/x1/y1 能解析");
    eq(items[0].box, [0, 0, 500, 100], "平铺坐标被组装成 box");
  }

  // 2.5 各种垃圾输入不能抛异常
  {
    eq(V._parseItems(""), [], "空字符串 → 空数组");
    eq(V._parseItems(null), [], "null → 空数组");
    eq(V._parseItems("模型今天不想干活"), [], "纯文本废话 → 空数组");
    eq(V._parseItems('{"items":[]}'), [], '{"items":[]} → 空数组');
    eq(V._parseItems("[{"), [], "残缺 JSON → 空数组（不抛异常）");
    const arr = V._parseItems(
      '{"items":[{"text":"A","box":[0,0,10,10]},{"text":"B","box":null}]}'
    );
    eq(arr.length, 2, "缺坐标的条目仍然保留（坐标交给上层补）");
    eq(arr[1].box, null, "缺坐标时 box 为 null");
  }

  // 2.6 尾逗号 / Python 字面量
  {
    const raw = '{items:[{text:"Front",translation:"正面",box:[0,0,10,10],},],}';
    const items = V._parseItems(raw);
    eq(items.length, 1, "缺引号的键名 + 尾逗号能被修复");
    eq(items[0].src, "Front", "修复后原文正确");
  }
})();

/* ============================================================
 * 3. _dedupe —— 合并去重
 * ============================================================ */

section("3. _dedupe 合并去重");

(function testDedupe() {
  // 3.1 同位置、文本相似、一条来自区域遍一条来自整图遍 → 只留区域遍
  {
    const region = {
      x: 100, y: 200, w: 200, h: 30,
      src: "MATERIAL SPEC", dst: "材质规格", source: "region",
    };
    const whole = {
      // 只差 10px，重叠 95%
      x: 110, y: 200, w: 200, h: 30,
      src: "MATERIAL SPEC", dst: "材料规格", source: "whole",
    };
    const overlap = U.overlapRatio(region, whole);
    check(overlap > 0.5, "前置条件：两条重叠 > 0.5（实际 " + overlap.toFixed(2) + "）");

    const out = V._dedupe([whole, region]); // 故意把 whole 放前面
    eq(out.length, 1, "重叠 80%+ 且文本相同 → 去重后只剩 1 条");
    eq(out[0].source, "region", "保留的是区域遍那条（分辨率更高）");
    eq(out[0].dst, "材质规格", "保留的是区域遍的译文");
  }

  // 3.2 位置几乎重合但文本完全不同 → 绝不能误删
  {
    const front = { x: 100, y: 200, w: 80, h: 24, src: "Front", dst: "正面", source: "region" };
    const back = { x: 106, y: 202, w: 78, h: 24, src: "Back", dst: "背面", source: "whole" };
    check(U.overlapRatio(front, back) > 0.5, "前置条件：两条重叠 > 0.5（" + U.overlapRatio(front, back).toFixed(2) + "）");
    check(!U.sameText("Front", "Back"), "前置条件：Front / Back 判为不同文本");

    const out = V._dedupe([front, back]);
    eq(out.length, 2, "位置相近但文本不同的两条都保留（不误删）");
    const srcs = out.map(function (i) { return i.src; }).sort();
    eq(srcs, ["Back", "Front"], "Front 与 Back 都还在");
  }

  // 3.2b 位置几乎完全重合、文本也完全不同 → 依然不能删
  {
    const a = { x: 100, y: 200, w: 80, h: 24, src: "Front", dst: "正面", source: "region" };
    const b = { x: 102, y: 202, w: 78, h: 24, src: "Back", dst: "背面", source: "whole" };
    check(U.overlapRatio(a, b) > 0.9, "前置条件：两条重叠 > 0.9（" + U.overlapRatio(a, b).toFixed(2) + "）");
    eq(V._dedupe([a, b]).length, 2, "重叠 90% 但文本不同的两条都保留");
  }

  // 3.3 文本相同但位置离得很远（同一标签出现两处）→ 都保留
  {
    const a = { x: 0, y: 0, w: 120, h: 24, src: "SEASON", dst: "季度", source: "region" };
    const b = { x: 900, y: 700, w: 120, h: 24, src: "SEASON", dst: "季度", source: "whole" };
    eq(V._dedupe([a, b]).length, 2, "同名标签出现在两处 → 都保留");
  }

  // 3.4 三条重复（两条区域 + 一条整图）→ 只剩一条
  {
    const r1 = { x: 100, y: 100, w: 200, h: 30, src: "PIECE COUNT", dst: "部件数量", source: "region" };
    const r2 = { x: 102, y: 101, w: 200, h: 30, src: "PIECE COUNT", dst: "部件数量", source: "region" };
    const w1 = { x: 105, y: 100, w: 200, h: 30, src: "PIECE COUNT", dst: "件数", source: "whole" };
    eq(V._dedupe([r1, r2, w1]).length, 1, "三条互相重叠的重复项合并成 1 条");
  }

  // 3.5 轻微 OCR 差异（一个字母错）仍应判为重复
  {
    const a = { x: 0, y: 0, w: 300, h: 30, src: "MATERIAL SPEC", dst: "材质规格", source: "region" };
    const b = { x: 2, y: 1, w: 300, h: 30, src: "MATERlAL SPEC", dst: "材质规格", source: "whole" };
    eq(V._dedupe([a, b]).length, 1, "只差一个字符的 OCR 抖动仍判为重复");
  }

  // 3.6 结果要按阅读顺序（先上后下、先左后右）排好。
  // 数据：同一行 y=10 上有 A(x=10)、C(x=200)、B(x=500)，另有一条 D 在 y=300。
  // 正确的阅读顺序就是 A → C → B → D（B 在 C 右边很远处，仍属同一行）。
  {
    const items = [
      { x: 500, y: 10, w: 100, h: 20, src: "B", dst: "B", source: "region" },
      { x: 10, y: 300, w: 100, h: 20, src: "D", dst: "D", source: "region" },
      { x: 10, y: 10, w: 100, h: 20, src: "A", dst: "A", source: "region" },
      { x: 200, y: 10, w: 100, h: 20, src: "C", dst: "C", source: "region" },
    ];
    const out = V._dedupe(items);
    eq(out.map(function (i) { return i.src; }), ["A", "C", "B", "D"], "输出按阅读顺序排列");
    eq(
      out.map(function (i) { return i.x; }),
      [10, 200, 500, 10],
      "同一行内按 x 递增，下一行排在后面"
    );
  }

  // 3.7 空输入 / 脏输入
  {
    eq(V._dedupe([]), [], "空数组 → 空数组");
    eq(V._dedupe(null), [], "null → 空数组");
    eq(
      V._dedupe([{ x: 0, y: 0, w: 0, h: 0, src: "X", source: "region" }]).length,
      0,
      "零面积条目被过滤"
    );
  }
})();

/* ============================================================
 * 4. _endpoint —— 端点拼接
 * ============================================================ */

section("4. _endpoint 端点拼接");

(function testEndpoint() {
  const CHAT = "chat";
  const MODELS = "models";

  // 4.1 Gemini：baseUrl 有没有带 /v1beta、/models、:generateContent 都要能拼对
  const geminiChat = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
  const geminiBases = [
    "https://generativelanguage.googleapis.com",
    "https://generativelanguage.googleapis.com/",
    "https://generativelanguage.googleapis.com/v1beta",
    "https://generativelanguage.googleapis.com/v1beta/",
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://generativelanguage.googleapis.com/v1beta/models/",
    "https://generativelanguage.googleapis.com/v1",
    "generativelanguage.googleapis.com",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  ];
  geminiBases.forEach(function (b) {
    eq(V._endpoint(b, CHAT, "gemini"), geminiChat, "gemini chat ← " + b);
  });
  geminiBases.slice(0, 8).forEach(function (b) {
    eq(
      V._endpoint(b, MODELS, "gemini"),
      "https://generativelanguage.googleapis.com/v1beta/models",
      "gemini models ← " + b
    );
  });

  // 4.2 OpenAI 兼容
  const openaiCases = [
    ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com", "https://api.openai.com/v1/chat/completions"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"],
    ["https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"],
    ["https://api.deepseek.com/", "https://api.deepseek.com/v1/chat/completions"],
    ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"],
    [
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ],
    [
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ],
    [
      "https://open.bigmodel.cn/api/paas/v4",
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    ],
    ["https://api.siliconflow.cn/v1", "https://api.siliconflow.cn/v1/chat/completions"],
    [
      "https://my-gateway.example.com/proxy/openai/v1/",
      "https://my-gateway.example.com/proxy/openai/v1/chat/completions",
    ],
    [
      "http://127.0.0.1:11434/v1",
      "http://127.0.0.1:11434/v1/chat/completions",
    ],
  ];
  openaiCases.forEach(function (pair) {
    eq(V._endpoint(pair[0], CHAT, "openai"), pair[1], "openai chat ← " + pair[0]);
  });

  // 4.3 models 端点
  eq(V._endpoint("https://api.openai.com/v1", MODELS, "openai"), "https://api.openai.com/v1/models", "openai models ← /v1");
  eq(V._endpoint("https://api.deepseek.com", MODELS, "openai"), "https://api.deepseek.com/v1/models", "openai models ← 裸域名");
  eq(
    V._endpoint("https://api.openai.com/v1/chat/completions", MODELS, "openai"),
    "https://api.openai.com/v1/models",
    "openai models ← 已含 /chat/completions"
  );

  // 4.4 空 baseUrl 走各家默认
  eq(V._endpoint("", CHAT, "gemini"), geminiChat, "空 baseUrl → Gemini 默认端点");
  eq(V._endpoint(null, CHAT, "openai"), "https://api.openai.com/v1/chat/completions", "空 baseUrl → OpenAI 默认端点");

  // 4.5 模型名归一化
  eq(V._normalizeModel("models/gemini-2.5-flash", "gemini"), "gemini-2.5-flash", "剥掉 models/ 前缀");
  eq(V._normalizeModel("  gpt-4o-mini  ", "openai"), "gpt-4o-mini", "去掉首尾空格");
  eq(V._normalizeModel("", "gemini"), "gemini-2.5-flash", "空模型名 → Gemini 兜底");
  eq(V._normalizeModel("", "openai"), "gpt-4o-mini", "空模型名 → OpenAI 兜底");
  eq(
    V._normalizeModel("https://x.example.com/v1beta/models/gemini-2.5-pro", "gemini"),
    "gemini-2.5-pro",
    "用户误贴完整 URL 时也能取出模型名"
  );
})();

/* ============================================================
 * 5. _cropForRegion —— 裁切放大计划
 * ============================================================ */

section("5. _cropForRegion 裁切放大");

(function testCropPlan() {
  const L = C.LIMITS;
  const W = 2000;
  const H = 3000;

  // 5.1 中等区域放大到 regionCropMinSide
  // 区域 500×200 → pad = round(500*0.12) = 60 → 裁切块 620×320
  // scale = clamp(640/620, 1, 4) = 1.032
  const mid = V._cropForRegion({ x: 100, y: 100, w: 500, h: 200 }, W, H);
  eq({ w: mid.w, h: mid.h, pad: mid.pad }, { w: 620, h: 320, pad: 60 }, "中等区域外扩后的裁切尺寸正确");
  near(mid.scale, 640 / 620, 0.001, "中等区域 scale = regionCropMinSide / 长边 = 640/620");
  near(
    Math.max(mid.w, mid.h) * mid.scale,
    L.regionCropMinSide,
    1.5,
    "中等区域放大后长边 ≈ regionCropMinSide(" + L.regionCropMinSide + ")"
  );
  check(mid.scale >= 1, "只放大不缩小（scale=" + mid.scale.toFixed(3) + "）");

  // 小区域（题目场景）：60×20 外扩后 80×44，理想 scale=8，被 regionCropZoomMax=4 卡住 →
  // 放大后长边 = 80*4 = 320。这是刻意的：为了凑 640 无限放大会把糊字放大成更大的糊块。
  const small = V._cropForRegion({ x: 500, y: 500, w: 60, h: 20 }, W, H);
  eq(small.scale, L.regionCropZoomMax, "小区域放大倍数被 regionCropZoomMax 卡在 " + L.regionCropZoomMax);
  check(
    Math.max(small.w, small.h) * small.scale <= L.regionCropMaxSide,
    "小区域放大后仍在 regionCropMaxSide 以内"
  );
  check(small.scale >= 1, "小区域只放大不缩小");

  // 5.2 放大倍数有上限（regionCropZoomMax），不能为了凑 640 无限放大
  const tiny = V._cropForRegion({ x: 100, y: 100, w: 20, h: 10 }, W, H);
  check(
    tiny.scale <= L.regionCropZoomMax + 1e-9,
    "极小区域放大倍数被 regionCropZoomMax 卡住（scale=" + tiny.scale.toFixed(2) + "）"
  );

  // 5.3 大区域放大后长边不超过 regionCropMaxSide
  const big = V._cropForRegion({ x: 0, y: 0, w: 1600, h: 1200 }, W, H);
  check(
    Math.max(big.w, big.h) * big.scale <= L.regionCropMaxSide + 1.5,
    "大区域放大后长边 ≤ regionCropMaxSide(" + L.regionCropMaxSide + ")，实际 " +
      (Math.max(big.w, big.h) * big.scale).toFixed(1)
  );

  // 5.4 外扩：裁切框要比区域本身大（pad 按 regionCropPadRatio）
  const reg = { x: 500, y: 500, w: 200, h: 100 };
  const plan = V._cropForRegion(reg, W, H);
  check(plan.w > reg.w && plan.h > reg.h, "区域被外扩了（" + reg.w + "×" + reg.h + " → " + plan.w + "×" + plan.h + "）");
  near(plan.pad, Math.round(200 * L.regionCropPadRatio), 0.5, "pad = 长边 × regionCropPadRatio");
  eq({ x: plan.x, y: plan.y }, { x: 500 - plan.pad, y: 500 - plan.pad }, "外扩以左上角为基准");

  // 5.5 贴边区域不能让裁切框跑出图外
  const corner = V._cropForRegion({ x: 0, y: 0, w: 300, h: 200 }, W, H);
  eq({ x: corner.x, y: corner.y }, { x: 0, y: 0 }, "贴左上角的区域从 (0,0) 开始裁");
  check(corner.x + corner.w <= W && corner.y + corner.h <= H, "裁切框不越出整图");

  const br = V._cropForRegion({ x: W - 40, y: H - 30, w: 40, h: 30 }, W, H);
  check(br.x + br.w <= W && br.y + br.h <= H, "贴右下角的区域也不越界");

  // 5.6 完全在图外的区域不能产生 NaN，且尺寸至少 1px
  const outside = V._cropForRegion({ x: 99999, y: 99999, w: 50, h: 50 }, W, H);
  check(
    isFinite(outside.scale) && outside.scale > 0 && outside.w >= 1 && outside.h >= 1,
    "图外区域得到合法（不 NaN）的裁切计划",
    JSON.stringify(outside)
  );

  // 5.7 limits 可以被调用方覆盖
  const custom = V._cropForRegion({ x: 100, y: 100, w: 60, h: 20 }, W, H, {
    limits: { regionCropMinSide: 320, regionCropZoomMax: 3 },
  });
  check(custom.scale <= 3 + 1e-9, "自定义 limits 生效（放大上限 3）");
})();

/* ============================================================
 * 6. 提示词回归测试 —— 防领域过拟合
 * ============================================================ */

section("6. 提示词：必须来自 PZConfig，且无领域词硬编码");

(function testPrompts() {
  // 领域词黑名单：这些词只允许从 profileHint / glossaryEntries 进来，
  // 绝不允许出现在 vision.js 拼出来的通用提示词里。
  //
  // ⚠ 真实客户/品牌名不写在这里（仓库是公开的）：放在仓库外的
  // test/domain-words.local.txt，有它就用它，没有就用下面这些占位名。
  const LOCAL_WORDS_FILE = path.join(__dirname, "domain-words.local.txt");
  let BRAND_WORDS = ["acme", "Acme", "ACME", "Widgetco", "CHARACTER A", "CHARACTER B", "eduapp"];
  if (fs.existsSync(LOCAL_WORDS_FILE)) {
    const lines = fs
      .readFileSync(LOCAL_WORDS_FILE, "utf8")
      .split(/\r?\n/)
      .map(function (l) {
        return l.trim();
      })
      .filter(function (l) {
        return l && l.charAt(0) !== "#";
      });
    if (lines.length) BRAND_WORDS = lines;
  }
  const DOMAIN_WORDS = BRAND_WORDS.concat([
    "玩具", "毛绒", "角色", "刺绣", "贴布绣", "印花", "渐变", "材质规格",
    "规格图", "规格表", "产品规格",
    "PANTONE", "PMS", "plush",
  ]);

  const plainRegion = C.buildRegionPrompt({ targetLang: "zh-CN" });
  const plainWhole = C.buildWholePrompt({ targetLang: "zh-CN" });

  DOMAIN_WORDS.forEach(function (w) {
    check(plainRegion.indexOf(w) < 0, "区域提示词不含领域词「" + w + "」");
  });
  DOMAIN_WORDS.forEach(function (w) {
    check(plainWhole.indexOf(w) < 0, "整图提示词不含领域词「" + w + "」");
  });

  // 但通用规则必须在
  check(plainRegion.indexOf("0-1000") >= 0, "区域提示词含坐标归一化说明");
  check(plainRegion.indexOf("translation") >= 0, "默认（翻译）区域提示词要求 translation 字段");
  check(plainWhole.indexOf("translation") >= 0, "默认（翻译）整图提示词要求 translation 字段");
  check(plainRegion.indexOf("简体中文") >= 0, "区域提示词含目标语言");
  check(C.buildRegionPrompt({ targetLang: "zh-TW" }).indexOf("繁體中文") >= 0, "zh-TW 目标语言正确");

  // 传了 profileHint 才允许出现领域词 —— 也就是"可配置"
  const hinted = C.buildRegionPrompt({ targetLang: "zh-CN", profileHint: "这是客户 A 的行业资料" });
  check(hinted.indexOf("客户 A 的行业资料") >= 0, "只有传了 profileHint 才出现领域词（证明领域说明是可配置的）");

  // 术语表同理
  const gloss = C.parseGlossary("SAMPLE TERM => 示例术语");
  const withGloss = C.buildRegionPrompt({ targetLang: "zh-CN", glossaryEntries: gloss });
  check(withGloss.indexOf("示例术语") >= 0, "只有传了术语表才出现术语");

  // 只识别（translate:false）：不能出现"翻译"要求，也不要求 translation 字段
  const noTransRegion = C.buildRegionPrompt({ targetLang: "zh-CN", translate: false });
  const noTransWhole = C.buildWholePrompt({ targetLang: "zh-CN", translate: false });
  check(noTransRegion.indexOf("翻译") < 0, "translate:false 的区域提示词一个「翻译」都没有");
  check(noTransWhole.indexOf("翻译") < 0, "translate:false 的整图提示词一个「翻译」都没有");
  check(noTransRegion.indexOf("translation") < 0, "translate:false 时不要求 translation 字段");
  check(noTransWhole.indexOf("translation") < 0, "translate:false 的整图也不要求 translation 字段");
  check(noTransRegion.indexOf("box") >= 0, "translate:false 仍要求坐标");
  check(noTransRegion.indexOf("识别") >= 0, "translate:false 仍要求识别");

  // vision.js 自己的提示词构建器必须直接转发给 PZConfig（不能自己另写一份）
  check(typeof V._buildPrompt === "function", "_buildPrompt 已导出");
  eq(V._buildPrompt("region", { targetLang: "zh-CN" }), C.buildRegionPrompt({ targetLang: "zh-CN" }), "vision 的区域提示词 === PZConfig.buildRegionPrompt");
  eq(V._buildPrompt("whole", { targetLang: "zh-CN" }), C.buildWholePrompt({ targetLang: "zh-CN" }), "vision 的整图提示词 === PZConfig.buildWholePrompt");

  // vision.js 源码里不能出现领域词（真正的"防过拟合"回归断言）
  const src = fs.readFileSync(path.join(ROOT, "js", "vision.js"), "utf8");
  BRAND_WORDS.concat(["玩具", "毛绒", "规格图", "刺绣", "PANTONE"]).forEach(function (w) {
    check(src.indexOf(w) < 0, "vision.js 源码里没有领域词「" + w + "」");
  });
  // 反向确认：本测试文件的"领域词黑名单"本身是有内容的
  check(DOMAIN_WORDS.length >= 15, "黑名单覆盖了足够多的领域词（" + DOMAIN_WORDS.length + " 个）");
})();

/* ============================================================
 * 7. 响应文本抽取（协议差异）
 * ============================================================ */

section("7. _extractModelText 协议兼容");

(function testExtract() {
  // Gemini：parts 有多段，必须全部拼接（原实现只取 [0]，吃过亏）
  const gem = V._extractModelText("gemini", {
    candidates: [
      {
        content: {
          parts: [{ text: '{"items":[' }, { text: '{"text":"A","box":[0,0,1,1]}' }, { text: "]}" }],
        },
      },
    ],
  });
  eq(gem, '{"items":[{"text":"A","box":[0,0,1,1]}]}', "Gemini 多 part 被完整拼接");
  const parsed = V._parseItems(gem);
  eq(parsed.length, 1, "拼接后的文本能被 _parseItems 解析");
  eq(parsed[0].src, "A", "解析出的原文正确");

  // Gemini：多个 candidates
  eq(
    V._extractModelText("gemini", { candidates: [{ content: { parts: [{ text: "x" }] } }, { content: { parts: [{ text: "y" }] } }] }),
    "xy",
    "多个 candidates 也被拼接"
  );

  // OpenAI：content 是字符串
  eq(
    V._extractModelText("openai", { choices: [{ message: { content: "hello" } }] }),
    "hello",
    "OpenAI content 字符串"
  );

  // OpenAI：content 是数组（不少国产兼容网关如此）
  eq(
    V._extractModelText("openai", {
      choices: [{ message: { content: [{ type: "text", text: "部分一" }, { type: "text", text: "部分二" }] } }],
    }),
    "部分一部分二",
    "OpenAI content 为数组时兼容"
  );

  // 空 / 异常
  eq(V._extractModelText("openai", null), "", "null 响应 → 空串");
  eq(V._extractModelText("openai", {}), "", "空对象响应 → 空串");
  eq(V._extractModelText("gemini", { candidates: [] }), "", "空 candidates → 空串");
})();

/* ============================================================
 * 8. 杂项：文本清理 / 接口完整性 / 入参校验
 * ============================================================ */

function testMisc() {
  section("8. 杂项：文本清理 / 接口完整性 / 入参校验");
  eq(V._cleanText("  MATERIAL   SPEC \n"), "MATERIAL SPEC", "多余空白被压掉");
  eq(V._cleanText('"Front"'), "Front", "首尾引号被去掉");
  eq(V._cleanText("“EMBROIDERY”"), "EMBROIDERY", "中文引号也被去掉");
  eq(V._cleanText('- Front:'), "Front", "前缀项目符号与尾部冒号被去掉");
  eq(V._cleanText('3.5"'), '3.5"', "数字后面的引号（英寸）保留，不能被当成噪声剥掉");
  eq(V._cleanText('12" x 8"'), '12" x 8"', "尺寸里的英寸符号原样保留");
  eq(V._cleanText(null), "", "null → 空串");

  // 契约要求的方法必须都在
  ["translate", "testKey", "listModels"].forEach(function (m) {
    check(typeof V[m] === "function", "PZVision." + m + " 已导出");
  });
  ["_mapBoxFromCrop", "_dedupe", "_parseItems", "_endpoint", "_cropForRegion"].forEach(function (m) {
    check(typeof V[m] === "function", "PZVision." + m + " 已导出（供单测）");
  });

  // translate 的入参校验（不联网就能验证的失败路径）
  const p1 = V.translate(null, { apiKey: "fake-key-for-validation" }).then(
    function () { return null; },
    function (e) { return e; }
  );
  const p2 = V.translate({ width: 10, height: 10 }, {}).then(
    function () { return null; },
    function (e) { return e; }
  );
  return Promise.all([p1, p2]).then(function (errs) {
    check(errs[0] instanceof Error, "translate(null) 明确抛错");
    check(/画布/.test(errs[0] && errs[0].message), "抛错信息说明是画布问题：" + (errs[0] && errs[0].message));
    check(errs[1] instanceof Error, "缺 API Key 时明确抛错");
    check(/Key/.test(errs[1] && errs[1].message), "抛错信息说明是 Key 问题：" + (errs[1] && errs[1].message));
  });
}

/* ============================================================
 * 9. 失败必须大声报错（用假的画布与假 fetch，不联网）
 *
 * 这是整个模块最要紧的一条安全性质：
 *   "全部区域都失败" 与 "图里真的没字" 结果都是一组空 items，
 *   但前者必须抛错 —— 否则用户会以为图里没字，
 *   比明确报错糟糕得多。
 * ============================================================ */

function makeFakeCanvas(w, h) {
  const ctx = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "",
    fillRect: function () {},
    drawImage: function () {},
  };
  return {
    width: w,
    height: h,
    getContext: function () { return ctx; },
    toDataURL: function () { return "data:image/jpeg;base64,AAAA"; },
  };
}

/**
 * 在"假画布 + 指定 fetch"的环境里跑一段逻辑。
 *
 * 关键点：**断言必须在 stub 生效期间执行**。
 * 之前把断言写在 .then 里、stub 一 resolve 就还原，结果断言跑在真实环境里，
 * 一碰 canvas 就抛"没有 document"，测出来的是假现象。
 * 所以这里把 done 回调一起放进 stub 窗口内。
 */
function withStubs(fetchStub, done) {
  if (typeof fetchStub === "function" && arguments.length === 1) {
    // 兼容单参数写法：fn 自己负责设置 fetch，返回值即结果
    done = null;
  }
  // 注意：必须走 PZUtil.setCanvasFactory，不能直接替换 PZUtil.createCanvas。
  // util.js 里的 cropCanvas/cloneCanvas 通过闭包引用模块私有的 canvasFactory，
  // 从外面改 PZUtil.createCanvas 对它们完全无效（踩过这个坑）。
  U.setCanvasFactory(function (w, h) {
    return makeFakeCanvas(Math.max(1, w || 1), Math.max(1, h || 1));
  });
  const savedCtx = U.ctx2d;
  const savedFetch = globalThis.fetch;
  U.ctx2d = function (c) { return c.getContext("2d"); };
  if (typeof fetchStub === "function" && done) globalThis.fetch = fetchStub;

  const restore = function () {
    // 复原成 util.js 原本那个"没有 document 就报错"的工厂
    U.setCanvasFactory(REAL_FACTORY);
    U.ctx2d = savedCtx;
    if (savedFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = savedFetch;
  };

  const inside = function () {
    if (done) {
      // 两参数写法：fetchStub 负责造响应，done 负责跑请求 + 断言
      return done();
    }
    return fetchStub();
  };

  const settle = function (value) {
    // 断言可能返回 promise（链式断言），等它跑完再还原 stub
    return Promise.resolve(value).then(
      function (r) {
        restore();
        return r;
      },
      function (e) {
        restore();
        throw e;
      }
    );
  };

  try {
    return settle(inside());
  } catch (e) {
    restore();
    return Promise.reject(e);
  }
}

/**
 * 这些情形必须【串行】跑：每个都要临时替换全局 fetch 与 PZUtil.createCanvas，
 * 并行跑会互相覆盖对方的 stub，得到的是假结果。
 */
function testFailurePaths() {
  section("9. 全部失败必须抛错（假 fetch + 假画布）");
  const canvas = makeFakeCanvas(800, 600);
  const fakeRegions = [
    { x: 20, y: 20, w: 200, h: 40 },
    { x: 300, y: 200, w: 240, h: 60 },
    { x: 500, y: 420, w: 180, h: 40 },
  ];
  const steps = [];
  const add = function (fn) { steps.push(fn); };

  /** 造一个"固定响应"的 fetch stub */
  const resp = function (status, body) {
    return function () {
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status: status,
        headers: { get: function () { return null; } },
        json: function () { return Promise.resolve(body); },
      });
    };
  };
  /** 造一个"直接网络失败"的 fetch stub */
  const boom = function (msg) {
    return function () { return Promise.reject(new Error(msg)); };
  };
  /** 把 translate 的成功/失败都收敛成一个可断言的对象 */
  const settle = function (p) {
    return p.then(
      function (r) { return { ok: true, r: r }; },
      function (e) { return { ok: false, e: e }; }
    );
  };

  // 情形 A：每个请求都 500（不是 429，退避重试后仍然失败）
  // 期望：抛出最后一次错误，并且错误信息说清是"所有区域都失败了"
  add(function () {
    return withStubs(resp(500, { error: { message: "boom" } }), function () {
      return settle(V.translate(canvas, {
        api: "openai",
        apiKey: "fake",
        baseUrl: "https://example.invalid/v1",
        model: "fake-model",
        regions: fakeRegions,
        wholeImage: false,
        concurrency: 2,
        timeoutMs: 8000,
      })).then(function (res) {
        check(!res.ok, "全部区域 500 时 translate 抛错（没有静默返回空数组）");
        const msg = res.ok ? "" : String(res.e.message);
        check(
          /所有区域识别都失败了/.test(msg),
          "抛错信息明确说明「所有区域都失败了」：" + msg.slice(0, 80)
        );
        check(
          (res.e && res.e.failed) === fakeRegions.length,
          "抛错对象带上 failed=" + (res.e && res.e.failed) + "（预期 " + fakeRegions.length + "）"
        );
      });
    });
  });

  // 情形 B：401 —— 不该重试，直接报错并把服务端原文透传出来
  add(function () {
    return withStubs(resp(401, { error: { message: "invalid key" } }), function () {
      return settle(V.translate(canvas, {
        api: "gemini",
        apiKey: "bad-key",
        baseUrl: "https://example.invalid",
        model: "gemini-2.5-flash",
        regions: fakeRegions.slice(0, 1),
        wholeImage: false,
        concurrency: 1,
        timeoutMs: 8000,
      })).then(function (res) {
        check(!res.ok, "401 时 translate 抛错");
        check(
          !res.ok && /401/.test(res.e.message) && /invalid key/.test(res.e.message),
          "错误信息带上 HTTP 状态与服务端原文：" + String(res.ok ? "" : res.e.message).slice(0, 80)
        );
      });
    });
  });

  // 情形 C：HTTP 200，但返回的是一段完全解析不了的废话
  // 期望：抛错 —— "解析不出来"不等于"图里没字"
  add(function () {
    return withStubs(
      resp(200, { choices: [{ message: { content: "完全不是 JSON 的一段话" } }] }),
      function () {
        return settle(V.translate(canvas, {
          api: "openai",
          apiKey: "fake",
          baseUrl: "https://example.invalid/v1",
          model: "fake-model",
          regions: [],
          wholeImage: true,
          concurrency: 1,
          timeoutMs: 8000,
        })).then(function (res) {
          check(!res.ok, "整图返回无法解析的废话时抛错（不把解析失败当成没字）");
          check(
            !res.ok && /无法解析|不可信/.test(res.e.message),
            "错误信息说明了是解析/失败问题：" + String(res.ok ? "" : res.e.message).slice(0, 80)
          );
        });
      }
    );
  });

  // 情形 C2：模型规规矩矩回 {"items":[]} —— 这才是"图里确实没字"，应正常返回 0 条
  add(function () {
    return withStubs(
      resp(200, { choices: [{ message: { content: '{"items":[]}' } }] }),
      function () {
        return settle(V.translate(canvas, {
          api: "openai",
          apiKey: "fake",
          baseUrl: "https://example.invalid/v1",
          model: "fake-model",
          regions: [],
          wholeImage: true,
          concurrency: 1,
          timeoutMs: 8000,
        })).then(function (res) {
          check(res.ok, "模型明确返回空 items 时正常返回（不误报错误）");
          check(res.ok && res.r.items.length === 0, "空 items → 0 条结果", res.ok ? "" : String(res.e.message));
          check(res.ok && res.r.stats.requests === 1, "只发了 1 次请求（regions 为空 + 整图兜底）");
          check(res.ok && res.r.stats.failed === 0, "没有失败计数");
        });
      }
    );
  });

  // 情形 D：只有整图兜底这一遍，而它网络直接失败
  // 期望：抛错。以前这里会静默返回空数组 —— 用户就会以为整页没字。
  add(function () {
    return withStubs(boom("network down"), function () {
      return settle(V.translate(canvas, {
        api: "openai",
        apiKey: "fake",
        baseUrl: "https://example.invalid/v1",
        model: "fake-model",
        regions: [],
        wholeImage: true,
        concurrency: 1,
        timeoutMs: 8000,
        limits: { visionImageMaxSide: 400 },
      })).then(function (res) {
        check(!res.ok, "整图兜底网络失败时 translate 抛错，不返回空数组");
        check(
          !res.ok && /不可信|失败/.test(res.e.message),
          "错误信息说清是失败导致结果不可信：" + String(res.ok ? "" : res.e.message).slice(0, 80)
        );
      });
    });
  });

  // 情形 E：区域遍真的有一个区域彻底失败（3 次请求都没成），但另一个区域 + 整图兜底成功了
  // 期望：不抛错，成功那些结果照常返回，stats.failed 记 1。
  // 顺带验证一件事：**重试后成功的请求不算失败** —— 第 1 个区域重试前 3 次都失败，
  // 但最终的成功结果仍然被采纳，失败计数只统计"彻底没成"的那些。
  add(function () {
    const makeBody = function (text) {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ text: text, translation: text + "（译）", box: [100, 100, 400, 160] }],
              }),
            },
          },
        ],
      };
    };
    // 只喂 2 个区域：第 1 个彻底失败，第 2 个成功，最后整图兜底成功
    const twoRegions = [
      { x: 20, y: 20, w: 300, h: 120 },     // 区域 #1
      { x: 400, y: 300, w: 300, h: 120 },   // 区域 #2
    ];
    let call = 0;
    const flaky = function () {
      call++;
      // 区域 #1 会被重试 3 次（MAX_RETRIES=2）：第 1~3 次全部网络失败
      if (call <= 3) return Promise.reject(new Error("region #1 blew up"));
      // 区域 #2 与整图兜底：返回不同文本，避免被去重合并成一条
      return resp(200, makeBody(call === 4 ? "REGION TWO" : "WHOLE PASS"))();
    };
    return withStubs(flaky, function () {
      return settle(V.translate(canvas, {
        api: "openai",
        apiKey: "fake",
        baseUrl: "https://example.invalid/v1",
        model: "fake-model",
        regions: twoRegions,
        maxRegions: 2,
        wholeImage: true,
        concurrency: 1,
        timeoutMs: 8000,
        limits: { visionImageMaxSide: 800 },
      })).then(function (res) {
        check(res.ok, "一个区域彻底失败但整体有结果时照常返回（不因为局部挂掉就整体失败）");
        if (!res.ok) {
          check(false, "详情：" + res.e.message);
          return;
        }
        check(res.r.stats.regions === 2, "区域计数为 2");
        check(res.r.stats.failed === 1, "失败计数为 1（只有彻底没成的那个区域）", JSON.stringify(res.r.stats));
        check(res.r.stats.whole === true, "整图这一遍确实跑过了");
        const srcs = res.r.items.map(function (i) { return i.src; }).sort();
        check(
          srcs.indexOf("REGION TWO") >= 0,
          "重试后成功的那个区域的结果被采纳（重试成功不算失败）：" + JSON.stringify(srcs)
        );
        check(
          srcs.indexOf("WHOLE PASS") >= 0,
          "整图兜底的结果也在：" + JSON.stringify(srcs)
        );
        check(
          res.r.stats.errors.length === 1 && /区域#1/.test(res.r.stats.errors[0]),
          "stats.errors 记录了是哪个区域失败：" + JSON.stringify(res.r.stats.errors)
        );
      });
    });
  });

  // 串行执行
  let chain = Promise.resolve();
  steps.forEach(function (fn) {
    chain = chain.then(fn);
  });
  return chain;
}

/* ============================================================
 * 汇总
 * ============================================================ */

testMisc()
  .then(function () { return testFailurePaths(); })
  .then(function () {
    console.log("\n" + "=".repeat(66));
    const total = passed + failed;
    if (failed === 0) {
      console.log("结果：全部通过   共 " + total + " 项断言，失败 0 项");
    } else {
      console.log("结果：有失败   共 " + total + " 项断言，通过 " + passed + "，失败 " + failed);
      console.log("\n失败明细：");
      failures.forEach(function (f) { console.log("  - " + f); });
      process.exitCode = 1;
    }
    console.log("=".repeat(66));
  })
  .catch(function (e) {
    console.error("测试脚本自身出错：" + ((e && e.stack) || e));
    process.exitCode = 1;
  });
