/**
 * 本地静态服务 —— 开发和试用时用它打开页面。
 *
 * 为什么不能直接双击 index.html：
 *   pdf.js 的 worker 和 Tesseract 的 worker 在 file:// 下会被浏览器拦掉
 *   （跨源 Worker 限制），表现为 PDF 解析失败、本地 OCR 完全不可用。
 *   云端视觉识别不受影响，但既然要完整试用，就用 http。
 *
 * 用法：
 *   node scripts/serve.js            # 默认 8770 端口
 *   node scripts/serve.js 9000       # 指定端口
 *
 * 为什么默认不是 8765：8765 常被别的程序占用（某些 IDE / 宿主程序的内置预览服务
 * 就占着它）。撞上端口时请求会打到**别人的服务**上，表现为页面能打开但内容是旧的、
 * 或者某些文件莫名 404 —— 排查起来很费时间。8770 干净得多。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8770);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = http.createServer(function (req, res) {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  } catch (e) {
    rel = "/";
  }
  if (rel === "/") rel = "/index.html";

  const file = path.join(ROOT, path.normalize(rel).replace(/^[/\\]+/, ""));
  // 防目录穿越
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 forbidden");
    return;
  }

  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      // 开发时别缓存，改完刷新就能看到
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(buf);
  });
});

server.on("error", function (err) {
  if (err && err.code === "EADDRINUSE") {
    console.error("端口 " + PORT + " 已被占用。换一个：node scripts/serve.js 9000");
  } else {
    console.error("启动失败：" + (err && err.message ? err.message : err));
  }
  process.exitCode = 1;
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("服务已启动，目录：" + ROOT);
  console.log("");
  console.log("  主界面：  http://127.0.0.1:" + PORT + "/index.html");
  console.log("  自测页：  http://127.0.0.1:" + PORT + "/selftest.html");
  console.log("");
  console.log("按 Ctrl+C 停止。");
});
