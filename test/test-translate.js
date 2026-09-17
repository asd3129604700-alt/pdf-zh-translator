/**
 * PZTranslate / PZConfig 单元测试（Node，无第三方依赖）
 *
 * 运行：
 *   node test/test-translate.js
 *
 * 加载方式说明：这三个文件都是「经典脚本 + IIFE」，会把自己挂到 globalThis，
 * 所以直接 eval 源码即可，不需要 ES module、不需要打包器。
 * js/pdf-engine.js 依赖 pdf.js 与 canvas，Node 里跑不了，只用 node --check 做语法检查。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function load(rel) {
  const file = path.join(ROOT, rel);
  const code = fs.readFileSync(file, "utf8");
  // 经典脚本：IIFE 内部用的是 (typeof window !== "undefined" ? window : globalThis)
  eval(code);
}

load("js/util.js");
load("js/config.js");
load("js/translate.js");

const T = globalThis.PZTranslate;
const C = globalThis.PZConfig;

/* ============================================================
 * 迷你断言 / 输出
 * ============================================================ */

let passed = 0;
const failures = [];
let currentSection = "";

function section(title) {
  currentSection = title;
  console.log("\n" + title);
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    failures.push({ section: currentSection, name: name, message: err && err.message });
    console.log("  ✗ " + name + "\n      → " + ((err && err.message) || err));
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(
      (what ? what + "：" : "") +
        "期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual)
    );
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what || "断言失败");
}

/* ============================================================
 * 假 fetch：把网络这一层换成可控的桩，才能测缓存与失败路径
 * ============================================================ */

function jsonResponse(obj, status) {
  const st = status || 200;
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  return {
    ok: st >= 200 && st < 300,
    status: st,
    headers: { get: function () { return null; } },
    text: async function () { return body; },
  };
}

/** Google translate_a/single 的最小合法响应 */
function googleResponse(text) {
  return jsonResponse([[[text, "src", null, null, 10]], null, "en"]);
}

function tlOf(url) {
  const m = /[?&]tl=([^&]*)/.exec(String(url));
  return m ? decodeURIComponent(m[1]) : "";
}

/* ============================================================
 * 测试
 * ============================================================ */

