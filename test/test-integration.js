/**
 * 集成测试：验证跨模块的接口语义，重点是「坐标语义」这类一旦错了就肉眼可见的问题。
 *
 * 与其它测试文件的分工：
 *   run-tests.js       —— PZImage / PZDetect 的算法正确性（合成像素图）
 *   test-vision.js     —— PZVision 的协议与解析
 *   test-translate.js  —— PZTranslate 的术语表与端点拼接
 *   本文件             —— 模块之间的**契约语义**：坐标、数据形状、边界行为
 *
 * 这些文件都是经典脚本，会往 globalThis 挂东西，所以用 eval 直接加载。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const loadErrors = [];

function load(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    loadErrors.push(rel + " 不存在");
    return;
  }
  try {
    // eslint-disable-next-line no-eval
    (0, eval)(fs.readFileSync(full, "utf8"));
  } catch (err) {
    loadErrors.push(rel + " 加载失败：" + (err && err.message ? err.message : err));
  }
}

// 加载顺序与 index.html 保持一致
load("js/util.js");
load("js/config.js");
load("js/imageproc.js");
load("js/detect.js");
load("js/inpaint.js");
load("js/overlay.js");
load("js/ocr-local.js");
load("js/vision.js");
load("js/translate.js");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    failures.push(name + (detail ? "  → " + detail : ""));
    console.log("  ✗ " + name + (detail ? "  → " + detail : ""));
  }
}

console.log("\n[0] 模块加载");
loadErrors.forEach(function (e) {
  ok("加载 js/" + e, false, e);
});
if (!loadErrors.length) console.log("  ✓ 所有模块加载成功");

function near(a, b, tol) {
  return Math.abs(a - b) <= (tol == null ? 0.6 : tol);
}

function rectNear(actual, expected, tol, label) {
  if (!actual) return ok(label, false, "返回了 " + actual);
  const good =
    near(actual.x, expected.x, tol) &&
    near(actual.y, expected.y, tol) &&
    near(actual.w, expected.w, tol) &&
    near(actual.h, expected.h, tol);
  return ok(
    label,
    good,
    good
      ? ""
      : "得到 " +
        JSON.stringify({ x: Math.round(actual.x), y: Math.round(actual.y), w: Math.round(actual.w), h: Math.round(actual.h) }) +
        "，期望 " +
        JSON.stringify(expected)
  );
}

/* ============================================================
 * 1. PZUtil 基础
 * ============================================================ */

console.log("\n[1] PZUtil 基础");

{
  const U = globalThis.PZUtil;
  ok("PZUtil 已加载", !!U);

  ok("clamp 正常", U.clamp(5, 0, 3) === 3 && U.clamp(-1, 0, 3) === 0);

  ok("iou 完全相同 = 1", near(U.iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1, 1e-6));
  ok("iou 完全不相交 = 0", U.iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 }) === 0);

  // overlapRatio 取"较小框被覆盖的比例"，判断"同一行被识别两次"时比 iou 更合适
  const big = { x: 0, y: 0, w: 100, h: 20 };
  const small = { x: 10, y: 2, w: 20, h: 16 };
  ok("overlapRatio：小框完全落在大框内 = 1", near(U.overlapRatio(big, small), 1, 1e-6));
  ok(
    "iou 对这种包含关系会给出小值（说明为什么不能拿 iou 判重）",
    U.iou(big, small) < 0.25,
    "iou=" + U.iou(big, small).toFixed(3)
  );

  ok("sameText 完全相同", U.sameText("Material Spec", "material spec"));
  ok("sameText 容忍 OCR 错字", U.sameText("SEPARATE PIECE", "SEPARRTE PIECE"));
  ok("sameText 区分不同内容", !U.sameText("Front", "Back"));

  // extractJson 必须能吃下模型常见的各种脏输出
  ok("extractJson：裸 JSON", !!U.extractJson('{"items":[]}'));
  ok("extractJson：markdown 代码块", !!U.extractJson('```json\n{"items":[{"a":1}]}\n```'));
  ok("extractJson：前后有废话", !!U.extractJson('好的，结果如下：\n{"items":[1]}\n希望有帮助'));
  ok("extractJson：容忍尾逗号", !!U.extractJson('[{"a":1},]'));
  ok("extractJson：无法解析时返回 null", U.extractJson("这不是 JSON") === null);

  const coerced = U.coerceItems({ results: [{ text: "a" }] });
  ok("coerceItems：认识 results 键", Array.isArray(coerced) && coerced.length === 1);

  const wrapped = U.extractJson('{"items":[{"t":1}]}');
  ok("coerceItems：从 {items:[...]} 里取出数组", U.coerceItems(wrapped).length === 1);
}

/* ============================================================
 * 2. 坐标语义 —— 这是最容易错、且一错就肉眼可见的地方
 * ============================================================ */

console.log("\n[2] 坐标语义（PZVision 的裁切坐标 → 整图坐标）");

if (!globalThis.PZVision) {
  console.log("  ! PZVision 未加载，跳过这一节");
} else {
  const V = globalThis.PZVision;

  // PZUtil.cropCanvas 挂在画布上的 _cropOffset 语义：
  //   x, y       = 裁切框在**整图**中的左上角（原图像素）
  //   srcW, srcH = 裁切框在**放大前**的尺寸（原图像素）
  //   scale      = 放大倍数
  //   ⇒ 交给模型的裁切画布尺寸 = srcW*scale × srcH*scale
  //
  // 模型返回的 box 是相对**放大后的裁切画布**的 0-1000 归一化值。
  // 所以：整图坐标 = offset.x + (box/1000) * srcW          （注意：不再除 scale）
  //
  // 推导：裁切画布内的像素 cropX = (box/1000) * srcW * scale
  //       整图像素 = offset.x + cropX / scale = offset.x + (box/1000) * srcW
  const off = { x: 100, y: 50, scale: 2, srcW: 100, srcH: 60 };
  const IMG_W = 1000;
  const IMG_H = 800;

  rectNear(
    V._mapBoxFromCrop([0, 0, 1000, 1000], off, IMG_W, IMG_H, { w: 8, h: 8 }),
    { x: 100, y: 50, w: 100, h: 60 },
    1,
    "box 覆盖整张裁切图 → 映射回整图就是裁切框本身（scale=2）"
  );

  rectNear(
    V._mapBoxFromCrop([250, 250, 750, 750], off, IMG_W, IMG_H, { w: 8, h: 8 }),
    { x: 125, y: 65, w: 50, h: 30 },
    1,
    "box 取裁切图中间一半 → 整图坐标减半偏移（scale=2）"
  );

  // 换个放大倍数，结果必须一致 —— 这是判定"多除了一次 scale"的关键用例
  const off4 = { x: 100, y: 50, scale: 4, srcW: 100, srcH: 60 };
  rectNear(
    V._mapBoxFromCrop([0, 0, 1000, 1000], off4, IMG_W, IMG_H, { w: 8, h: 8 }),
    { x: 100, y: 50, w: 100, h: 60 },
    1,
    "同一裁切、scale=4 → 结果必须与 scale=2 相同（映射与放大倍数无关）"
  );

  // 不放大时也必须对
  const off1 = { x: 100, y: 50, scale: 1, srcW: 100, srcH: 60 };
  rectNear(
    V._mapBoxFromCrop([500, 0, 1000, 1000], off1, IMG_W, IMG_H, { w: 8, h: 8 }),
    { x: 150, y: 50, w: 50, h: 60 },
    1,
    "scale=1 时右半边映射正确"
  );

  // 越界钳制
  const clamped = V._mapBoxFromCrop([-200, -200, 1500, 1500], off, IMG_W, IMG_H, { w: 8, h: 8 });
  ok(
    "越界 box 被钳制在整图范围内",
    clamped.x >= 0 && clamped.y >= 0 && clamped.x + clamped.w <= IMG_W + 1 && clamped.y + clamped.h <= IMG_H + 1,
    JSON.stringify(clamped)
  );

  // 退化输入不能产生零宽零高（overlay 拿到会画成一条线）
  const degen = V._mapBoxFromCrop([0, 0, 0, 0], off, IMG_W, IMG_H, { w: 8, h: 8 });
  ok("退化 box 仍返回有效尺寸", degen.w > 0 && degen.h > 0, JSON.stringify(degen));
}

/* ============================================================
 * 3. 排版引擎
 * ============================================================ */

console.log("\n[3] 排版引擎（PZOverlay）");

