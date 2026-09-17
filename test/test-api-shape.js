/**
 * 接口形状测试：验证模块之间的接口没有漂移。
 *
 * 10 个模块的重写里，最常见的失败不是算法错，而是"某个函数改名了 /
 * 被删了 / 换了参数"，而这类问题只有运行时点下去才会炸。
 * 这里把所有跨模块调用点固化成断言，改坏立刻就能发现。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const JS_DIR = path.join(ROOT, "js");

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

// 顺序与 index.html 一致
["js/util.js", "js/config.js", "js/imageproc.js", "js/detect.js", "js/overlay.js",
 "js/ocr-local.js", "js/vision.js", "js/translate.js", "js/pdf-engine.js"].forEach(load);

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
if (loadErrors.length) {
  loadErrors.forEach(function (e) {
    ok(e, false);
  });
} else {
  console.log("  ✓ 全部模块加载成功");
}

/* ============================================================
 * 1. app.js 依赖的接口必须存在
 * ============================================================ */

console.log("\n[1] app.js 依赖的跨模块接口");

// 这张表是从 js/app.js 里实际出现的调用点整理出来的
const REQUIRED = {
  PZUtil: ["createCanvas", "ctx2d", "clamp", "isAbortError", "abortError", "throwIfAborted", "pool", "cropCanvas", "cloneCanvas", "fmtDuration", "toRect"],
  PZConfig: ["VERSION", "LIMITS", "VISION_PRESETS", "LLM_PRESETS", "PROFILES", "parseGlossary", "TARGET_LANGS"],
  PZOverlay: ["render"],
  PZDetect: ["detect"],
  PZOcr: ["recognize", "terminate"],
  PZVision: ["translate", "testKey", "listModels"],
  PZTranslate: ["translateMany", "listLlmModels", "testLlm"],
  PZPdf: ["loadDocument", "extractPage", "renderPage", "canvasesToPdf", "download", "FONT_STACK"],
};

Object.keys(REQUIRED).forEach(function (mod) {
  const obj = globalThis[mod];
  if (!obj) {
    ok(mod + " 存在", false, "模块根本没挂到全局");
    return;
  }
  const missing = REQUIRED[mod].filter(function (k) {
    return obj[k] === undefined || obj[k] === null;
  });
  ok(
    mod + " 提供了 app.js 需要的全部接口（" + REQUIRED[mod].length + " 项）",
    missing.length === 0,
    missing.length ? "缺失：" + missing.join(", ") : ""
  );
  // 是函数的必须是函数
  const notFn = REQUIRED[mod].filter(function (k) {
    // 常量类导出不需要是函数
    if (["VERSION", "LIMITS", "VISION_PRESETS", "LLM_PRESETS", "PROFILES", "TARGET_LANGS", "FONT_STACK"].indexOf(k) >= 0) return false;
    return typeof obj[k] !== "function";
  });
  ok(mod + " 的接口都是可调用的", notFn.length === 0, notFn.length ? "不是函数：" + notFn.join(", ") : "");
});

/* ============================================================
 * 2. app.js 用到的 LIMITS 键必须都存在
 * ============================================================ */

console.log("\n[2] PZConfig.LIMITS 的键");

const appJs = fs.readFileSync(path.join(JS_DIR, "app.js"), "utf8");
const usedLimitKeys = new Set();
let m;
const reLimit = /C\.LIMITS\.(\w+)/g;
while ((m = reLimit.exec(appJs))) usedLimitKeys.add(m[1]);

// 其它模块也会读 LIMITS，一并纳入。
// 这里用"整词出现"而不是解析语法：模块里既有 LIMITS.xxx，也有把 LIMITS
// 拷进局部变量之后的 L.xxx（甚至 L = opts.limits || LIMITS），
// 语法解析容易漏，整词搜索更可靠。
const allModuleSource = fs
  .readdirSync(JS_DIR)
  .filter(function (f) {
    return f.endsWith(".js") && f !== "config.js";
  })
  .map(function (f) {
    return fs.readFileSync(path.join(JS_DIR, f), "utf8");
  })
  .join("\n");

