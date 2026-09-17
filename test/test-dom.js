/**
 * DOM 契约测试：app.js 引用的每个元素 id 必须存在于 index.html。
 *
 * 这类问题的表现是"页面加载后某个功能静默失效"或者"点一下就报
 * Cannot read properties of null" —— 靠肉眼 review 很容易漏，
 * 而用脚本比对是零成本的。同理也检查 selftest.html 引用的模块是否都存在。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/* ============================================================
 * 1. app.js 需要哪些 id
 * ============================================================ */

console.log("\n[1] app.js ↔ index.html");

const appJs = read("js/app.js");
const indexHtml = read("index.html");

// app.js 里所有 $("#xxx") 形式的选择器
const needed = new Set();
const re = /\$\(\s*"#([A-Za-z0-9_-]+)"\s*\)/g;
let m;
while ((m = re.exec(appJs))) needed.add(m[1]);

ok("app.js 里解析到一批 id 选择器", needed.size > 40, "共 " + needed.size + " 个");

// index.html 里声明的 id
const declared = new Set();
const reId = /\bid\s*=\s*"([A-Za-z0-9_-]+)"/g;
while ((m = reId.exec(indexHtml))) declared.add(m[1]);

const missing = [];
needed.forEach(function (id) {
  if (!declared.has(id)) missing.push(id);
});
ok(
  "app.js 引用的所有 id 都在 index.html 里存在",
  missing.length === 0,
  missing.length ? "缺失：" + missing.join(", ") : ""
);

// 反向检查：HTML 里声明了但从没被 app.js 引用的 id（多半是改名后留下的死元素）
const unusedInHtml = [];
declared.forEach(function (id) {
  // 有些 id 是给 label[for] 或 CSS 用的，允许存在
  if (needed.has(id)) return;
  if (indexHtml.indexOf('for="' + id + '"') >= 0) return;
  if (new RegExp("#" + id + "\\b").test(read("css/style.css"))) return;
  unusedInHtml.push(id);
});
console.log(
  "  · 提示：HTML 里有 " + unusedInHtml.length + " 个 id 未被 app.js 直接引用" +
    (unusedInHtml.length ? "（" + unusedInHtml.join(", ") + "）" : "")
);

/* ============================================================
 * 2. label[for] 必须指向存在的表单元素
 * ============================================================ */

console.log("\n[2] label[for] 指向的表单元素");

const forAttrs = [];
const reFor = /\bfor\s*=\s*"([A-Za-z0-9_-]+)"/g;
while ((m = reFor.exec(indexHtml))) forAttrs.push(m[1]);

const badFor = forAttrs.filter(function (id) {
  return !declared.has(id);
});
ok("每个 label[for] 都指向存在的元素", badFor.length === 0, badFor.length ? "悬空：" + badFor.join(", ") : "");

/* ============================================================
 * 3. script 标签引用的文件必须存在
 * ============================================================ */

console.log("\n[3] 页面引用的脚本文件");

function checkScripts(pageFile) {
  const html = read(pageFile);
  const srcs = [];
  const reSrc = /<script[^>]+src\s*=\s*"([^"]+)"/g;
  while ((m = reSrc.exec(html))) srcs.push(m[1]);

  const local = srcs.filter(function (s) {
    return !/^https?:/i.test(s);
  });
  const missingFiles = local.filter(function (s) {
    return !fs.existsSync(path.join(ROOT, s));
  });
  ok(
    pageFile + " 的本地脚本都存在",
    missingFiles.length === 0,
    missingFiles.length ? "缺失：" + missingFiles.join(", ") : ""
  );

  // 加载顺序：util 必须在 config/其它之前，config 在算法层之前
  const order = local.map(function (s) {
    return path.basename(s);
  });
  const iUtil = order.indexOf("util.js");
  const iConfig = order.indexOf("config.js");
  const iOverlay = order.indexOf("overlay.js");
  ok(pageFile + "：util.js 在其它模块之前加载", iUtil === 0, "顺序：" + order.join(" → "));
  ok(
    pageFile + "：config.js 在 util.js 之后",
    iConfig < 0 || iConfig > iUtil,
    "顺序：" + order.join(" → ")
  );
  ok(
    pageFile + "：overlay.js 在 util.js 之后",
    iOverlay < 0 || iOverlay > iUtil,
    "顺序：" + order.join(" → ")
  );
}