{
  const OV = globalThis.PZOverlay;
  ok("PZOverlay 已加载", !!OV);

  // 假的 measure：每个字符宽 = fontSize，便于手算
  const measure = function (str, fs) {
    return str.length * fs;
  };

  // box 100×20，起始字号 floor(20*0.92)=18，8 个汉字
  //   fs=18 → 8*18=144 > 100，换行后 2 行，块高超过 allowH 27
  //   fs=14 → 2 行，块高 14*1.02*2 ≈ 28.6 也超过 27
  //   fs=12 → 8*12=96 ≤ 100，1 行 → 块高 12.2 ≤ 27 ✓
  const laid = OV.layoutText(measure, "中文中文中文中文", { x: 0, y: 0, w: 100, h: 20 }, {
    minFontSize: 6,
    allowH: 27,
  });
  ok("layoutText：放不下时会缩字号", laid.fontSize < 18, "fontSize=" + laid.fontSize);
  ok("layoutText：缩小后不再溢出允许高度", laid.blockH <= 27, "blockH=" + laid.blockH);
  ok("layoutText：确实发生了缩小", laid.shrunk === true);
  ok("layoutText：未标记纵向硬溢出", laid.overflow === false);
  // 横向要么真的放得下、要么是"轻微溢出"且幅度在允许范围内 —— 两者必居其一
  ok(
    "layoutText：横向宽度要么放得下，要么是受控的轻微溢出",
    laid.overflowX ? laid.widest <= 100 * 1.12 + 0.5 : laid.widest <= 100.5,
    "widest=" + laid.widest.toFixed(1) + " overflowX=" + laid.overflowX
  );

  // 极端窄框 + 长译文：必须标记 overflow 而不是返回 NaN
  const tight = OV.layoutText(
    measure,
    "这是一段非常长的译文需要塞进一个很小的框里面",
    { x: 0, y: 0, w: 30, h: 8 },
    { minFontSize: 6, allowH: 10 }
  );
  ok("layoutText：放不下时标记 overflow", tight.overflow === true);
  ok(
    "layoutText：放不下时仍返回有效字号与行数",
    tight.fontSize >= 6 && tight.lines.length > 0 && isFinite(tight.y),
    "fontSize=" + tight.fontSize + " lines=" + tight.lines.length
  );

  // 邻居约束：B 紧贴在 A 下方，A 的可用高度必须被压住，不能长到 B 身上
  const items = [
    { x: 0, y: 0, w: 100, h: 20 },
    { x: 0, y: 24, w: 100, h: 20 },
  ];
  const lim = OV.computeNeighborLimits(items, 500, 500, { maxGrowY: 1.35, gap: 3 });
  ok("computeNeighborLimits：A 的下边界被 B 挡住", lim[0].bottom <= 24, "bottom=" + lim[0].bottom);
  ok("computeNeighborLimits：A 的可用高度小于放到 1.35 倍", lim[0].allowH < 20 * 1.35, "allowH=" + lim[0].allowH);

  // 没有任何邻居时，最多放到 maxGrowY 倍
  const solo = OV.computeNeighborLimits([{ x: 0, y: 100, w: 100, h: 20 }], 500, 500, { maxGrowY: 1.35 });
  ok("computeNeighborLimits：无邻居时受 maxGrowY 限制", near(solo[0].allowH, 27, 0.6), "allowH=" + solo[0].allowH);

  // 换行禁忌：行首不该出现收尾标点
  const wrapped = OV.wrapText(measure, "中文，中文，中文", 40, 10);
  ok(
    "wrapText：行首不出现收尾标点",
    wrapped.every(function (l, i) {
      return i === 0 || "，。、；：？！）》」』】".indexOf(l.charAt(0)) < 0;
    }),
    JSON.stringify(wrapped)
  );

  // 英文按空格断词，不硬拆
  const en = OV.wrapText(measure, "Material Specification Sheet", 60, 10);
  ok("wrapText：英文换行不出现半截单词", en.every(function (l) {
    return l.trim() === l && l.length > 0;
  }), JSON.stringify(en));
}

/* ============================================================
 * 4. 本地 OCR 的条带规划与结果解析
 * ============================================================ */

console.log("\n[4] 本地 OCR（PZOcr）");

if (!globalThis.PZOcr) {
  console.log("  ! PZOcr 未加载，跳过这一节");
} else {
  const O = globalThis.PZOcr;

  // 小字行与大标题行混排：小字那一组应该拿到更大的放大倍数
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push({ x: 50, y: 50 + i * 20, w: 200, h: 8 });
  for (let i = 0; i < 2; i++) lines.push({ x: 50, y: 300 + i * 60, w: 400, h: 40 });

  const bands = O.planBands(lines, 1200, 800, { maxBands: 10, maxZoom: 4 });
  ok("planBands：产生了条带", bands.length > 0, "条带数=" + bands.length);
  ok("planBands：条带数不超过上限", bands.length <= 10, "条带数=" + bands.length);

  const smallBand = bands.filter(function (b) {
    return b.medH <= 10;
  })[0];
  const bigBand = bands.filter(function (b) {
    return b.medH >= 30;
  })[0];
  ok("planBands：小字行高被正确识别", !!smallBand, "band medH 列表=" + bands.map(function (b) { return Math.round(b.medH); }).join(","));
  ok("planBands：大字行高被正确识别", !!bigBand);
  if (smallBand && bigBand) {
    ok(
      "planBands：小字的放大倍数严格大于大字（这是小字能被认出来的关键）",
      smallBand.zoom > bigBand.zoom,
      "小字 zoom=" + smallBand.zoom.toFixed(2) + " 大字 zoom=" + bigBand.zoom.toFixed(2)
    );
    ok("planBands：放大倍数不超过上限", smallBand.zoom <= 4.0001, "zoom=" + smallBand.zoom);
  }

  // 条带不能越出图片边界
  ok(
    "planBands：条带不越界",
    bands.every(function (b) {
      return b.x >= 0 && b.y >= 0 && b.x + b.w <= 1200 && b.y + b.h <= 800;
    })
  );

  // 超过上限时应该合并而不是丢弃
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ x: 50, y: 20 + i * 30, w: 200, h: 8 });
  const mergedBands = O.planBands(many, 1200, 2000, { maxBands: 5 });
  ok("planBands：条带超限时合并到上限内", mergedBands.length <= 5, "条带数=" + mergedBands.length);

  // TSV 解析（Tesseract v4 / v5 结构一致，是最可靠的取数方式）
  //
  // 注意 level=1..4 那几行的 conf 字段**恒为 -1** —— Tesseract 只填 level=5（词）的
  // 置信度。这个细节是照真实输出抄的，不是编的：早先的 fixture 在这里写了 92.5，
  // 于是漏掉了"行级 conf 取到 -1 → 被垃圾过滤器全数误杀 → 本地 OCR 恒返回 0 行"
  // 这个只有拿真实图片跑端到端才会暴露的 bug。
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t1000\t700\t-1\t",
    "2\t1\t1\t0\t0\t0\t10\t20\t120\t16\t-1\t",
    "3\t1\t1\t1\t0\t0\t10\t20\t120\t16\t-1\t",
    "4\t1\t1\t1\t1\t0\t10\t20\t120\t16\t-1\t",
    "5\t1\t1\t1\t1\t1\t10\t20\t50\t16\t95.0\tMATERIAL",
    "5\t1\t1\t1\t1\t2\t65\t20\t65\t16\t90.0\tSPEC",
    "4\t1\t1\t1\t2\t0\t10\t60\t80\t16\t-1\t",
    "5\t1\t1\t1\t2\t1\t10\t60\t80\t16\t88.0\tPolyester",
  ].join("\n");

  const parsed = O.parseTsv(tsv);
  ok("parseTsv：解析出 2 行", parsed.length === 2, "得到 " + parsed.length);
  if (parsed.length === 2) {
    ok("parseTsv：行文本由词拼接", parsed[0].text === "MATERIAL SPEC", JSON.stringify(parsed[0].text));
    ok("parseTsv：坐标正确", parsed[0].x === 10 && parsed[0].y === 20 && parsed[0].w === 120 && parsed[0].h === 16, JSON.stringify(parsed[0]));
    ok("parseTsv：第二行正确", parsed[1].text === "Polyester");

    // —— 回归：行级 conf 必须由词级算出来，不能沿用 level=4 的 -1 ——
    ok(
      "parseTsv：行级置信度由词级置信度算出（不是 -1）",
      parsed[0].conf > 0,
      "conf = " + parsed[0].conf
    );
    ok(
      "parseTsv：算出来的置信度等于词级均值",
      Math.abs(parsed[0].conf - 92.5) < 0.01,
      "conf = " + parsed[0].conf + "，期望 92.5"
    );
    // 这条是真正的用户可见后果：conf 若是 -1，整行会被垃圾过滤器丢掉
    ok(
      "parseTsv 的结果能通过垃圾过滤器（conf=-1 时会被全部误杀）",
      !O.looksLikeNoise(parsed[0].text, parsed[0].conf) && !O.looksLikeNoise(parsed[1].text, parsed[1].conf),
      "第一行 conf=" + parsed[0].conf
    );
    // 反过来确认过滤器本身没坏：真的低置信度仍要拦掉
    ok("低置信度的行仍然会被垃圾过滤器拦掉", O.looksLikeNoise("Material", -1));
  }

  // Tesseract v5 把 lines 挪进了 blocks[].paragraphs[].lines[]
  // 原实现直接读 data.words，在 v5 下会拿到 undefined 然后静默返回空结果
  const v5data = {
    text: "MATERIAL SPEC",
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              { text: "MATERIAL SPEC", confidence: 93, bbox: { x0: 10, y0: 20, x1: 130, y1: 36 } },
              { text: "Polyester", confidence: 88, bbox: { x0: 10, y0: 60, x1: 90, y1: 76 } },
            ],
          },
        ],
      },
    ],
  };
  const v5lines = O.collectLines(v5data);
  ok("collectLines：支持 Tesseract v5 的 blocks 层级结构", v5lines.length === 2, "得到 " + v5lines.length);
  ok("collectLines：v5 结构里坐标正确", v5lines[0] && v5lines[0].w === 120 && v5lines[0].h === 16);

  // v4 扁平结构也要继续支持
  const v4data = {
    lines: [{ text: "Hello World", confidence: 90, bbox: { x0: 5, y0: 5, x1: 105, y1: 25 } }],
    words: [],
  };
  ok("collectLines：兼容 Tesseract v4 的扁平结构", O.collectLines(v4data).length === 1);

  // 垃圾过滤：宁可放过也不误杀（漏字才是用户最不能接受的）
  ok("looksLikeNoise：空串是垃圾", O.looksLikeNoise("", 90));
  ok("looksLikeNoise：单字符是垃圾", O.looksLikeNoise("A", 90));
  ok("looksLikeNoise：重复符号是垃圾", O.looksLikeNoise("|||||", 90));
  ok("looksLikeNoise：纯符号是垃圾", O.looksLikeNoise("###", 90));
  ok("looksLikeNoise：低置信度是垃圾", O.looksLikeNoise("Material", 20));
  ok("looksLikeNoise：无元音长串是垃圾", O.looksLikeNoise("xzqwrt", 90));
  ok("looksLikeNoise：正常单词不是垃圾", !O.looksLikeNoise("Material", 90));
  ok("looksLikeNoise：短代号不算垃圾（PMS 必须留下）", !O.looksLikeNoise("PMS", 90));
  ok("looksLikeNoise：SKU 不算垃圾", !O.looksLikeNoise("SKU-11227J", 90));
  ok("looksLikeNoise：中文不是垃圾", !O.looksLikeNoise("材质规格", 90));
}

/* ============================================================
 * 5. 配置层：防领域过拟合
 * ============================================================ */

console.log("\n[5] 配置层（PZConfig）");

