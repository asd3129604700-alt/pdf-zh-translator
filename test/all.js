/**
 * 测试汇总入口：`node test/all.js`
 *
 * 依次运行各个测试文件，最后给出总汇总。任何一个失败都以非 0 退出码结束，
 * 这样可以直接接到 CI 或 pre-commit 上。
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const here = __dirname;
const files = fs
  .readdirSync(here)
  .filter(function (f) {
    return /^test-.*\.js$/.test(f) || f === "run-tests.js";
  })
  .sort();

if (!files.length) {
  console.log("没有找到任何测试文件。");
  process.exit(0);
}

let failed = 0;

for (const f of files) {
  const full = path.join(here, f);
  console.log("\n" + "=".repeat(64));
  console.log("运行 " + f);
  console.log("=".repeat(64));
  const r = spawnSync(process.execPath, [full], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log("\n" + "=".repeat(64));
if (failed) {
  console.log("测试文件失败数：" + failed + " / " + files.length);
  process.exitCode = 1;
} else {
  console.log("全部测试文件通过：" + files.length + " 个");
}