async function main() {
  console.log("=== PZTranslate 单元测试 ===");
  console.log("PZConfig v" + C.VERSION + " / PZTranslate v" + T.VERSION);

  /* ---------- 1. 长词优先 ---------- */
  section("1. applyGlossary：长词优先（Shoes Laces 不能被切成 鞋子 Laces）");
  const g1 = C.parseGlossary("Shoes => 鞋子\nShoes Laces => 鞋带");
  await check('"Shoes Laces" → 鞋带', function () {
    eq(T.applyGlossary("Shoes Laces", g1), "鞋带");
  });
  await check('"Shoes" 仍能命中 → 鞋子', function () {
    eq(T.applyGlossary("Shoes", g1), "鞋子");
  });
  await check('"shoes laces"（小写）也走长词 → 鞋带', function () {
    eq(T.applyGlossary("shoes laces", g1), "鞋带");
  });
  await check("术语表顺序反着写也要长词优先", function () {
    const g = C.parseGlossary("Shoes Laces => 鞋带\nShoes => 鞋子");
    eq(T.applyGlossary("Shoes Laces", g), "鞋带");
  });

  /* ---------- 2. 正则特殊字符转义 ---------- */
  section("2. applyGlossary：正则特殊字符（斜杠 / 点 / 括号）");
  const g2 = C.parseGlossary(
    ["Silk/Sateen => 丝绸/缎面", "DEV. STAGE => 开发阶段", "(A+B) => 甲乙"].join("\n")
  );
  await check("含 / . ( ) + 的术语表不抛异常且全部命中", function () {
    const out = T.applyGlossary("Please use Silk/Sateen fabric at DEV. STAGE (A+B)", g2);
    ok(out.indexOf("丝绸/缎面") >= 0, "Silk/Sateen 未命中：" + out);
    ok(out.indexOf("开发阶段") >= 0, "DEV. STAGE 未命中：" + out);
    ok(out.indexOf("甲乙") >= 0, "(A+B) 未命中：" + out);
  });
  await check('"DEV. STAGE" 里的点必须是字面量（DEVXSTAGE 不能命中）', function () {
    eq(T.applyGlossary("DEVXSTAGE", g2), "DEVXSTAGE");
  });
  await check('孤立的 "(A+B)" 精确匹配', function () {
    eq(T.applyGlossary("(A+B)", g2), "甲乙");
  });
  await check("术语表里的 $ 不会被当成替换模式", function () {
    const g = C.parseGlossary("Price$ => 价格");
    eq(T.applyGlossary("Price$ 100", g), "价格 100");
  });

  /* ---------- 3. 词边界 ---------- */
  section("3. applyGlossary：词边界（Back 不能命中 Backpack）");
  const g3 = C.parseGlossary("Back => 背面");
  await check('"Backpack" 保持原样', function () {
    eq(T.applyGlossary("Backpack", g3), "Backpack");
  });
  await check('"back" 命中 → 背面', function () {
    eq(T.applyGlossary("back", g3), "背面");
  });
  await check('"Back panel" → 背面 panel', function () {
    eq(T.applyGlossary("Back panel", g3), "背面 panel");
  });
  await check('括号包裹的 "(Back)" 也算独立词', function () {
    eq(T.applyGlossary("(Back)", g3), "(背面)");
  });
  await check("下划线连接的 Back_pack 不命中（与 \\b 行为一致）", function () {
    eq(T.applyGlossary("Back_pack", g3), "Back_pack");
  });

  /* ---------- 4. 大小写不敏感 ---------- */
  section("4. applyGlossary：大小写不敏感");
  const g4 = C.parseGlossary("Embroidery => 刺绣");
  await check('"EMBROIDERY" → 刺绣', function () {
    eq(T.applyGlossary("EMBROIDERY", g4), "刺绣");
  });
  await check('"Embroidery" → 刺绣', function () {
    eq(T.applyGlossary("Embroidery", g4), "刺绣");
  });
  await check('"eMbRoIdErY" → 刺绣', function () {
    eq(T.applyGlossary("eMbRoIdErY", g4), "刺绣");
  });

  /* ---------- 5. 代码保护往返 ---------- */
  section("5. 代码保护：extractCodes → restoreCodes 必须完全等于原文");
  const src5 = 'PMS 1234 C, 4\'5", 160cm, 65%';
  const ex5 = T.extractCodes(src5);
  await check("往返完全一致", function () {
    eq(T.restoreCodes(ex5.masked, ex5.codes), src5);
  });
  await check("至少保护了 3 段（色号 / 尺寸 / 单位 / 百分比）", function () {
    ok(ex5.codes.length >= 3, "实际只保护了 " + ex5.codes.length + " 段：" + JSON.stringify(ex5.codes));
  });
  await check("掩码后不残留任何拉丁字母（说明没有漏保护的片段）", function () {
    ok(!/[A-Za-z]/.test(ex5.masked), "掩码结果里还有字母：" + JSON.stringify(ex5.masked));
  });
  await check("掩码确实改变了文本，且用的是私用区占位符", function () {
    ok(ex5.masked !== src5, "掩码没有生效");
    ok(/\uE000/.test(ex5.masked) && /\uE001/.test(ex5.masked), "占位符不是 PUA 码位");
  });
  await check("引擎在占位符里插空格也能还原", function () {
    eq(T.restoreCodes("\uE000 0 \uE001", ["PMS 1234 C"]), "PMS 1234 C");
  });
  await check("引擎把数字转成全角也能还原", function () {
    eq(T.restoreCodes("\uE000\uFF10\uE001", ["PMS 1234 C"]), "PMS 1234 C");
  });
  await check("编号越界时不产出 undefined，而是留下痕迹让残留检测报", function () {
    const out = T.restoreCodes("\uE0009\uE001", ["PMS 1234 C"]);
    eq(out, "\uE0009\uE001");
    ok(T.codeResidue(out, ["PMS 1234 C"]).indexOf("残留") >= 0, "应当报残留");
  });

  /* ---------- 6. 缓存不串味 ---------- */
  section("6. 缓存：targetLang 不同绝不能命中同一条缓存");
  T.clearCache();
  const seen6 = [];
  T.setFetch(async function (url) {
    seen6.push(String(url));
    const tl = tlOf(url);
    return googleResponse(tl === "zh-TW" ? "繁體譯文" : "简体译文");
  });
  const r6cn = await T.translateMany(["Hello world"], { engine: "free", targetLang: "zh-CN" });
  const r6tw = await T.translateMany(["Hello world"], { engine: "free", targetLang: "zh-TW" });
  await check("zh-CN 得到简体，zh-TW 得到繁体", function () {
    eq(r6cn[0].dst, "简体译文");
    eq(r6tw[0].dst, "繁體譯文");
  });
  await check("换了 targetLang 必须重新发起请求（不能命中旧缓存）", function () {
    eq(seen6.length, 2, "实际请求次数 " + seen6.length);
  });
  await check("同语言 + 同引擎 + 同原文才命中缓存", function () {
    return T.translateMany(["Hello world"], { engine: "free", targetLang: "zh-CN" }).then(function (r6b) {
      eq(seen6.length, 2, "缓存没命中，又发了一次请求");
      eq(r6b[0].dst, "简体译文");
    });
  });
  await check("请求 URL 里 sl=en（不是 auto）", function () {
    ok(seen6[0].indexOf("sl=en") >= 0, "URL 是 " + seen6[0]);
    ok(seen6[0].indexOf("sl=auto") < 0, "URL 里出现了 sl=auto");
  });

  /* ---------- 7. parseGlossary 各种写法 ---------- */
  section("7. PZConfig.parseGlossary：各种分隔符 / 注释 / 空行 / 保持原样");
  const g7 = C.parseGlossary(
    [
      "# 这是注释行",
      "",
      "Alpha => 甲",
      "Beta -> 乙",
      "Gamma → 丙",
      "Delta ＝ 丁",
      "Epsilon",
      "// 也是注释",
      "Zeta => 原样",
      "   ",
    ].join("\n")
  );
  await check("注释与空行被跳过，共解析出 6 条", function () {
    eq(g7.length, 6, JSON.stringify(g7));
  });
  await check("四种分隔符都能解析", function () {
    eq(g7[0].from + "|" + g7[0].to, "Alpha|甲");
    eq(g7[1].from + "|" + g7[1].to, "Beta|乙");
    eq(g7[2].from + "|" + g7[2].to, "Gamma|丙");
    eq(g7[3].from + "|" + g7[3].to, "Delta|丁");
  });
  await check("只有原文的当「保持原样」（keep）", function () {
    eq(g7[4].from, "Epsilon");
    eq(g7[4].keep, true, "Epsilon 应当 keep");
    eq(g7[5].keep, true, "写「原样」的也应当 keep");
    eq(g7[0].keep, false);
  });
  await check("glossaryKeepList 只返回 keep 项，且 applyGlossary 不动它们", function () {
    eq(T.glossaryKeepList(g7).join(","), "Epsilon,Zeta");
    eq(T.applyGlossary("Epsilon and Zeta", g7), "Epsilon and Zeta");
  });
  await check("非 keep 项照常替换", function () {
    eq(T.applyGlossary("Alpha", g7), "甲");
  });

  /* ---------- 8. 占位符残留 / 丢失告警 ---------- */
  section("8. 还原后的残留检测：占位符丢了必须在 warn 里说明");
  T.clearCache();
  T.setFetch(async function () {
    return googleResponse("面料"); // 假装引擎把占位符整个吃掉了
  });
  const r8 = await T.translateMany(["PMS 1234 C fabric"], { engine: "free", targetLang: "zh-CN" });
  await check("译文只保留引擎返回的内容", function () {
    eq(r8[0].dst, "面料");
    eq(r8[0].engine, "google");
  });
  await check("warn 里点名丢掉的型号", function () {
    ok(/丢失/.test(r8[0].warn || ""), "warn 是 " + JSON.stringify(r8[0].warn));
    ok((r8[0].warn || "").indexOf("PMS 1234 C") >= 0, "warn 没点出具体代码：" + r8[0].warn);
  });
  await check("占位符原样漏进译文时报「残留」", function () {
    const r = T.codeResidue("hello \uE0000\uE001 world", ["PMS 1234 C"]);
    ok(r.indexOf("残留") >= 0, r);
  });
  await check("干净的译文没有 warn", function () {
    T.clearCache();
    T.setFetch(async function () {
      return googleResponse("面料 160cm");
    });
    return T.translateMany(["fabric 160cm"], { engine: "free", targetLang: "zh-CN" }).then(function (r) {
      eq(r[0].dst, "面料 160cm");
      eq(r[0].warn, undefined, "不该有 warn，实际 " + JSON.stringify(r[0].warn));
    });
  });

  /* ---------- 9. MyMemory 480 字符显式拆段 ---------- */
  section("9. 免费源：MyMemory 超过 480 字符显式拆段并 warn（不悄悄截断）");
  T.clearCache();
  const myCalls = [];
  T.setFetch(async function (url) {
    const u = String(url);
    if (u.indexOf("googleapis") >= 0) return jsonResponse({ error: "blocked" }, 403);
    const m = /[?&]q=([^&]*)/.exec(u);
    const q = m ? decodeURIComponent(m[1]) : "";
    myCalls.push(q.length);
    return jsonResponse({ responseData: { translatedText: "段(" + q.length + ")" } });
  });
  const longText = "The quick brown fox jumps over the lazy dog. ".repeat(20); // 900 字符
  const r9 = await T.translateMany([longText], { engine: "free", targetLang: "zh-CN" });
  await check("Google 失败后回退到 MyMemory", function () {
    eq(r9[0].engine, "mymemory");
  });
  await check("每一段都不超过 480 字符", function () {
    ok(myCalls.length >= 2, "只发了 " + myCalls.length + " 次请求，说明被截断了");
    for (let i = 0; i < myCalls.length; i++) {
      ok(myCalls[i] <= 480, "第 " + (i + 1) + " 段有 " + myCalls[i] + " 字符，超过 480");
    }
  });
  await check("warn 里说明拆了几段", function () {
    ok(/480/.test(r9[0].warn || ""), "warn 是 " + JSON.stringify(r9[0].warn));
  });
  await check("两段内容都拼进了译文（没有丢段）", function () {
    ok(r9[0].dst.indexOf("段(") >= 0, r9[0].dst);
    eq((r9[0].dst.match(/段\(/g) || []).length, myCalls.length);
  });

  /* ---------- 10. 去重 / engine 标注 / 等长返回 ---------- */
  section("10. translateMany：去重、engine 标注、返回与输入等长");
  T.clearCache();
  let calls10 = 0;
  T.setFetch(async function () {
    calls10++;
    return googleResponse("你好");
  });
  const input10 = ["Hello", "Hello", "Hello", "", "中文已存在"];
  const r10 = await T.translateMany(input10, { engine: "free", targetLang: "zh-CN" });
  await check("同一文本只请求一次", function () {
    eq(calls10, 1, "实际请求 " + calls10 + " 次");
  });
  await check("返回条目与输入一一对应", function () {
    eq(r10.length, input10.length);
    eq(r10[0].src, "Hello");
    eq(r10[2].dst, "你好");
  });
  await check("空行与空白标成 skip，且不回原文冒充译文", function () {
    eq(r10[3].engine, "skip");
    eq(r10[3].dst, "");
  });
  await check("本来就是中文的行标成 skip 并原样保留", function () {
    eq(r10[4].engine, "skip");
    eq(r10[4].dst, "中文已存在");
  });
  await check("engine 字段标明真实来源", function () {
    eq(r10[0].engine, "google");
  });

  /* ---------- 11. 术语表命中不联网 ---------- */
  section("11. 术语表：整条被术语表覆盖时不联网，engine 标 glossary");
  T.clearCache();
  let calls11 = 0;
  T.setFetch(async function () {
    calls11++;
    return googleResponse("不该被调用");
  });
  const g11 = C.parseGlossary("EMBROIDERY => 刺绣");
  const r11 = await T.translateMany(["EMBROIDERY"], { engine: "free", targetLang: "zh-CN", glossaryEntries: g11 });
  await check("没有发起网络请求", function () {
    eq(calls11, 0);
  });
  await check("engine = glossary，译文来自术语表", function () {
    eq(r11[0].engine, "glossary");
    eq(r11[0].dst, "刺绣");
  });

  /* ---------- 12. 失败必须大声抛错 ---------- */
  section("12. 失败大声抛错：不静默降级、不把原文当译文");
  T.clearCache();
  T.setFetch(async function () {
    return jsonResponse({ error: { message: "invalid api key" } }, 401);
  });
  let thrown = null;
  try {
    await T.translateMany(["Hello world"], {
      engine: "llm",
      targetLang: "zh-CN",
      llm: { api: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" },
    });
  } catch (err) {
    thrown = err;
  }
  await check("抛出了错误", function () {
    ok(thrown, "没有抛错，说明失败被静默吞掉了");
  });
  await check("错误信息里带上了接口返回的原因", function () {
    ok(/invalid api key/.test(thrown.message || ""), "错误信息是 " + thrown.message);
  });
  await check("错误上带着 partial（已翻出来的部分不丢）", function () {
    ok(Array.isArray(thrown.partial), "partial 不是数组");
    eq(thrown.partial.length, 1);
    eq(thrown.partial[0].engine, "failed");
  });

  T.setFetch(async function () {
    return jsonResponse({ error: "boom" }, 500);
  });
  let thrownFree = null;
  try {
    await T.translateMany(["Hello"], { engine: "free", targetLang: "zh-CN" });
  } catch (err) {
    thrownFree = err;
  }
  await check("免费源全挂时也抛错（且说清两个源都失败了）", function () {
    ok(thrownFree, "没有抛错");
    ok(/免费翻译接口全部失败/.test(thrownFree.message), thrownFree.message);
    ok(/Google/.test(thrownFree.message) && /MyMemory/.test(thrownFree.message), thrownFree.message);
  });

  /* ---------- 13. 大模型批量（JSON 数组进出） ---------- */
  section("13. 大模型批量：24 条一批、JSON 数组进出、解析失败降级逐条");
  T.clearCache();
  const llmCalls = [];
  T.setFetch(async function (url, init) {
    const body = JSON.parse(init.body);
    llmCalls.push(body);
    const userMsg = body.messages[1].content;
    // buildTranslateBatchUser 把条目以 JSON 数组形式放在末尾
    const arr = JSON.parse(userMsg.slice(userMsg.indexOf("[")));
    if (llmCalls.length === 1) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(
        arr.map(function (t, i) { return { id: i, translation: "译:" + t }; })
      ) } }] });
    }
    return jsonResponse({ choices: [{ message: { content: "不该走到这里" } }] });
  });
  const texts13 = ["alpha", "beta", "gamma"];
  const r13 = await T.translateMany(texts13, {
    engine: "llm",
    targetLang: "zh-CN",
    llm: { api: "openai", baseUrl: "https://api.deepseek.com", apiKey: "k", model: "deepseek-chat" },
  });
  await check("三个条目一次请求搞定", function () {
    eq(llmCalls.length, 1, "实际请求 " + llmCalls.length + " 次");
  });
  await check("按 id 映射回了各自的译文", function () {
    eq(r13[0].dst, "译:alpha");
    eq(r13[1].dst, "译:beta");
    eq(r13[2].dst, "译:gamma");
    eq(r13[0].engine, "llm");
  });
  await check("system 提示词来自 PZConfig（含目标语言与术语表）", function () {
    const sys = llmCalls[0].messages[0].content;
    ok(/简体中文/.test(sys), "system 里没有目标语言：" + sys);
  });
  await check("端点按 deepseek 规则拼成了 /chat/completions", function () {
    eq(r13[0].engine, "llm");
  });

  T.clearCache();
  const llm2 = [];
  T.setFetch(async function (url, init) {
    llm2.push(url);
    const body = JSON.parse(init.body);
    const userMsg = body.messages[1].content;
    const isBatch = userMsg.indexOf("[") >= 0 && userMsg.indexOf("JSON 数组") >= 0;
    if (isBatch) {
      // 故意返回不是 JSON 的东西 → 触发降级逐条
      return jsonResponse({ choices: [{ message: { content: "抱歉，我不能完成这个请求。" } }] });
    }
    return jsonResponse({ choices: [{ message: { content: "单条译文" } }] });
  });
  const r13b = await T.translateMany(["one", "two"], {
    engine: "llm",
    targetLang: "zh-CN",
    llm: { api: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini" },
  });
  await check("批量解析失败 → 降级成 1 + 2 次调用", function () {
    eq(llm2.length, 3, "实际请求 " + llm2.length + " 次");
  });
  await check("降级后每条都拿到了译文", function () {
    eq(r13b[0].dst, "单条译文");
    eq(r13b[1].dst, "单条译文");
  });
  await check("第一个请求打到了 /v1/chat/completions", function () {
    eq(llm2[0], "https://api.openai.com/v1/chat/completions");
  });

  /* ---------- 14. baseUrl 拼接规则 ---------- */
  section("14. baseUrl → 端点拼接规则");
  await check("https://api.openai.com/v1", function () {
    eq(T.chatEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  });
  await check("https://api.deepseek.com", function () {
    eq(T.chatEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
  });
  await check("https://api.deepseek.com/", function () {
    eq(T.chatEndpoint("https://api.deepseek.com/"), "https://api.deepseek.com/chat/completions");
  });
  await check("https://dashscope.aliyuncs.com/compatible-mode/v1", function () {
    eq(
      T.chatEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
  });
  await check("已经写全 .../chat/completions 的不重复拼", function () {
    eq(
      T.chatEndpoint("https://api.openai.com/v1/chat/completions"),
      "https://api.openai.com/v1/chat/completions"
    );
  });
  await check("末尾带斜杠的整条路径也认", function () {
    eq(
      T.chatEndpoint("https://api.openai.com/v1/chat/completions/"),
      "https://api.openai.com/v1/chat/completions"
    );
  });
  await check("非 v1 的版本段（智谱 /api/paas/v4）只补 /chat/completions", function () {
    eq(
      T.chatEndpoint("https://open.bigmodel.cn/api/paas/v4"),
      "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    );
  });
  await check("裸域名补 /v1/chat/completions", function () {
    eq(T.chatEndpoint("https://my-gateway.example.com"), "https://my-gateway.example.com/v1/chat/completions");
  });
  await check("models 端点规则一致", function () {
    eq(T.modelsEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/models");
    eq(T.modelsEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
    eq(T.modelsEndpoint("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1/models");
    eq(T.modelsEndpoint("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/models");
  });
  await check("空 baseUrl 抛中文错误", function () {
    let e = null;
    try {
      T.chatEndpoint("");
    } catch (err) {
      e = err;
    }
    ok(e && /Base URL/.test(e.message), "错误信息是 " + (e && e.message));
  });

  /* ---------- 15. 中止 ---------- */
  section("15. opts.signal 中止");
  T.clearCache();
  T.setFetch(async function (url, init) {
    if (init && init.signal && init.signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return googleResponse("你好");
  });
  const ctrl = new AbortController();
  ctrl.abort();
  let abortErr = null;
  try {
    await T.translateMany(["Hello"], { engine: "free", targetLang: "zh-CN", signal: ctrl.signal });
  } catch (err) {
    abortErr = err;
  }
  await check("已中止的信号会让 translateMany 抛 AbortError", function () {
    ok(abortErr, "没有抛错");
    ok(globalThis.PZUtil.isAbortError(abortErr), "抛出的不是 AbortError：" + abortErr.name);
  });

  /* ---------- 16. testLlm / listLlmModels ---------- */
  section("16. testLlm / listLlmModels（含 app.js 用的平铺参数写法）");
  T.setFetch(async function (url) {
    if (String(url).indexOf("/models") >= 0) {
      return jsonResponse({ data: [{ id: "m-b" }, { id: "m-a" }] });
    }
    return jsonResponse({ choices: [{ message: { content: "pong" } }] });
  });
  await check("listLlmModels 平铺写法可用，且不需要填 model", async function () {
    const ids = await T.listLlmModels({ api: "openai", baseUrl: "https://api.deepseek.com", apiKey: "k" });
    eq(ids.join(","), "m-a,m-b");
  });
  await check("testLlm 平铺写法可用", async function () {
    const r = await T.testLlm({
      api: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "k",
      model: "deepseek-chat",
    });
    eq(r.ok, true);
    eq(r.model, "deepseek-chat");
    eq(r.endpoint, "https://api.deepseek.com/chat/completions");
  });
  await check("testLlm 契约里的嵌套 llm 写法也可用", async function () {
    const r = await T.testLlm({
      llm: { api: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini" },
    });
    eq(r.endpoint, "https://api.openai.com/v1/chat/completions");
    eq(r.model, "gpt-4o-mini");
  });
  await check("没填 Key 时给中文错误", async function () {
    let e = null;
    try {
      await T.listLlmModels({ baseUrl: "https://api.openai.com/v1" });
    } catch (err) {
      e = err;
    }
    ok(e && /API Key/.test(e.message), "错误信息是 " + (e && e.message));
  });
  await check("模型列表返回非 OpenAI 格式时报错", async function () {
    T.setFetch(async function () {
      return jsonResponse({ nope: true });
    });
    let e = null;
    try {
      await T.listLlmModels({ baseUrl: "https://api.openai.com/v1", apiKey: "k" });
    } catch (err) {
      e = err;
    }
    ok(e && /格式/.test(e.message), "错误信息是 " + (e && e.message));
  });

  /* ---------- 17. hooks.onProgress 签名兼容 ---------- */
  section("17. hooks.onProgress 两种签名都能用");
  T.clearCache();
  T.setFetch(async function () {
    return googleResponse("你好");
  });
  const oldStyle = [];
  const newStyle = [];
  await check("老写法 onProgress(done, total) 拿到数字", async function () {
    await T.translateMany(["Hello A"], { engine: "free", targetLang: "zh-CN" }, {
      onProgress: function (done, total) {
        oldStyle.push([done, total]);
      },
    });
    ok(oldStyle.length > 0, "回调没有被调用");
    const last = oldStyle[oldStyle.length - 1];
    eq(typeof last[0], "number");
    eq(last[0], 1);
    eq(last[1], 1);
  });
  await check("契约写法 onProgress({phase,done,total}) 拿到对象", async function () {
    T.clearCache();
    await T.translateMany(["Hello B"], { engine: "free", targetLang: "zh-CN" }, {
      onProgress: function (p) {
        newStyle.push(p);
      },
    });
    const last = newStyle[newStyle.length - 1];
    ok(last && last.phase === "translate", "回调参数是 " + JSON.stringify(last));
    eq(last.done, 1);
    eq(last.total, 1);
  });

  /* ---------- 汇总 ---------- */
  console.log("\n=== 汇总 ===");
  console.log("通过 " + passed + " 项，失败 " + failures.length + " 项");
  if (failures.length) {
    console.log("");
    for (let i = 0; i < failures.length; i++) {
      console.log("  ✗ " + failures[i].section + " / " + failures[i].name);
      console.log("      " + failures[i].message);
    }
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✓");
  }
}

main().catch(function (err) {
  console.error("\n测试脚本自身出错：");
  console.error(err);
  process.exitCode = 1;
});