{
  const C = globalThis.PZConfig;

  const generalPrompt = C.buildRegionPrompt({
    targetLang: "zh-CN",
    glossaryEntries: [],
    profileHint: "",
  });
  const forbidden = ["hololive", "Takanashi", "Duolingo", "玩具", "规格图", "PMS", "EMBROIDERY"];
  const hits = forbidden.filter(function (w) {
    return generalPrompt.indexOf(w) >= 0;
  });
  ok(
    "通用文档的提示词里没有任何领域专有词",
    hits.length === 0,
    hits.length ? "出现了：" + hits.join(", ") : ""
  );
  ok("提示词包含目标语言", generalPrompt.indexOf("简体中文") >= 0);
  ok("提示词要求返回 JSON items", generalPrompt.indexOf('"items"') >= 0);

  // 传了 profileHint 才应该出现领域信息
  const hinted = C.buildRegionPrompt({
    targetLang: "zh-CN",
    glossaryEntries: [],
    profileHint: "这是机械零件装配说明图",
  });
  ok("profileHint 会被拼进提示词", hinted.indexOf("机械零件装配说明图") >= 0);

  // 术语表
  const entries = C.parseGlossary(
    [
      "# 注释行应被忽略",
      "Torque => 扭矩",
      "SEPARATE PIECE => 独立部件",
      "hololive => 原样",
      "PMS",
      "",
      "A -> B",
      "C → D",
    ].join("\n")
  );
  ok("parseGlossary：忽略注释与空行", entries.length === 6, "得到 " + entries.length + " 条");
  ok("parseGlossary：解析 => 分隔", entries[0].from === "Torque" && entries[0].to === "扭矩");
  ok("parseGlossary：右侧「原样」标记为 keep", entries[2].keep === true);
  ok("parseGlossary：只有原文也标记为 keep", entries[3].from === "PMS" && entries[3].keep === true);
  ok("parseGlossary：支持 -> 分隔", entries[4].from === "A" && entries[4].to === "B");
  ok("parseGlossary：支持 → 分隔", entries[5].from === "C" && entries[5].to === "D");

  const gp = C.glossaryToPrompt(entries);
  ok("glossaryToPrompt：keep 项出现在「保持原样」段落", gp.indexOf("保持英文原样") >= 0 && gp.indexOf("hololive") >= 0);
  ok("glossaryToPrompt：映射项出现在对照段落", gp.indexOf("Torque => 扭矩") >= 0);

  // 预设完整性：每个预设必须有 baseUrl 和默认模型，否则用户点了就报错
  Object.keys(C.VISION_PRESETS).forEach(function (id) {
    const p = C.VISION_PRESETS[id];
    ok(
      "视觉预设 " + id + " 字段完整",
      typeof p.label === "string" && typeof p.api === "string" && (id === "custom" || !!p.baseUrl)
    );
  });
  Object.keys(C.LLM_PRESETS).forEach(function (id) {
    const p = C.LLM_PRESETS[id];
    ok(
      "文本模型预设 " + id + " 字段完整",
      typeof p.label === "string" && (id === "custom" || !!p.baseUrl)
    );
  });

  // 玩具规格表这个 profile 应该保留原来的词表（没白干）
  ok("toy_spec profile 保留了原词表", C.PROFILES.toy_spec.glossary.indexOf("SEPARATE PIECE") >= 0);
  ok("general profile 默认空词表", !C.PROFILES.general.glossary);
}

/* ============================================================
 * 6. PZOverlay.render 的覆盖范围（用假 canvas / ctx 在 Node 里跑）
 * ============================================================ */

console.log("\n[6] 排版引擎的覆盖范围（render 端到端）");

{
  const U = globalThis.PZUtil;
  const OV = globalThis.PZOverlay;

  /**
   * 假 2D context：只记录被调用的绘制操作。
   * render 的逻辑（算覆盖范围、裁剪、跳过、统计）都是纯逻辑，
   * 不需要真的画像素 —— 这样就能在没有 DOM 的环境里验证它。
   */
  function makeFakeCtx(w, h) {
    const ctx = {
      canvas: { width: w, height: h },
      fills: [],
      texts: [],
      clips: [],
      font: "",
      fillStyle: "",
      textAlign: "",
      textBaseline: "",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "",
      measureText: function (s) {
        // 从当前 font 里解析字号，按"每字符一个字号宽"估算
        const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
        const fs = m ? parseFloat(m[1]) : 10;
        return { width: String(s).length * fs };
      },
      getImageData: function (x, y, ww, hh) {
        return { width: ww, height: hh, data: new Uint8ClampedArray(Math.max(0, ww * hh * 4)).fill(255) };
      },
      createImageData: function (ww, hh) {
        return { width: ww, height: hh, data: new Uint8ClampedArray(Math.max(0, ww * hh * 4)) };
      },
      fillRect: function (x, y, ww, hh) {
        ctx.fills.push({ x: x, y: y, w: ww, h: hh });
      },
      fillText: function (t, x, y) {
        ctx.texts.push({ t: String(t), x: x, y: y, font: ctx.font });
      },
      rect: function (x, y, ww, hh) {
        ctx.clips.push({ x: x, y: y, w: ww, h: hh });
      },
      save: function () {},
      restore: function () {},
      beginPath: function () {},
      clip: function () {},
      clearRect: function () {},
      putImageData: function () {},
      drawImage: function () {},
    };
    return ctx;
  }

  function makeFakeCanvas(w, h) {
    const c = { width: w, height: h, _ctx: null };
    c.getContext = function () {
      if (!c._ctx) c._ctx = makeFakeCtx(w, h);
      return c._ctx;
    };
    return c;
  }

  U.setCanvasFactory(makeFakeCanvas);

  const source = makeFakeCanvas(400, 300);

  // --- 跳过规则 ---
  {
    const out = OV.render(
      source,
      [
        { x: 10, y: 10, w: 100, h: 20, src: "Material", dst: "Material" },
        { x: 10, y: 40, w: 100, h: 20, src: "Spec", dst: "" },
      ],
      { cover: true }
    );
    ok("dst 与 src 相同 → 不覆盖", out._overlayStats.skippedSame === 1, JSON.stringify(out._overlayStats));
    ok("dst 为空 → 不覆盖", out._overlayStats.skippedEmpty === 1);
    ok("被跳过的条目没有产生任何绘制", out.getContext().fills.length === 0 && out.getContext().texts.length === 0);
  }

  // --- 正常覆盖 ---
  {
    // 覆盖范围改成从 onCover 拿：去字走的是 putImageData（纯色填充 / 掩膜修复），
    // 不再刷 fillRect，所以不能再靠数 fills 来判断范围。
    const covers = [];
    const out = OV.render(source, [{ x: 10, y: 10, w: 100, h: 20, src: "Material", dst: "材质" }], {
      cover: true,
      maxGrowY: 1.35,
      minFontSize: 6,
      onCover: function (cov) {
        covers.push(cov);
      },
    });
    const ctx = out.getContext();
    ok("覆盖了一次", covers.length === 1, "covers=" + covers.length);
    ok("写了一次文字", ctx.texts.length === 1, "texts=" + ctx.texts.length);
    ok("调用过 clip（保证不越界绘制）", ctx.clips.length === 1);
    ok("统计里 drawn = 1", out._overlayStats.drawn === 1);

    const f = covers[0];
    const soloLim = OV.computeNeighborLimits([{ x: 10, y: 10, w: 100, h: 20 }], 400, 300, {
      maxGrowY: 1.35,
      gap: 3,
    })[0];
    // 断言写成"性质"而不是具体数字：具体边界会因为浮点取整差 0.5px
    ok(
      "覆盖范围被夹在邻居允许的边界内（容忍 1px 取整误差）",
      f.y >= soloLim.top - 1 && f.y + f.h <= soloLim.bottom + 1,
      "cover y=" + f.y.toFixed(2) + " 底=" + (f.y + f.h).toFixed(2) +
        "，允许区间 [" + soloLim.top.toFixed(2) + ", " + soloLim.bottom.toFixed(2) + "]"
    );
    ok("覆盖范围至少包含原文框", f.y <= 10 && f.y + f.h >= 30, "y=" + f.y.toFixed(2) + " bot=" + (f.y + f.h).toFixed(2));
    // 这条对应的就是「去字留灰边」：不留垂直余量，原文的抗锯齿边和降部会露出来
    ok(
      "垂直方向留了余量（上下都超出原框）",
      f.y < 10 && f.y + f.h > 30,
      "上余量 " + (10 - f.y).toFixed(2) + "px，下余量 " + (f.y + f.h - 30).toFixed(2) + "px"
    );
    ok("水平方向留了余量盖住原字边缘", f.x < 10 && f.x + f.w > 110, "x=" + f.x + " w=" + f.w);
  }

  // --- 关键：中文比原文长时，绝不能压到相邻行的文字 ---
  {
    const items = [
      { x: 10, y: 10, w: 100, h: 20, src: "short", dst: "这是一段非常长的中文译文需要占很多空间" },
      { x: 10, y: 34, w: 100, h: 20, src: "second", dst: "第二行" },
    ];
    const covers = [];
    const out = OV.render(source, items, {
      cover: true,
      maxGrowY: 1.35,
      minFontSize: 6,
      onCover: function (cov) {
        covers.push(cov);
      },
    });

    ok("两条都覆盖了", covers.length === 2, "covers=" + covers.length);
    const a = covers[0];
    const b = covers[1];
    ok(
      "长译文的覆盖范围没有碰到下一行的框（y=34）",
      a.y + a.h <= 34,
      "第一块的底边 = " + (a.y + a.h).toFixed(2)
    );
    ok("长译文被缩小以放进可用空间", out._overlayStats.shrunk >= 1, JSON.stringify(out._overlayStats));
    ok(
      "第二块的覆盖范围也没越到画面外或压回上一块",
      b.y + b.h <= 300 && b.y >= a.y + a.h - 0.01,
      "第二块 y=" + b.y.toFixed(2) + " bot=" + (b.y + b.h).toFixed(2)
    );
  }

  // --- 极端情况不该崩 ---
  {
    let crashed = null;
    let out = null;
    try {
      out = OV.render(
        source,
        [{ x: 0, y: 0, w: 1, h: 1, src: "a", dst: "一段很长很长的中文要硬塞进一像素的框里" }],
        { cover: true, minFontSize: 6 }
      );
    } catch (e) {
      crashed = e;
    }
    ok("极小框 + 极长译文不会抛异常", !crashed, crashed ? crashed.message : "");
    if (out) {
      ok("极小框场景被标记为 overflow（而不是静默截断）", out._overlayStats.overflow === 1, JSON.stringify(out._overlayStats));
    }
  }

  // --- cover:false 时应当原样返回 ---
  {
    const out = OV.render(source, [{ x: 10, y: 10, w: 100, h: 20, src: "a", dst: "甲" }], { cover: false });
    ok("关闭覆盖时不画任何东西", out.getContext().fills.length === 0 && out.getContext().texts.length === 0);
  }

  U.setCanvasFactory(null); // 还原：之后再用 createCanvas 会明确报错，而不是拿到假对象
}

