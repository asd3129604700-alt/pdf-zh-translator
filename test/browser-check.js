/**
 * 真实浏览器验证（可选，不属于 `node test/all.js` 的常规套件）
 *
 * 为什么需要它：Node 里跑不了的东西——canvas 文字度量、getImageData、
 * Tesseract worker、真实图片解码——只有真浏览器能覆盖。而这个项目最大的一次
 * bug（Tesseract TSV 行级 conf 恒为 -1，导致本地 OCR 在真实图片上恒返回 0 行）
 * 正是靠这个脚本抓到的：单测的 fixture 编了个 92.5，真实输出是 -1。
 *
 * 依赖：playwright（本仓库刻意不作为依赖，需要时单独装）
 *   npm i -D playwright && npx playwright install chromium
 *
 * 用法：
 *   node test/browser-check.js                       # 只做页面加载 + UI 冒烟
 *   node test/browser-check.js <素材目录>             # 额外对目录里的图片跑检测
 *
 * 素材目录里的图片只用于本地验证，`.gitignore` 已排除所有图片，不会进仓库。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const ASSET_DIR = process.argv[2] ? path.resolve(process.argv[2]) : null;

let chromium;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  console.error("未安装 playwright，跳过浏览器验证。");
  console.error("需要时执行：npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

/**
 * 找 chromium 可执行文件。
 * playwright 默认要的是 `chromium_headless_shell`，但很多人只装了完整版
 * `chromium`，这时默认 launch 会直接报 "Executable doesn't exist"。
 * 这里主动去 ms-playwright 缓存里找一份能用的，省得用户自己配路径。
 */