checkScripts("index.html");
checkScripts("selftest.html");

/* ============================================================
 * 4. 模块依赖：每个模块声明的依赖都真的存在
 * ============================================================ */

console.log("\n[4] 模块间依赖");

const jsDir = path.join(ROOT, "js");
const files = fs
  .readdirSync(jsDir)
  .filter(function (f) {
    return f.endsWith(".js");
  })
  // app.js 是控制器，按设计不导出任何全局对象
  .filter(function (f) {
    return f !== "app.js";
  });

ok(
  "js/ 下每个模块都按约定挂到 window/globalThis（经典脚本，非 ES module）",
  files.every(function (f) {
    const src = fs.readFileSync(path.join(jsDir, f), "utf8");
    return src.indexOf("typeof window !== \"undefined\" ? window : globalThis") >= 0;
  }),
  "有模块没有按约定挂载"
);

ok(
  "所有模块都不是 ES module（没有 import / export 语句，否则 file:// 下会失效）",
  files.every(function (f) {
    const src = fs.readFileSync(path.join(jsDir, f), "utf8");
    return !/^\s*(import|export)\s/m.test(src);
  }),
  "有模块用了 ES module 语法"
);

// 旧文件不能还留在仓库里被误引用
const legacy = ["image-engine.js", "translator.js"].filter(function (f) {
  return fs.existsSync(path.join(jsDir, f));
});
if (legacy.length) {
  const referenced = legacy.filter(function (f) {
    return indexHtml.indexOf(f) >= 0 || appJs.indexOf(f) >= 0;
  });
  ok(
    "旧的 " + legacy.join(" / ") + " 已不被任何页面引用（可以安全删除）",
    referenced.length === 0,
    referenced.length ? "仍被引用：" + referenced.join(", ") : ""
  );
}

/* ============================================================
 * 5. selftest.html 引用的模块接口都必须存在
 * ============================================================ */

console.log("\n[5] selftest.html 引用的接口");