/* ============================================================
 * 7. 端到端：合成像素图 → 真实检测几何 → 排版
 * ============================================================ */

console.log("\n[7] 端到端：检测几何 → 排版（不用手搓框）");

{
  const U = globalThis.PZUtil;
  const D = globalThis.PZDetect;
  const OV = globalThis.PZOverlay;

  // --- 造一张"有文字 + 有反例"的像素图 ---
  //
  // 关键：字形必须是**有空隙的笔画**，不能画成实心矩形。
  // 实心矩形的墨密度接近 1.0，会被检测器的"实心色块"判据正确排除 ——
  // 那是算法对、合成的图不真实。（第一版就是栽在这里：检测到 0 行。）
  const W = 800;
  const H = 620;
  const img = U.imageLike(W, H, 255);

  function setInk(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
    img.data[o + 3] = 255;
  }
  function vbar(x, y, len) {
    for (let i = 0; i < len; i++) setInk(x, y + i);
  }
  function hbar(x, y, len) {
    for (let i = 0; i < len; i++) setInk(x + i, y);
  }

  /** 一个 7×10 的空心字形，笔画 1px。整行墨密度约 0.23，和真实文字同量级 */
  function glyph(x, y, kind) {
    const gw = 7;
    const gh = 10;
    switch (kind) {
      case "H":
        vbar(x, y, gh); vbar(x + gw - 1, y, gh); hbar(x, y + (gh >> 1), gw);
        break;
      case "E":
        vbar(x, y, gh); hbar(x, y, gw - 2); hbar(x, y + (gh >> 1), gw - 3); hbar(x, y + gh - 1, gw - 2);
        break;
      case "T":
        hbar(x, y, gw); vbar(x + (gw >> 1), y, gh);
        break;
      case "L":
        vbar(x, y, gh); hbar(x, y + gh - 1, gw);
        break;
      case "O":
        vbar(x, y, gh); vbar(x + gw - 1, y, gh); hbar(x, y, gw); hbar(x, y + gh - 1, gw);
        break;
      default: // I 形
        vbar(x + (gw >> 1), y, gh);
        hbar(x, y, 3); hbar(x + gw - 3, y, 3);
        hbar(x, y + gh - 1, 3); hbar(x + gw - 3, y + gh - 1, 3);
    }
  }
  function word(x, y, spec) {
    for (let i = 0; i < spec.length; i++) glyph(x + i * 11, y, spec[i]);
  }

  const WORDS = ["MATERIAL", "SEPARATE", "EMBROIDERY", "PRINTED", "GRADIENT", "POLYESTER"];
  for (let i = 0; i < WORDS.length; i++) {
    word(80, 60 + i * 60, WORDS[i]);
  }
  // 反例：一条实心横线（表格边框），不应被当成文字
  for (let x = 60; x < 740; x++) {
    setInk(x, 500);
    setInk(x, 501);
  }

  const det = D.detect(img, {});
  ok(
    "检测到 6 行文字（实心横线未被误判）",
    det.lines.length === 6,
    "实际 " + det.lines.length + " 行；y=" + det.lines.map(function (l) { return Math.round(l.y); }).join(",")
  );
  ok(
    "检测框没有落在实心横线上（y≈500）",
    det.lines.every(function (l) {
      return l.y + l.h < 500 || l.y > 502;
    })
  );

  // --- 检测结果 → OCR 条带规划（本地 OCR 路线的接缝）---
  if (globalThis.PZOcr && det.lines.length) {
    const bands = globalThis.PZOcr.planBands(det.lines, W, H, { maxBands: 10 });
    ok("条带数不超过上限", bands.length <= 10, "条带数=" + bands.length);
    ok(
      "每一条文字行都完整落在某个条带内（否则那一行会被切开，OCR 必然认错）",
      det.lines.every(function (l) {
        return bands.some(function (b) {
          return l.y >= b.y - 1 && l.y + l.h <= b.y + b.h + 1;
        });
      }),
      det.lines.length + " 行 / " + bands.length + " 条带"
    );
    ok(
      "每条带都至少覆盖到一行（不产生空条带浪费一次 OCR）",
      bands.every(function (b) {
        return det.lines.some(function (l) {
          return l.y + l.h > b.y && l.y < b.y + b.h;
        });
      })
    );
    ok(
      "放大倍数都在 1~4 之间",
      bands.every(function (b) {
        return b.zoom >= 1 && b.zoom <= 4;
      }),
      "zoom = " + bands.map(function (b) { return b.zoom.toFixed(2); }).join(", ")
    );
    // 小字应该比大字放大更多 —— 这是"把小字放大到能认"的核心机制
    const small = bands.filter(function (b) { return b.medH <= 12; })[0];
    const big = bands.filter(function (b) { return b.medH >= 30; })[0];
    if (small && big) {
      ok("小字条带的放大倍数大于大字条带", small.zoom > big.zoom, small.zoom + " vs " + big.zoom);
    }
  }

  if (det.lines.length !== 6) {
    console.log("  ! 行数不符，跳过后续排版断言");
  } else {
    // --- 假 canvas：排版只需要 measureText 和记录绘制 ---
    function fakeCtx(w, h) {
      const c = {
        canvas: { width: w, height: h },
        fills: [],
        texts: [],
        font: "",
        fillStyle: "",
        textAlign: "",
        textBaseline: "",
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "",
        measureText: function (s) {
          const m = /(\d+(?:\.\d+)?)px/.exec(c.font);
          const fs = m ? parseFloat(m[1]) : 10;
          // 中文按 1 个字宽、拉丁按 0.55 个字宽，粗糙但足够驱动换行逻辑
          let wpx = 0;
          for (const ch of String(s)) {
            wpx += /[\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fs : fs * 0.55;
          }
          return { width: wpx };
        },
        getImageData: function (x, y, ww, hh) {
          return { width: ww, height: hh, data: new Uint8ClampedArray(Math.max(0, ww * hh * 4)).fill(255) };
        },
        createImageData: function (ww, hh) {
          return { width: ww, height: hh, data: new Uint8ClampedArray(Math.max(0, ww * hh * 4)) };
        },
        fillRect: function (x, y, ww, hh) {
          c.fills.push({ x: x, y: y, w: ww, h: hh });
        },
        fillText: function (t, x, y) {
          c.texts.push({ t: String(t), x: x, y: y, font: c.font });
        },
        save: function () {},
        restore: function () {},
        beginPath: function () {},
        rect: function () {},
        clip: function () {},
        clearRect: function () {},
        putImageData: function () {},
        drawImage: function () {},
      };
      return c;
    }
    U.setCanvasFactory(function (w, h) {
      const cv = { width: w, height: h, _c: null };
      cv.getContext = function () {
        if (!cv._c) cv._c = fakeCtx(w, h);
        return cv._c;
      };
      return cv;
    });

    const source = U.createCanvas(W, H);

    // 译文故意长短不一：短标签应该原地放下，长句必然要换行
    const zh = ["材质规格", "主体：100% 聚酯纤维，柔软仿毛皮", "独立部件", "刺绣", "PMS 1234 C", "不适合 3 岁以下儿童"];
    const items = det.lines.map(function (l, i) {
      return { x: l.x, y: l.y, w: l.w, h: l.h, src: "line " + i, dst: zh[i] };
    });

    // 覆盖范围从 onCover 拿：去字不再刷 fillRect
    const covers = [];
    const out = OV.render(source, items, {
      cover: true,
      maxGrowY: 1.35,
      minFontSize: 6,
      onCover: function (cov) {
        covers.push(cov);
      },
    });
    const ctx = out.getContext();

    ok("6 行都产生了覆盖范围", covers.length === 6, "covers=" + covers.length);
    ok("统计 drawn = 6", out._overlayStats.drawn === 6, JSON.stringify(out._overlayStats));

    // 核心断言：相邻两行的覆盖矩形不能重叠，否则就是"压字"
    const sorted = covers.slice().sort(function (a, b) {
      return a.y - b.y;
    });
    let worstOverlap = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const ov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ov > worstOverlap) worstOverlap = ov;
    }
    ok(
      "任何相邻两行的覆盖矩形都不重叠（这就是「不压字」）",
      worstOverlap <= 0.5,
      "最大重叠 " + worstOverlap.toFixed(2) + "px"
    );

    // 覆盖矩形不能越出画布
    ok(
      "覆盖矩形都在画布范围内",
      covers.every(function (f) {
        return f.y >= -0.5 && f.y + f.h <= H + 0.5 && f.x >= -0.5 && f.x + f.w <= W + 0.5;
      })
    );

    // 写了字
    ok("写了中文字", ctx.texts.length >= 6, "texts=" + ctx.texts.length);
    ok(
      "写出的中文都落在对应的覆盖矩形内（横向）",
      ctx.texts.every(function (t) {
        return covers.some(function (f) {
          return t.x >= f.x - 1 && t.x <= f.x + f.w;
        });
      })
    );

    U.setCanvasFactory(null);
  }
}

/* ============================================================
 * 8. 去字：文字掩膜 + 无缝修复（像素级验证）
 *
 * 这一节用一个"内存里的软件 canvas"（真的读写像素）跑完整覆盖管线，
 * 断言的是**像素结果**，不是调用次数：
 *   · 原文被擦干净
 *   · 旁边的表格线被保留（这是之前"涂抹太差"的根因）
 *   · 填充是无缝的（不留矩形边界）
 * ============================================================ */

console.log("\n[8] 去字：文字掩膜 + 无缝修复");