const LIMITS = globalThis.PZConfig.LIMITS;
const missingLimits = [];
const deadLimits = [];

Object.keys(LIMITS).forEach(function (k) {
  if (!new RegExp("\\b" + k + "\\b").test(allModuleSource)) deadLimits.push(k);
});
usedLimitKeys.forEach(function (k) {
  if (!(k in LIMITS)) missingLimits.push(k);
});

ok(
  "代码里引用的每个 LIMITS 键都在 PZConfig.LIMITS 里有定义（共检查 " + usedLimitKeys.size + " 个）",
  missingLimits.length === 0,
  missingLimits.length ? "未定义：" + missingLimits.join(", ") : ""
);

// 反面同样重要：定义了却没人读的键会让人以为"改了有用"，实际毫无作用。
// 一开始就踩过这个坑（visionRegionFirst / ocrBandZoom / pdfImageFormat / overlayCover）。
ok(
  "LIMITS 里没有死配置（每个键都至少被一个模块读取）",
  deadLimits.length === 0,
  deadLimits.length ? "定义了但没人读：" + deadLimits.join(", ") : ""
);

/* ============================================================
 * 3. 不能残留对已删除模块的引用
 * ============================================================ */

console.log("\n[3] 已删除的旧模块不能被引用");

// image-engine.js / translator.js 已被替换并删除，
// 任何残留引用都是运行时 crash（undefined is not an object）
const DEAD_GLOBALS = ["ImageEngine", "PdfTranslator", "PdfEngine"];
const pages = ["index.html", "selftest.html"];

pages.forEach(function (p) {
  const full = path.join(ROOT, p);
  if (!fs.existsSync(full)) return;
  const src = fs.readFileSync(full, "utf8");
  const hits = DEAD_GLOBALS.filter(function (g) {
    return new RegExp("\\b" + g + "\\b").test(src);
  });
  ok(p + " 没有引用已删除的旧模块", hits.length === 0, hits.length ? "残留：" + hits.join(", ") : "");
});

const jsFiles = fs.readdirSync(JS_DIR).filter(function (f) {
  return f.endsWith(".js");
});
const deadRefs = [];
jsFiles.forEach(function (f) {
  const src = fs.readFileSync(path.join(JS_DIR, f), "utf8");
  DEAD_GLOBALS.forEach(function (g) {
    // 允许出现在注释里（说明历史），但不允许出现在代码里
    const lines = src.split(/\r?\n/);
    lines.forEach(function (line, i) {
      const trimmed = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
      if (new RegExp("\\b" + g + "\\b").test(line)) {
        deadRefs.push(f + ":" + (i + 1) + " 引用了 " + g);
      }
    });
  });
});
ok(
  "js/ 下没有代码引用已删除的旧模块（注释里提到可以）",
  deadRefs.length === 0,
  deadRefs.length ? deadRefs.join("; ") : ""
);

/* ============================================================
 * 4. 防领域过拟合：硬编码词不能散落在算法层
 * ============================================================ */

console.log("\n[4] 领域过拟合回归");

// 原来这些词硬编码在 translator.js / image-engine.js 里，
// 换一份普通客户资料就会被带偏。现在只允许出现在 config.js 的领域预设里。
const DOMAIN_WORDS = ["hololive", "Takanashi", "Kiara", "Duolingo", "Buff Duo", "Jakks", "Calliope", "Ninomae"];