function findChromium() {
  if (process.env.PZ_CHROMIUM && fs.existsSync(process.env.PZ_CHROMIUM)) {
    return process.env.PZ_CHROMIUM;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {
    /* 继续找 */
  }
  const cache = path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || "", "ms-playwright");
  if (!fs.existsSync(cache)) return null;
  const dirs = fs.readdirSync(cache).filter(function (d) {
    return d.indexOf("chromium") === 0;
  });
  for (const d of dirs) {
    const candidates = [
      path.join(cache, d, "chrome-win64", "chrome.exe"),
      path.join(cache, d, "chrome-win", "chrome.exe"),
      path.join(cache, d, "chrome-linux", "chrome"),
      path.join(cache, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(cache, d, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
      path.join(cache, d, "chrome-headless-shell-linux", "chrome-headless-shell"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

/* ---------------- 极简静态服务 ---------------- */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function startServer() {
  const roots = [{ prefix: "/", dir: ROOT }];
  if (ASSET_DIR) roots.push({ prefix: "/assets/", dir: ASSET_DIR });

  const server = http.createServer(function (req, res) {
    let rel;
    try {
      rel = decodeURIComponent(req.url.split("?")[0]);
    } catch (e) {
      rel = "/";
    }
    let dir = ROOT;
    let sub = rel;
    for (let i = 0; i < roots.length; i++) {
      if (roots[i].prefix !== "/" && rel.indexOf(roots[i].prefix) === 0) {
        dir = roots[i].dir;
        sub = rel.slice(roots[i].prefix.length - 1);
        break;
      }
    }
    if (sub === "/") sub = "/index.html";
    const file = path.join(dir, path.normalize(sub).replace(/^[/\\]+/, ""));
    if (file.indexOf(dir) !== 0) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, function (err, buf) {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(buf);
    });
  });

  // 端口让操作系统分配：固定端口很容易撞上上一次没退干净的进程，
  // 表现是 EADDRINUSE 甚至静默卡住，排查起来很费时间。
  return new Promise(function (resolve, reject) {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", function () {
      resolve({ server: server, port: server.address().port });
    });
  });
}

/* ---------------- 断言 ---------------- */

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

/* ---------------- 主流程 ---------------- */

(async function () {
  const exe = findChromium();
  if (!exe) {
    console.error("找不到 chromium 可执行文件，跳过浏览器验证。");
    console.error("执行：npx playwright install chromium，或用 PZ_CHROMIUM 指定路径。");
    process.exit(0);
  }

  const started = await startServer();
  const server = started.server;
  const base = "http://127.0.0.1:" + started.port;

  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", function (m) {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", function (e) {
    pageErrors.push(e.message);
  });

  console.log("\n[1] 加载 index.html");
  await page.goto(base + "/index.html", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(1200);

  const mods = await page.evaluate(function () {
    const names = ["PZUtil", "PZConfig", "PZImage", "PZDetect", "PZOverlay", "PZOcr", "PZVision", "PZTranslate", "PZPdf"];
    const out = { modules: {} };
    names.forEach(function (n) {
      out.modules[n] = !!window[n];
    });
    out.uploadVisible = !document.querySelector("#panel-upload").classList.contains("hidden");
    out.startDisabled = document.querySelector("#btn-start").disabled;
    out.glossaryRows = (document.querySelector("#opt-glossary").value || "").split("\n").length;
    return out;
  });

  const missingMods = Object.keys(mods.modules).filter(function (k) {
    return !mods.modules[k];
  });
  ok("9 个模块全部加载", missingMods.length === 0, missingMods.join(", "));
  ok("上传面板默认可见", mods.uploadVisible);
  ok("未选文件时开始按钮禁用", mods.startDisabled);
  ok("通用文档预设默认空术语表", mods.glossaryRows <= 1, "行数 " + mods.glossaryRows);
  ok("没有未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  console.log("\n[2] UI 联动");
  const ui = await page.evaluate(function () {
    function fire(sel, evt) {
      const el = document.querySelector(sel);
      el.dispatchEvent(new Event(evt, { bubbles: true }));
    }
    document.querySelector("#opt-ocr-engine-local").checked = true;
    fire("#opt-ocr-engine-local", "change");
    const afterLocal = {
      visionHidden: document.querySelector("#vision-box").classList.contains("hidden"),
      translateEnabled: !document.querySelector("#opt-translate-engine").disabled,
    };
    document.querySelector("#opt-translate-engine").value = "llm";
    fire("#opt-translate-engine", "change");
    const llmShown = !document.querySelector("#llm-box").classList.contains("hidden");

    document.querySelector("#opt-ocr-engine-vision").checked = true;
    fire("#opt-ocr-engine-vision", "change");
    const afterVision = {
      visionShown: !document.querySelector("#vision-box").classList.contains("hidden"),
      translateDisabled: document.querySelector("#opt-translate-engine").disabled,
    };
    return { afterLocal: afterLocal, llmShown: llmShown, afterVision: afterVision };
  });

  ok("选本地 OCR 时视觉配置区隐藏", ui.afterLocal.visionHidden);
  ok("选本地 OCR 时翻译方式可用", ui.afterLocal.translateEnabled);
  ok("翻译方式选大模型时文本模型配置区出现", ui.llmShown);
  ok("选视觉模型时视觉配置区出现", ui.afterVision.visionShown);
  // 视觉模型直接翻译时，「翻译方式」不生效，必须禁用而不是留着可点
  ok("视觉模型直接翻译时翻译方式被禁用", ui.afterVision.translateDisabled);

  console.log("\n[2b] 新增控件");
  const extra = await page.evaluate(function () {
    const z = document.querySelector("#opt-preview-zoom");
    const c = document.querySelector("#opt-field-colors");
    return {
      zoomExists: !!z,
      zoomOptions: z ? z.options.length : 0,
      zoomDefault: z ? z.value : null,
      colorExists: !!c,
      colorDefault: c ? c.checked : null,
    };
  });
  ok("预览缩放下拉存在且有 3 档（适应窗口 / 100% / 200%）", extra.zoomExists && extra.zoomOptions === 3, JSON.stringify(extra));
  ok("预览缩放默认「适应窗口」", extra.zoomDefault === "fit", String(extra.zoomDefault));
  ok("字段配色开关存在", extra.colorExists);
  // 默认必须是关的：它会改变原文档观感，不该默认生效
  ok("字段配色默认关闭", extra.colorDefault === false, String(extra.colorDefault));

  if (ASSET_DIR && fs.existsSync(ASSET_DIR)) {
    console.log("\n[3] 真实素材检测：" + ASSET_DIR);
    const files = fs.readdirSync(ASSET_DIR).filter(function (f) {
      return /\.(png|jpe?g|webp)$/i.test(f);
    });
    if (!files.length) {
      console.log("  （目录里没有图片）");
    }
    for (const f of files) {
      const r = await page.evaluate(async function (u) {
        const img = await new Promise(function (res, rej) {
          const i = new Image();
          i.onload = function () { res(i); };
          i.onerror = function () { rej(new Error("load fail")); };
          i.src = u;
        });
        const k = Math.min(1, 3800 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = window.PZUtil.createCanvas(Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k));
        const ctx = window.PZUtil.ctx2d(c);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const t0 = performance.now();
        const det = window.PZDetect.detect(c, {});
        return {
          nat: img.naturalWidth + "×" + img.naturalHeight,
          lines: det.lines.length,
          regions: det.regions.length,
          ms: Math.round(performance.now() - t0),
        };
      }, base + "/assets/" + encodeURIComponent(f));
      console.log(
        "  " + f.padEnd(28) + " " + r.nat.padEnd(12) + " → " + String(r.lines).padStart(3) +
        " 行 / " + String(r.regions).padStart(2) + " 区域 / " + r.ms + "ms"
      );
      ok("  " + f + " 检测到文字", r.lines > 0, "0 行");
    }
  } else {
    console.log("\n[3] 未提供素材目录，跳过真实图片检测");
    console.log("    用法：node test/browser-check.js <素材目录>");
  }

  console.log("\n[4] 错误汇总");
  ok("console 无 error", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
  ok("无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));

  await browser.close();
  server.close();

  console.log("\n" + "=".repeat(60));
  console.log("浏览器验证：通过 " + pass + " / 失败 " + fail);
  if (failures.length) {
    console.log("\n失败项：");
    failures.forEach(function (f) {
      console.log("  · " + f);
    });
    process.exitCode = 1;
  }
})().catch(function (e) {
  console.error("验证脚本失败：" + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