{
  const U = globalThis.PZUtil;
  const INK = globalThis.PZInpaint;

  /**
   * 软件 canvas：真的持有一块 RGBA 缓冲，实现 render 需要的那部分 2D API。
   * 只有这样才谈得上"用像素结果断言"。
   */
  function makeSoftCanvas(W, H) {
    const buf = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < buf.length; i += 4) { buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255; } // 白底、不透明

    function px(x, y) {
      return (y * W + x) * 4;
    }

    const ctx = {
      canvas: { width: W, height: H },
      font: "",
      fillStyle: "#000000",
      textAlign: "left",
      textBaseline: "top",
      letterSpacing: "",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "",
      _clip: null,

      getImageData: function (x, y, w, h) {
        const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const sx = x + xx;
            const sy = y + yy;
            const o = (yy * w + xx) * 4;
            if (sx < 0 || sy < 0 || sx >= W || sy >= H) {
              out[o] = out[o + 1] = out[o + 2] = 255;
              out[o + 3] = 255;
              continue;
            }
            const p = px(sx, sy);
            out[o] = buf[p];
            out[o + 1] = buf[p + 1];
            out[o + 2] = buf[p + 2];
            out[o + 3] = 255;
          }
        }
        return { width: w, height: h, data: out };
      },

      putImageData: function (img, x, y) {
        for (let yy = 0; yy < img.height; yy++) {
          for (let xx = 0; xx < img.width; xx++) {
            const sx = x + xx;
            const sy = y + yy;
            if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
            const o = (yy * img.width + xx) * 4;
            const p = px(sx, sy);
            buf[p] = img.data[o];
            buf[p + 1] = img.data[o + 1];
            buf[p + 2] = img.data[o + 2];
          }
        }
      },

      createImageData: function (w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) };
      },

      fillRect: function (x, y, w, h) {
        const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(ctx.fillStyle);
        const c = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
        for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
          for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            if (ctx._clip && (xx < ctx._clip.x || xx >= ctx._clip.x + ctx._clip.w ||
                              yy < ctx._clip.y || yy >= ctx._clip.y + ctx._clip.h)) continue;
            const p = px(xx, yy);
            buf[p] = c[0];
            buf[p + 1] = c[1];
            buf[p + 2] = c[2];
          }
        }
      },

      // 文字不真的渲染：这一节测的是"去字"，不是"写字"
      fillText: function () {},

      measureText: function (s) {
        const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
        const fs = m ? parseFloat(m[1]) : 10;
        let w = 0;
        for (const ch of String(s)) {
          w += /[\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fs : fs * 0.55;
        }
        return { width: w };
      },

      drawImage: function (src, sx, sy, sw, sh, dx, dy, dw, dh) {
        // 只支持 cloneCanvas 用的那种整张拷贝
        const s = src && src._buf ? src : null;
        if (!s) return;
        if (arguments.length <= 3) {
          for (let y = 0; y < Math.min(H, s.height); y++) {
            for (let x = 0; x < Math.min(W, s.width); x++) {
              const a = (y * s.width + x) * 4;
              const b = px(x, y);
              buf[b] = s._buf[a];
              buf[b + 1] = s._buf[a + 1];
              buf[b + 2] = s._buf[a + 2];
            }
          }
        }
      },

      save: function () {},
      restore: function () { ctx._clip = null; },
      beginPath: function () {},
      rect: function (x, y, w, h) { ctx._clip = { x: x, y: y, w: w, h: h }; },
      clip: function () {},
      clearRect: function () {},
    };

    const canvas = {
      width: W,
      height: H,
      _buf: buf,
      getContext: function () { return ctx; },
      toDataURL: function () { return "data:image/png;base64,"; },
    };
    return canvas;
  }

  /** 往软件画布上画一个实心矩形（模拟"文字"或"表格线"） */
  function paint(canvas, rect, rgb) {
    const W = canvas.width;
    const buf = canvas._buf;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= canvas.height) continue;
        const p = (y * W + x) * 4;
        buf[p] = rgb[0];
        buf[p + 1] = rgb[1];
        buf[p + 2] = rgb[2];
      }
    }
  }

  function readPx(canvas, x, y) {
    const p = (y * canvas.width + x) * 4;
    return [canvas._buf[p], canvas._buf[p + 1], canvas._buf[p + 2]];
  }

  U.setCanvasFactory(makeSoftCanvas);

  const W = 300;
  const H = 120;

  // ---------- 掩膜本身：什么该擦、什么不该擦 ----------
  {
    const cv = makeSoftCanvas(W, H);
    // 白底 + 三段"文字"（小实心块）+ 一条贯穿的表格线 + 一个大色块
    paint(cv, { x: 40, y: 30, w: 8, h: 10 }, [0, 0, 0]);
    paint(cv, { x: 52, y: 30, w: 8, h: 10 }, [0, 0, 0]);
    paint(cv, { x: 64, y: 30, w: 8, h: 10 }, [0, 0, 0]);
    // 表格线放在 y=80，和色块之间留出空隙 —— 贴着的话 4 连通会把它们
    // 连成一个组件，就测不出「线被正确丢弃」了
    paint(cv, { x: 0, y: 80, w: W, h: 2 }, [0, 0, 0]);
    paint(cv, { x: 200, y: 20, w: 60, h: 40 }, [0, 0, 0]); // 大色块（图案）

    const ctx = cv.getContext("2d");
    const img = ctx.getImageData(0, 0, W, H);
    const built = INK.buildMask(img, { contrast: 38, dilate: 0 });

    const isMasked = function (x, y) {
      return built.mask[y * W + x] === 1;
    };
    ok("掩膜：三段文字都被标记", isMasked(44, 35) && isMasked(56, 35) && isMasked(68, 35));
    ok("掩膜：表格线**没有**被标记（它是背景，不该擦）", !isMasked(150, 81) && !isMasked(20, 80));
    ok("掩膜：大色块没有被标记（那是图案不是字）", !isMasked(230, 40));
    ok("掩膜：线条与大色块都被判为「不该擦」（dropped >= 2）", built.dropped >= 2, "dropped=" + built.dropped + " kept=" + built.kept);
  }

  // ---------- 膨胀：吃掉抗锯齿边 ----------
  {
    const cv = makeSoftCanvas(W, H);
    paint(cv, { x: 40, y: 30, w: 8, h: 10 }, [0, 0, 0]);
    const ctx = cv.getContext("2d");
    const img = ctx.getImageData(0, 0, W, H);
    const m0 = INK.buildMask(img, { dilate: 0 });
    const m2 = INK.buildMask(img, { dilate: 2 });
    ok("膨胀：dilate=2 的掩膜比 dilate=0 大", m2.count > m0.count, m0.count + " → " + m2.count);
    ok(
      "膨胀：原文外沿 1px 处也被覆盖（抗锯齿边不会留下灰边）",
      m2.mask[30 * W + 39] === 1 && m2.mask[30 * W + 49] === 1
    );
  }

  // ---------- 修复：填出来的像素要与周围连续 ----------
  {
    const cv = makeSoftCanvas(W, H);
    // 白底上一块灰度渐变，中间挖个洞（模拟文字），修复后洞里应当是平滑过渡
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = 60 + Math.round((x / W) * 120);
        paint(cv, { x: x, y: y, w: 1, h: 1 }, [v, v, v]);
      }
    }
    paint(cv, { x: 140, y: 50, w: 20, h: 16 }, [0, 0, 0]); // 文字
    const ctx = cv.getContext("2d");
    const img = ctx.getImageData(0, 0, W, H);
    const built = INK.buildMask(img, { dilate: 2 });
    INK.inpaint(img, built.mask, {});

    // 洞中央应当接近周围渐变的值（x=150 处约为 60+60=120）
    const center = (function () {
      const p = (58 * W + 150) * 4;
      return img.data[p];
    })();
    ok(
      "修复：文字被擦掉，填出来的值与周围渐变一致（无缝）",
      Math.abs(center - 120) <= 12,
      "填出 " + center + "，周围渐变期望约 120"
    );

    // 边界连续性：左右两侧的差值应当很小
    const left = img.data[(58 * W + 137) * 4];
    const right = img.data[(58 * W + 163) * 4];
    ok(
      "修复：跨越原文字区域的相邻像素差值很小（不留矩形边界）",
      Math.abs(right - left) < 40,
      "左 " + left + " / 右 " + right
    );
  }

  // ---------- 端到端：走真实的 PZOverlay.render ----------
  {
    const cv = makeSoftCanvas(W, H);
    // 白底 + "文字" + 一条横穿文字下方、会经过去字范围的表格线
    paint(cv, { x: 40, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 53, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 66, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 20, y: 22, w: 220, h: 2 }, [0, 0, 0]); // 表格线（上）
    paint(cv, { x: 20, y: 46, w: 220, h: 2 }, [0, 0, 0]); // 表格线（下）

    const item = { x: 38, y: 26, w: 40, h: 16, src: "LABEL", dst: "标签" };
    const out = globalThis.PZOverlay.render(cv, [item], { cover: true, minFontSize: 6 });

    // 文字应当被擦掉：原文字的像素位置变成接近白
    const t1 = readPx(out, 44, 34);
    const t2 = readPx(out, 57, 34);
    const t3 = readPx(out, 70, 34);
    const lum = function (c) {
      return (c[0] + c[1] + c[2]) / 3;
    };
    ok(
      "端到端：原文被擦掉（三个字形位置都接近白底）",
      lum(t1) > 200 && lum(t2) > 200 && lum(t3) > 200,
      "亮度 " + [lum(t1), lum(t2), lum(t3)].map(Math.round).join("/")
    );

    // 表格线必须还在 —— 这正是"涂抹太差"要修的东西
    const lineTop = readPx(out, 150, 23);
    const lineBot = readPx(out, 150, 47);
    ok(
      "端到端：去字范围附近的表格线**被保留**（不再被整块擦掉）",
      lum(lineTop) < 60 && lum(lineBot) < 60,
      "线亮度 " + Math.round(lum(lineTop)) + " / " + Math.round(lum(lineBot))
    );

    ok("端到端：统计里记了走的是修复路径", out._overlayStats.inpainted === 1, JSON.stringify(out._overlayStats));
  }

  // ---------- 纯色填充：零残留（这是用户点名要的做法） ----------
  {
    // 主色识别：环上混入 10% 杂色也要取对
    const px = [];
    for (let i = 0; i < 90; i++) px.push([240, 240, 240]);
    for (let i = 0; i < 10; i++) px.push([10, 20, 30]);
    const dom = INK.dominantColor(px, {});
    ok(
      "背景主色：环上混入 10% 杂色仍取对主色（用众数而不是均值）",
      dom.color[0] > 220 && dom.color[1] > 220 && dom.coverage >= 0.85,
      JSON.stringify(dom)
    );
  }

  {
    const cv = makeSoftCanvas(W, H);
    // 浅灰纸底 + 三段黑字（不要纯白，纯白测不出"填错颜色"）
    paint(cv, { x: 0, y: 0, w: W, h: H }, [238, 238, 238]);
    paint(cv, { x: 40, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 53, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 66, y: 28, w: 9, h: 12 }, [0, 0, 0]);

    let coverRect = null;
    const item = { x: 38, y: 26, w: 40, h: 16, src: "LABEL", dst: "标签" };
    const out = globalThis.PZOverlay.render(cv, [item], {
      cover: true,
      eraseMode: "fill",
      minFontSize: 6,
      onCover: function (cov) {
        coverRect = cov;
      },
    });

    ok("纯色填充：走的是 fill 路径", out._overlayStats.erasedByFill === 1, JSON.stringify(out._overlayStats));
    ok("纯色填充：底色纯（coverage 高）", out._overlayStats.lowCoverage === 0);

    // 关键断言：覆盖区域里一个暗像素都不该剩。
    // 测试里的 fillText 是空实现（不真的画字），所以残留必须严格为 0 ——
    // 这就把"擦干净"和"擦一半留残影"彻底分开了。
    let dark = 0;
    let sum = 0;
    let cnt = 0;
    for (let y = Math.round(coverRect.y); y < coverRect.y + coverRect.h; y++) {
      for (let x = Math.round(coverRect.x); x < coverRect.x + coverRect.w; x++) {
        const p = readPx(out, x, y);
        const l = (p[0] + p[1] + p[2]) / 3;
        sum += l;
        cnt++;
        if (l < 120) dark++;
      }
    }
    ok(
      "纯色填充：覆盖区域里**零残留**（一个暗像素都没有）",
      dark === 0,
      "残留 " + dark + " / " + cnt + " px"
    );
    ok(
      "纯色填充：填的是背景色（浅灰 238），不是白的 —— 不会像涂改液那样比纸更白",
      Math.abs(sum / cnt - 238) < 4,
      "填充区平均亮度 " + (sum / cnt).toFixed(1) + "，背景 238"
    );
  }

  // ---------- 智能修复：背景不纯时用它 ----------
  {
    const cv = makeSoftCanvas(W, H);
    paint(cv, { x: 0, y: 0, w: W, h: H }, [238, 238, 238]);
    // 文字压在一块彩色区域上（模拟玩偶图案）
    paint(cv, { x: 30, y: 20, w: 60, h: 30 }, [200, 80, 60]);
    paint(cv, { x: 40, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 53, y: 28, w: 9, h: 12 }, [0, 0, 0]);

    const item = { x: 38, y: 26, w: 40, h: 16, src: "LABEL", dst: "标签" };
    const out = globalThis.PZOverlay.render(cv, [item], {
      cover: true,
      eraseMode: "repair",
      minFontSize: 6,
    });
    ok("智能修复：走的是 repair 路径", out._overlayStats.erasedByRepair === 1, JSON.stringify(out._overlayStats));

    // 修复后文字位置应当是彩色区域的过渡色，而不是黑
    const p = readPx(out, 44, 34);
    const l = (p[0] + p[1] + p[2]) / 3;
    ok("智能修复：原文被擦掉（不再是黑）", l > 60, "亮度 " + l.toFixed(0));
  }

  // ---------- 只擦文字（ink）：底色一点不动，不能有"贴纸" ----------
  {
    const cv = makeSoftCanvas(W, H);
    // 彩色底（模拟玩偶图案区）+ 黑字压在上面
    paint(cv, { x: 0, y: 0, w: W, h: H }, [238, 238, 238]);
    paint(cv, { x: 26, y: 18, w: 70, h: 36 }, [200, 80, 60]); // 图案色块
    paint(cv, { x: 40, y: 28, w: 9, h: 12 }, [0, 0, 0]); // 字
    paint(cv, { x: 53, y: 28, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 66, y: 28, w: 9, h: 12 }, [0, 0, 0]);

    const before = cv._buf.slice();
    let coverRect = null;
    const item = { x: 38, y: 26, w: 40, h: 16, src: "LABEL", dst: "标签" };
    const out = globalThis.PZOverlay.render(cv, [item], {
      cover: true,
      eraseMode: "ink",
      minFontSize: 6,
      onCover: function (cov) {
        coverRect = cov;
      },
    });

    ok("只擦文字：走的是 ink 路径", out._overlayStats.erasedByInk === 1, JSON.stringify(out._overlayStats));

    // 逐像素比对覆盖区域：
    //   · 变成"别的颜色"（既不是原色也不是背景色）—— 一个都不该有
    //   · 变了的像素 —— 应当只占少数（只有文字本身）
    //   · 没变的像素 —— 应当是绝大多数（底色/图案原样保留）
    const panel = [200, 80, 60];
    const near = function (c, t, tol) {
      return Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol;
    };
    const x0 = Math.round(coverRect.x);
    const y0 = Math.round(coverRect.y);
    const rectArea = Math.round(coverRect.w) * Math.round(coverRect.h);
    let changed = 0;
    let changedToElse = 0;
    let unchanged = 0;
    for (let y = y0; y < y0 + Math.round(coverRect.h); y++) {
      for (let x = x0; x < x0 + Math.round(coverRect.w); x++) {
        const p = (y * W + x) * 4;
        const o = before[p];
        const o1 = before[p + 1];
        const o2 = before[p + 2];
        const n = out._buf[p];
        const n1 = out._buf[p + 1];
        const n2 = out._buf[p + 2];
        if (o === n && o1 === n1 && o2 === n2) {
          unchanged++;
          continue;
        }
        changed++;
        // 改完之后必须是"背景色"（这里的背景就是图案色）
        if (!near([n, n1, n2], panel, 2)) changedToElse++;
      }
    }

    ok(
      "只擦文字：底色/图案像素**一个都没动**（没有整块填充，所以不会有贴纸感）",
      changedToElse === 0,
      "被改成非背景色的像素 " + changedToElse + " 个"
    );
    ok(
      "只擦文字：没变的像素占绝大多数（底色原样保留）",
      unchanged > rectArea * 0.5,
      "未改动 " + unchanged + " / " + rectArea
    );
    ok(
      "只擦文字：改动的只有文字那一小部分",
      changed > 0 && changed < rectArea * 0.5,
      "改动 " + changed + " / " + rectArea
    );
  }

  // ---------- 只擦文字：横穿整块的表格线要保留 ----------
  {
    const cv = makeSoftCanvas(W, H);
    paint(cv, { x: 0, y: 0, w: W, h: H }, [238, 238, 238]);
    paint(cv, { x: 30, y: 20, w: 60, h: 30 }, [200, 80, 60]);
    // 一条横线贯穿整个覆盖区域（模拟表格边框）
    paint(cv, { x: 30, y: 24, w: 60, h: 2 }, [0, 0, 0]);
    paint(cv, { x: 40, y: 34, w: 9, h: 12 }, [0, 0, 0]);
    paint(cv, { x: 53, y: 34, w: 9, h: 12 }, [0, 0, 0]);

    const item = { x: 38, y: 32, w: 40, h: 16, src: "LABEL", dst: "标签" };
    const out = globalThis.PZOverlay.render(cv, [item], {
      cover: true,
      eraseMode: "ink",
      minFontSize: 6,
    });
    const line = readPx(out, 60, 25);
    const lum = (c) => (c[0] + c[1] + c[2]) / 3;
    ok(
      "只擦文字：横穿整块的表格线被保留（不因为它颜色与底色不同就被擦掉）",
      lum(line) < 60,
      "线亮度 " + lum(line).toFixed(0)
    );
  }

  U.setCanvasFactory(null);
}