/**
 * 去掉注释再检查。
 * 注释里提到历史（"原实现把 Hololive 词表写死在代码里"）是**应该**保留的说明，
 * 不能算违规；只有真正会被执行的字符串才算。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ") // 块注释
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1"); // 行注释（[^:] 是为了不误伤 http://）
}

const offenders = [];
jsFiles.forEach(function (f) {
  if (f === "config.js") return; // 领域预设本来就该放在这里
  const code = stripComments(fs.readFileSync(path.join(JS_DIR, f), "utf8"));
  code.split(/\r?\n/).forEach(function (line, i) {
    DOMAIN_WORDS.forEach(function (w) {
      if (line.indexOf(w) >= 0) {
        offenders.push(f + " 第 " + (i + 1) + " 行出现「" + w + "」");
      }
    });
  });
});
ok(
  "算法层模块的可执行代码里没有具体产品/角色词（只允许在 config.js 的领域预设里）",
  offenders.length === 0,
  offenders.length ? offenders.join("; ") : ""
);

// 系统提示词里也不能写死领域
const promptOffenders = [];
["vision.js", "translate.js", "ocr-local.js", "detect.js", "imageproc.js", "overlay.js"].forEach(function (f) {
  const code = stripComments(fs.readFileSync(path.join(JS_DIR, f), "utf8"));
  if (/你是玩具|产品规格图翻译|规格图译者|玩具\/产品规格/.test(code)) {
    promptOffenders.push(f + " 的可执行代码里出现了硬编码的领域提示词");
  }
});
ok(
  "没有任何模块硬编码领域提示词（必须从 PZConfig 构建）",
  promptOffenders.length === 0,
  promptOffenders.join("; ")
);

// 提示词构建函数必须真的来自 PZConfig
ok(
  "PZConfig 提供了提示词构建接口",
  typeof globalThis.PZConfig.buildRegionPrompt === "function" &&
    typeof globalThis.PZConfig.buildWholePrompt === "function" &&
    typeof globalThis.PZConfig.buildTranslateSystem === "function" &&
    typeof globalThis.PZConfig.buildTranslateBatchUser === "function"
);

/* ============================================================
 * 5. 关键默认值必须合理
 * ============================================================ */

console.log("\n[5] 关键默认值");

ok("PDF 渲染倍率 ≥ 2（保证 144dpi 以上）", LIMITS.pdfRenderScale >= 2, "当前 " + LIMITS.pdfRenderScale);
ok("本地 OCR worker 数 ≥ 2（原实现是单 worker 串行）", LIMITS.ocrWorkers >= 2, "当前 " + LIMITS.ocrWorkers);
ok("视觉模型并发 ≥ 2", LIMITS.visionConcurrency >= 2, "当前 " + LIMITS.visionConcurrency);
ok("区域放大目标不小于 640px（小字才看得清）", LIMITS.regionCropMinSide >= 640, "当前 " + LIMITS.regionCropMinSide);
// 旧实现是固定 64 个区域块 + 3 次全图探测，纯粹是浪费；
// 但也不能太小：大图纸分块检测之后区域会变多，上限太小会把页面下半部分整段截掉，
// 那一整块就永远不会被翻译。
ok(
  "区域上限足够覆盖分块后的大图纸（旧实现是固定 64 块 + 3 次全图探测，纯浪费）",
  LIMITS.visionMaxRegions <= 64 && LIMITS.visionMaxRegions >= 24,
  "当前 " + LIMITS.visionMaxRegions
);

const vis = globalThis.PZConfig.VISION_PRESETS;
ok(
  "每个视觉预设都标明了协议（gemini / openai）",
  Object.keys(vis).every(function (k) {
    return vis[k].api === "gemini" || vis[k].api === "openai";
  })
);
ok(
  "视觉预设里没有把 DeepSeek 当成视觉模型（DeepSeek 不支持图片输入）",
  !/deepseek/i.test(JSON.stringify(Object.keys(vis))) && !(vis.deepseek)
);

/* ============================================================
 * 汇总
 * ============================================================ */

console.log("\n" + "=".repeat(60));
console.log("接口形状测试：通过 " + pass + " / 失败 " + fail);
if (failures.length) {
  console.log("\n失败项：");
  failures.forEach(function (f) {
    console.log("  · " + f);
  });
  process.exitCode = 1;
}