{
  const stHtml = read("selftest.html");

  // 先把 `var U = window.PZUtil;` 这类别名收集起来
  const aliasToGlobal = {};
  const reAlias = /var\s+(\w+)\s*=\s*window\.(PZ\w+)\s*;/g;
  let a;
  while ((a = reAlias.exec(stHtml))) aliasToGlobal[a[1]] = a[2];

  const referenced = new Map(); // "PZUtil.similarity" -> 出现次数

  // window.PZXxx.method(...)
  const reDirect = /window\.(PZ\w+)\.(\w+)\s*\(/g;
  while ((a = reDirect.exec(stHtml))) {
    const key = a[1] + "." + a[2];
    referenced.set(key, (referenced.get(key) || 0) + 1);
  }
  // 别名.method(...)
  Object.keys(aliasToGlobal).forEach(function (alias) {
    const g = aliasToGlobal[alias];
    const re = new RegExp("\\b" + alias + "\\.(\\w+)\\s*\\(", "g");
    let mm;
    while ((mm = re.exec(stHtml))) {
      const key = g + "." + mm[1];
      referenced.set(key, (referenced.get(key) || 0) + 1);
    }
  });

  ok("从 selftest.html 里解析出接口引用", referenced.size > 5, "共 " + referenced.size + " 个");

  // 这些模块在浏览器里会被 script 标签加载，这里用 Node 加载同一批文件来核对接口
  const loadErrors = [];
  [
    "js/util.js",
    "js/config.js",
    "js/imageproc.js",
    "js/detect.js",
    "js/overlay.js",
    "js/ocr-local.js",
    "js/vision.js",
    "js/translate.js",
    "js/pdf-engine.js",
  ].forEach(function (rel) {
    try {
      // eslint-disable-next-line no-eval
      (0, eval)(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    } catch (err) {
      loadErrors.push(rel + "：" + (err && err.message ? err.message : err));
    }
  });
  ok("selftest 用到的模块都能加载", loadErrors.length === 0, loadErrors.join("; "));

  const missing = [];
  referenced.forEach(function (count, key) {
    const parts = key.split(".");
    const obj = globalThis[parts[0]];
    if (!obj) {
      missing.push(key + "（模块 " + parts[0] + " 不存在）");
      return;
    }
    if (typeof obj[parts[1]] !== "function") {
      missing.push(key + "（不是函数，实际是 " + typeof obj[parts[1]] + "）");
    }
  });
  ok(
    "selftest.html 调用的每个接口都真实存在",
    missing.length === 0,
    missing.length ? "缺失：" + missing.join("; ") : ""
  );
}

/* ============================================================
 * 6. 关键控件的静态检查
 *
 * 浏览器验证（test/browser-check.js）能查这些，但它需要 playwright + 能启动
 * Chromium；在受限环境里跑不了。所以这里用解析 HTML 的方式做一道静态兜底：
 * 默认值写错、选项少了，这种问题静态检查就能抓到。
 * ============================================================ */

console.log("\n[6] 关键控件的默认值与选项");

{
  function blockFor(id) {
    const i = indexHtml.indexOf('id="' + id + '"');
    if (i < 0) return "";
    // 往前找到这个标签的开始，往后取到它的结束标签
    const tagStart = indexHtml.lastIndexOf("<", i);
    const close = indexHtml.indexOf("</select>", i);
    const selfClose = indexHtml.indexOf(">", i);
    if (indexHtml.slice(tagStart, selfClose + 1).indexOf("<select") >= 0 && close >= 0) {
      return indexHtml.slice(tagStart, close + 9);
    }
    const inputEnd = indexHtml.indexOf(">", i);
    return indexHtml.slice(tagStart, inputEnd + 1);
  }

  // 预览缩放：3 档，默认"适应窗口"
  const zoom = blockFor("opt-preview-zoom");
  ok("预览缩放下拉存在", zoom.indexOf("<select") >= 0);
  ok(
    "预览缩放有 3 档（适应窗口 / 100% / 200%）",
    (zoom.match(/<option/g) || []).length === 3,
    "实际 " + (zoom.match(/<option/g) || []).length + " 档"
  );
  ok("预览缩放默认选中「适应窗口」", /<option value="fit"[^>]*selected/.test(zoom), zoom.replace(/\s+/g, " ").slice(0, 160));

  // 字段配色：默认必须关闭（它会改变原文档观感）
  const fc = blockFor("opt-field-colors");
  ok("字段配色开关存在", fc.indexOf("checkbox") >= 0, fc.replace(/\s+/g, " ").slice(0, 120));
  ok("字段配色默认关闭", fc.indexOf("checked") < 0, fc.replace(/\s+/g, " ").slice(0, 120));

  // 另外两个开关默认开着，别被误改
  ok("「保留型号代码」默认开启", blockFor("opt-preserve-codes").indexOf("checked") >= 0);
  ok("「覆盖原文」默认开启", blockFor("opt-cover").indexOf("checked") >= 0);

  // app.js 必须把这些控件接上（引用了 id 但没绑事件就是摆设）
  ["opt-preview-zoom", "opt-field-colors"].forEach(function (id) {
    ok("app.js 引用了 #" + id, appJs.indexOf('"#' + id + '"') >= 0);
  });
  ok(
    "预览缩放的 change 事件已绑定",
    /previewZoom\.addEventListener\(\s*"change"/.test(appJs)
  );
  ok(
    "字段配色的 change 事件已绑定",
    /fieldColors\.addEventListener\(\s*"change"/.test(appJs)
  );
}

/* ============================================================
 * 汇总
 * ============================================================ */

console.log("\n" + "=".repeat(60));
console.log("DOM 契约测试：通过 " + pass + " / 失败 " + fail);
if (failures.length) {
  console.log("\n失败项：");
  failures.forEach(function (f) {
    console.log("  · " + f);
  });
  process.exitCode = 1;
}