/* ============================================================
 * 9. 实测框内几何（measureInk）—— 字号与对齐的依据
 * ============================================================ */

console.log("\n[9] 实测框内几何（字号 / 对齐的依据）");

{
  const OV = globalThis.PZOverlay;

  function inkCtx(W, H, rects) {
    function isInk(x, y) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
      }
      return false;
    }
    return {
      getImageData: function (x, y, w, h) {
        const data = new Uint8ClampedArray(Math.max(0, w * h * 4));
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const o = (yy * w + xx) * 4;
            const v = isInk(x + xx, y + yy) ? 0 : 255;
            data[o] = v;
            data[o + 1] = v;
            data[o + 2] = v;
            data[o + 3] = 255;
          }
        }
        return { width: w, height: h, data: data };
      },
    };
  }

  // --- 单行：框比文字宽，墨迹左上留了空白 ---
  {
    const ctx = inkCtx(400, 300, [{ x: 35, y: 44, w: 60, h: 10 }]);
    const m = OV.measureInk(ctx, { x: 20, y: 40, w: 100, h: 20 }, 400, 300, {});
    ok(
      "单行：量到墨迹外接框",
      !!m && m.x === 35 && m.y === 44 && m.w === 60 && m.h === 10,
      m ? JSON.stringify({ x: m.x, y: m.y, w: m.w, h: m.h }) : "null"
    );
    ok(
      "单行：算出左边空白 = 15px（中文必须从这里起画，否则整体左偏）",
      m && m.padLeft === 15,
      m && m.padLeft
    );
    ok("单行：行数 = 1", m && m.lineCount === 1, m && m.lineCount);
    ok("单行：单行高 = 墨迹高 = 10", m && m.lineHeight === 10, m && m.lineHeight);
  }

  // --- 多行块：框里装着两行小字（这是"字号算得过大"的根源） ---
  {
    const ctx = inkCtx(400, 300, [
      { x: 35, y: 44, w: 60, h: 8 },
      { x: 35, y: 58, w: 60, h: 8 },
    ]);
    const m = OV.measureInk(ctx, { x: 20, y: 40, w: 100, h: 30 }, 400, 300, {});
    ok("多行块：识别出 2 行", m && m.lineCount === 2, m && m.lineCount);
    ok(
      "多行块：单行高 = 8（按这个定字号，而不是按整块墨迹高 22）",
      m && m.lineHeight === 8,
      m ? "lineHeight=" + m.lineHeight + "，整块墨迹高=" + m.h : "null"
    );
    ok("多行块：墨迹整体高 = 22", m && m.h === 22, m && m.h);
  }

  // --- 三行，行距不规则 ---
  {
    const ctx = inkCtx(400, 300, [
      { x: 30, y: 30, w: 50, h: 10 },
      { x: 30, y: 50, w: 50, h: 10 },
      { x: 30, y: 80, w: 50, h: 10 },
    ]);
    const m = OV.measureInk(ctx, { x: 20, y: 20, w: 100, h: 80 }, 400, 300, {});
    ok("三行不规则行距：仍识别出 3 行", m && m.lineCount === 3, m && m.lineCount);
    ok("三行不规则行距：单行高取中位数 = 10", m && m.lineHeight === 10, m && m.lineHeight);
  }

  // --- 框里什么都没有 ---
  {
    const ctx = inkCtx(400, 300, []);
    const m = OV.measureInk(ctx, { x: 20, y: 40, w: 100, h: 20 }, 400, 300, {});
    ok("框内无墨迹时返回 null（调用方要能退回原框）", m === null, String(m));
  }

  // --- 端到端：render 必须按墨迹左边缘画、按单行高定字号 ---
  {
    function renderCtxFactory(W, H, rects) {
      const src = inkCtx(W, H, rects);
      return function (w, h) {
        const cv = { width: w, height: h, _c: null };
        cv.getContext = function () {
          if (!cv._c) {
            const draws = [];
            const texts = [];
            cv._c = {
              canvas: { width: w, height: h },
              fills: draws,
              texts: texts,
              font: "",
              fillStyle: "",
              textAlign: "",
              textBaseline: "",
              imageSmoothingEnabled: true,
              imageSmoothingQuality: "",
              measureText: function (s) {
                const m2 = /(\d+(?:\.\d+)?)px/.exec(cv._c.font);
                const fs = m2 ? parseFloat(m2[1]) : 10;
                let wpx = 0;
                for (const ch of String(s)) {
                  wpx += /[\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fs : fs * 0.55;
                }
                return { width: wpx };
              },
              getImageData: src.getImageData,
              createImageData: function (ww, hh) {
                return { width: ww, height: hh, data: new Uint8ClampedArray(Math.max(0, ww * hh * 4)) };
              },
              fillRect: function (x, y, ww, hh) {
                draws.push({ x: x, y: y, w: ww, h: hh });
              },
              fillText: function (t, x, y) {
                const m3 = /(\d+(?:\.\d+)?)px/.exec(cv._c.font);
                texts.push({ t: String(t), x: x, y: y, fs: m3 ? parseFloat(m3[1]) : 0 });
              },
              save: function () {},
              restore: function () {},
              beginPath: function () {},
              rect: function () {},
              clip: function () {},
              clearRect: function () {},
              putImageData: function () {},
              drawImage: function () {},
            };
          }
          return cv._c;
        };
        return cv;
      };
    }

    const W = 400;
    const H = 300;
    globalThis.PZUtil.setCanvasFactory(
      renderCtxFactory(W, H, [
        { x: 35, y: 44, w: 60, h: 8 },
        { x: 35, y: 58, w: 60, h: 8 },
      ])
    );
    const srcCanvas = globalThis.PZUtil.createCanvas(W, H);
    const out = OV.render(srcCanvas, [{ x: 20, y: 40, w: 100, h: 30, src: "loose box", dst: "材质" }], {
      cover: true,
      maxGrowY: 1.6,
      minFontSize: 6,
    });
    const texts = out.getContext().texts;
    ok("render 写出了中文", texts.length >= 1, "texts=" + texts.length);
    if (texts.length) {
      ok(
        "render 从墨迹左边缘（x=35）起画，而不是框左边缘（x=20）",
        Math.abs(texts[0].x - 35) < 1.5,
        "实际 x=" + texts[0].x
      );
      // 字号上限 = max(原文单行高, 可读下限)：原文只有 8px 时允许放到可读下限 11，
      // 但仍然远小于"整块墨迹高 22" —— 之前"字号算得过大"的错误没有回来
      ok(
        "render 字号不超过 max(单行高 8, 可读下限 11)",
        texts[0].fs <= 11.5 && texts[0].fs >= 8,
        "实际字号=" + texts[0].fs
      );
      ok(
        "render 字号仍远小于整块墨迹高（22），没有重犯「字体太大」",
        texts[0].fs < 22,
        "实际字号=" + texts[0].fs + " vs 整块墨迹高 22"
      );
    }
    globalThis.PZUtil.setCanvasFactory(null);
  }
}

/* ============================================================
 * 10. 对齐推断 / 字距适配 / 字段分类 / 去重
 * ============================================================ */

console.log("\n[10] 排版质量与去重");

{
  const OV = globalThis.PZOverlay;
  const U = globalThis.PZUtil;

  function inkCtx(W, H, rects) {
    function isInk(x, y) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
      }
      return false;
    }
    return {
      getImageData: function (x, y, w, h) {
        const data = new Uint8ClampedArray(Math.max(0, w * h * 4));
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const o = (yy * w + xx) * 4;
            const v = isInk(x + xx, y + yy) ? 0 : 255;
            data[o] = v;
            data[o + 1] = v;
            data[o + 2] = v;
            data[o + 3] = 255;
          }
        }
        return { width: w, height: h, data: data };
      },
    };
  }

  // ---------- 对齐推断 ----------
  {
    // 单行 + 左右留白对称 → 居中
    let ctx = inkCtx(400, 100, [{ x: 80, y: 26, w: 40, h: 8 }]);
    let m = OV.measureInk(ctx, { x: 0, y: 20, w: 200, h: 20 }, 400, 100, {});
    ok("对齐：单行左右留白对称 → center", m && m.alignment === "center", m && m.alignment);

    // 单行 + 右边贴边 → 左对齐
    ctx = inkCtx(400, 100, [{ x: 10, y: 26, w: 60, h: 8 }]);
    m = OV.measureInk(ctx, { x: 0, y: 20, w: 200, h: 20 }, 400, 100, {});
    ok("对齐：单行左贴边 → left", m && m.alignment === "left", m && m.alignment);

    // 单行 + 左边留白远大于右边 → 右对齐
    ctx = inkCtx(400, 100, [{ x: 150, y: 26, w: 40, h: 8 }]);
    m = OV.measureInk(ctx, { x: 0, y: 20, w: 260, h: 20 }, 400, 100, {});
    ok("对齐：单行左留白远大于右 → right", m && m.alignment === "right", m && m.alignment);

    // 多行 + 左边缘齐 → 左对齐
    ctx = inkCtx(400, 120, [
      { x: 40, y: 24, w: 60, h: 8 },
      { x: 40, y: 44, w: 40, h: 8 },
    ]);
    m = OV.measureInk(ctx, { x: 20, y: 20, w: 200, h: 40 }, 400, 120, {});
    ok("对齐：多行左边缘齐 → left", m && m.alignment === "left", m && m.alignment);

    // 多行 + 中心齐 → 居中
    ctx = inkCtx(400, 120, [
      { x: 50, y: 24, w: 60, h: 8 },
      { x: 40, y: 44, w: 80, h: 8 },
    ]);
    m = OV.measureInk(ctx, { x: 20, y: 20, w: 200, h: 40 }, 400, 120, {});
    ok("对齐：多行中心齐 → center", m && m.alignment === "center", m && m.alignment);

    // 多行 + 右边缘齐 → 右对齐
    ctx = inkCtx(400, 120, [
      { x: 60, y: 24, w: 40, h: 8 },
      { x: 40, y: 44, w: 60, h: 8 },
    ]);
    m = OV.measureInk(ctx, { x: 20, y: 20, w: 200, h: 40 }, 400, 120, {});
    ok("对齐：多行右边缘齐 → right", m && m.alignment === "right", m && m.alignment);
  }

  // ---------- 字距适配：宁可收紧字距，也不掉一档字号 ----------
  {
    // 假 measurer：中文 1 em / 西文 0.55 em，字距按 spacing × fontSize × (字符数-1)
    const measure = function (s, fs, sp) {
      let w = 0;
      for (const ch of String(s)) {
        w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? fs : fs * 0.55;
      }
      if (sp) w += sp * fs * Math.max(0, Array.from(String(s)).length - 1);
      return w;
    };

    // 7 个汉字，框宽 150：字号 22 时自然宽度 154 放不下，
    // 收紧字距到 -0.04 是 148.7 → 能放下。不掉到 20 号。
    const laid = OV.layoutText(measure, "中文中文中文中", { x: 0, y: 0, w: 150, h: 24 }, {
      minFontSize: 6,
      allowH: 40,
    });
    ok(
      "字距：靠收紧字距保住了更大的字号（22，而不是掉到 20）",
      laid.fontSize === 22,
      "实际字号 " + laid.fontSize
    );
    ok("字距：标记了 tightened", laid.tightened === true, "spacing=" + laid.spacing);
    ok("字距：收紧后宽度确实落回框内", laid.widest <= 150.5, "widest=" + laid.widest.toFixed(1));

    // 本来就能放下时不该乱收字距
    const laid2 = OV.layoutText(measure, "中文", { x: 0, y: 0, w: 100, h: 20 }, {
      minFontSize: 6,
      allowH: 30,
    });
    ok("字距：能正常放下时不收紧", laid2.tightened === false, "spacing=" + laid2.spacing);
  }

  // ---------- 轻微溢出：宁可略超宽，也不把字号压小一圈 ----------
  {
    // 中文 1 em / 西文 0.55 em，字距按 spacing × fontSize × (字符数-1)
    const m2 = function (s, fs, sp) {
      let w = 0;
      for (const ch of String(s)) {
        w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? fs : fs * 0.55;
      }
      if (sp) w += sp * fs * Math.max(0, Array.from(String(s)).length - 1);
      return w;
    };

    // 9 个汉字 / 框宽 130：严格放不下，字号会被压到 14（理想是 18）。
    // 允许轻微溢出后可以用 16（超宽 10.8%），一档字号的差别。
    const laid = OV.layoutText(m2, "中文中文中文中文中", { x: 0, y: 0, w: 130, h: 20 }, {
      minFontSize: 6,
      allowH: 32,
    });
    ok("轻微溢出：保住了更大的字号（16，而不是 14）", laid.fontSize === 16, "fontSize=" + laid.fontSize);
    ok("轻微溢出：被标记为 overflowX", laid.overflowX === true);
    ok(
      "轻微溢出：超宽幅度不超过 12%（只按字形数算会放到 33%，太出格）",
      laid.widest <= 130 * 1.12 + 0.5,
      "widest=" + laid.widest.toFixed(1) + " / 框宽 130 = 超 " + ((laid.widest / 130 - 1) * 100).toFixed(1) + "%"
    );

    // allowW 是硬约束：可用横向空间不够时必须老实缩回去
    const tight = OV.layoutText(m2, "中文中文中文中文中", { x: 0, y: 0, w: 130, h: 20 }, {
      minFontSize: 6,
      allowH: 32,
      allowW: 118,
    });
    ok(
      "轻微溢出：超出可用横向空间时不让溢出",
      tight.overflowX === false && tight.widest <= 130.5,
      "fontSize=" + tight.fontSize + " widest=" + tight.widest.toFixed(1) + " overflowX=" + tight.overflowX
    );

    // 确实放得下的时候不该白白溢出
    const fits = OV.layoutText(m2, "中文中文中文", { x: 0, y: 0, w: 100, h: 20 }, {
      minFontSize: 6,
      allowH: 32,
    });
    ok("轻微溢出：放得下时不溢出", fits.overflowX === false, "widest=" + fits.widest.toFixed(1));
  }

  // ---------- 行高收紧 ----------
  {
    const measure = function (s, fs) {
      return String(s).length * fs;
    };
    const laid = OV.layoutText(measure, "中文中文中文中文中文中文", { x: 0, y: 0, w: 40, h: 12 }, {
      minFontSize: 6,
      allowH: 200,
    });
    ok(
      "行高：默认行高比例已收紧到 1.05 以下（原来是 1.16，排出来松垮）",
      laid.lineHeight / laid.fontSize <= 1.05,
      "实际比例 " + (laid.lineHeight / laid.fontSize).toFixed(3)
    );
  }

  // ---------- 字段分类 ----------
  {
    ok("分类：型号色号 → code", OV.classifyField("PMS 1234 C") === "code" && OV.classifyField("SKU: 11227J") === "code");
    ok("分类：纯数值 → code", OV.classifyField("45 in") === "code" && OV.classifyField("100%") === "code");
    ok("分类：全大写短标签 → label", OV.classifyField("SEPARATE PIECE") === "label" && OV.classifyField("EMBROIDERY") === "label");
    ok("分类：长说明句 → note", OV.classifyField("Please use same execution for hair & face embroidery") === "note");
    ok("分类：中文短标签 → label", OV.classifyField("材质规格") === "label");
  }

  // ---------- 去重：同一处只留一条 ----------
  {
    // 几乎同一个位置、文本略有差别（模拟"裙子被翻译两次"）
    const dup = U.dedupeOverlappingItems([
      { x: 10, y: 10, w: 100, h: 20, src: "Skirt", dst: "裙子" },
      { x: 12, y: 11, w: 98, h: 19, src: "Skirf", dst: "裙子" },
    ]);
    ok("去重：同一处的两次识别被合并成 1 条", dup.items.length === 1, "剩 " + dup.items.length);
    ok("去重：计入了合并数", dup.merged === 1, "merged=" + dup.merged);

    // 上下相邻的两行文字不能被误合并
    const stack = U.dedupeOverlappingItems([
      { x: 10, y: 10, w: 100, h: 20, src: "Front", dst: "正面" },
      { x: 10, y: 32, w: 100, h: 20, src: "Back", dst: "背面" },
    ]);
    ok("去重：上下相邻的两行不会被误合并", stack.items.length === 2, "剩 " + stack.items.length);

    // 同一行的两个不同标签不能被误合并
    const sameRow = U.dedupeOverlappingItems([
      { x: 10, y: 10, w: 60, h: 20, src: "Colors", dst: "配色" },
      { x: 300, y: 10, w: 60, h: 20, src: "Sizes", dst: "尺寸" },
    ]);
    ok("去重：同一行的远处标签不会被误合并", sameRow.items.length === 2, "剩 " + sameRow.items.length);

    // 保留带译文的那条
    const prefer = U.dedupeOverlappingItems([
      { x: 10, y: 10, w: 100, h: 20, src: "Skirt", dst: "" },
      { x: 12, y: 11, w: 98, h: 19, src: "Skirt", dst: "裙子" },
    ]);
    ok("去重：保留带译文的那条", prefer.items.length === 1 && prefer.items[0].dst === "裙子", JSON.stringify(prefer.items[0]));
  }
}

/* ============================================================
 * 11. 端到端去重：同一处被识别两次时，中文只画一次
 * ============================================================ */

console.log("\n[11] 端到端去重（模拟视觉模型两遍返回同一处）");

{
  const U = globalThis.PZUtil;
  const OV = globalThis.PZOverlay;

  function inkCtx(W, H, rects) {
    function isInk(x, y) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
      }
      return false;
    }
    return {
      getImageData: function (x, y, w, h) {
        const data = new Uint8ClampedArray(Math.max(0, w * h * 4));
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const o = (yy * w + xx) * 4;
            const v = isInk(x + xx, y + yy) ? 0 : 255;
            data[o] = v;
            data[o + 1] = v;
            data[o + 2] = v;
            data[o + 3] = 255;
          }
        }
        return { width: w, height: h, data: data };
      },
    };
  }

  const W = 400;
  const H = 200;
  // 原文墨迹在 (120,50)-(180,64)
  const inkRects = [{ x: 120, y: 50, w: 60, h: 14 }];

  function factory() {
    const src = inkCtx(W, H, inkRects);
    return function (w, h) {
      const cv = { width: w, height: h, _c: null };
      cv.getContext = function () {
        if (!cv._c) {
          const draws = [];
          const texts = [];
          cv._c = {
            canvas: { width: w, height: h },
            fills: draws,
            texts: texts,
            font: "",
            fillStyle: "",
            letterSpacing: "",
            textAlign: "",
            textBaseline: "",
            imageSmoothingEnabled: true,
            imageSmoothingQuality: "",
            measureText: function (s) {
              const m = /(\d+(?:\.\d+)?)px/.exec(cv._c.font);
              const fs = m ? parseFloat(m[1]) : 10;
              let wpx = 0;
              for (const ch of String(s)) {
                wpx += /[\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fs : fs * 0.55;
              }
              return { width: wpx };
            },
            getImageData: src.getImageData,
            createImageData: function (ww, hh) {
              return { width: ww, height: hh, data: new Uint8ClampedArray(Math.max(0, ww * hh * 4)) };
            },
            fillRect: function (x, y, ww, hh) {
              draws.push({ x: x, y: y, w: ww, h: hh });
            },
            fillText: function (t, x, y) {
              texts.push({ t: String(t), x: x, y: y });
            },
            save: function () {},
            restore: function () {},
            beginPath: function () {},
            rect: function () {},
            clip: function () {},
            clearRect: function () {},
            putImageData: function () {},
            drawImage: function () {},
          };
        }
        return cv._c;
      };
      return cv;
    };
  }

  // 模拟真实情形：同一处文字被"区域遍"和"整图遍"各返回一次，
  // 位置差几像素，文本差一个字母（相似度掉到阈值以下，只靠文本比对会漏网）
  const raw = [
    { x: 114, y: 46, w: 72, h: 22, src: "Skirt", dst: "裙子" },
    { x: 117, y: 48, w: 70, h: 21, src: "Skirf", dst: "裙子" },
  ];
  // 另一处完全不相干的文字，不能被误合并
  const other = { x: 20, y: 140, w: 120, h: 20, src: "Colors", dst: "配色" };

  globalThis.PZUtil.setCanvasFactory(factory());
  const srcCanvas = U.createCanvas(W, H);

  // ---- 修复前的行为：不去重，两条都画 ----
  const before = OV.render(srcCanvas, raw.concat([other]), { cover: true, minFontSize: 6 });
  const beforeTexts = before.getContext().texts.filter(function (t) {
    return t.t === "裙子";
  });
  ok(
    "对照：不去重时同一处会画两次（这就是「看起来翻译了两次」）",
    beforeTexts.length === 2,
    "画了 " + beforeTexts.length + " 次"
  );

  // ---- 修复后：先去重再画 ----
  const dd = U.dedupeOverlappingItems(raw.concat([other]));
  ok("去重后只剩 2 条（重复的那处合并掉，另一处保留）", dd.items.length === 2, "剩 " + dd.items.length);
  ok("合并计数 = 1", dd.merged === 1, "merged=" + dd.merged);

  const after = OV.render(srcCanvas, dd.items, { cover: true, minFontSize: 6 });
  const afterTexts = after.getContext().texts.filter(function (t) {
    return t.t === "裙子";
  });
  const otherTexts = after.getContext().texts.filter(function (t) {
    return t.t === "配色";
  });
  ok("修复后同一处只画一次", afterTexts.length === 1, "画了 " + afterTexts.length + " 次");
  ok("不相干的那处照常画", otherTexts.length === 1, "画了 " + otherTexts.length + " 次");
  // 去重后两条 item 各处理一次。默认是「纯色填充」模式，两条都走 fill 路径 ——
  // 这一条断言的是"每条都真的被擦过"，而不是"用哪种方式擦的"。
  const st = after._overlayStats;
  ok("覆盖：两条 item 各处理一次，没有重复覆盖", st.drawn === 2, "drawn=" + st.drawn);
  ok(
    "覆盖：两条都走了去字（默认纯色填充），没有漏掉",
    st.inpainted === 2 && st.inpaintFallback === 0,
    "inpainted=" + st.inpainted + " fallback=" + st.inpaintFallback
  );

  globalThis.PZUtil.setCanvasFactory(null);
}

/* ============================================================
 * 汇总
 * ============================================================ */

console.log("\n" + "=".repeat(60));
console.log("集成测试：通过 " + pass + " / 失败 " + fail);
if (failures.length) {
  console.log("\n失败项：");
  failures.forEach(function (f) {
    console.log("  · " + f);
  });
  process.exitCode = 1;
}