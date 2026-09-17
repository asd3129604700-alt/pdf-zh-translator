/**
 * 中止机制测试：PZUtil.pool / sleep / throwIfAborted / abortError
 *
 * 为什么要单独一个文件：这些断言都是异步的，而其它测试文件是同步的
 * （用 top-level 顺序执行 + 末尾汇总）。混在一起会让汇总时机变得难以推理。
 *
 * 中止能力是原实现完全缺失的一环 —— 一张图跑几分钟，用户既不能停也不能取消，
 * 只能刷新页面。整条流水线（检测、OCR、视觉请求、翻译、排版）都靠这套机制串联。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function load(rel) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}
load("js/util.js");

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

function delay(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

(async function main() {
  const U = globalThis.PZUtil;
  console.log("\n[1] 中止原语");

  {
    const ac = new AbortController();

    // 未中止：不该抛
    let threw = null;
    try {
      U.throwIfAborted(ac.signal);
    } catch (e) {
      threw = e;
    }
    ok("未中止时 throwIfAborted 不抛异常", threw === null, threw ? String(threw) : "");

    // 已中止：必须抛 AbortError
    ac.abort();
    threw = null;
    try {
      U.throwIfAborted(ac.signal);
    } catch (e) {
      threw = e;
    }
    ok("已中止时 throwIfAborted 抛异常", threw !== null);
    ok("抛出的错误被识别为 AbortError", U.isAbortError(threw), threw && threw.name);

    // abortError 本身
    const e = U.abortError("测试取消");
    ok("abortError() 造出来的是 AbortError", U.isAbortError(e) && e.name === "AbortError");
    ok("abortError() 保留自定义消息", String(e.message).indexOf("测试取消") >= 0, e.message);
    ok("isAbortError 对普通错误返回 false", !U.isAbortError(new Error("boom")));
  }

  console.log("\n[2] sleep 可被中止");

  {
    const ac = new AbortController();
    const timer = setTimeout(function () {
      ac.abort();
    }, 30);
    const t0 = Date.now();
    let caught = null;
    try {
      await U.sleep(5000, ac.signal);
    } catch (err) {
      caught = err;
    }
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    ok("sleep 在中止时立刻 reject", U.isAbortError(caught), caught && caught.name);
    ok("没有傻等满 5 秒", elapsed < 500, "实际 " + elapsed + "ms");

    // 不中止时正常 resolve
    let okResolve = true;
    try {
      await U.sleep(10);
    } catch (err) {
      okResolve = false;
    }
    ok("不中止时 sleep 正常结束", okResolve);

    // 已经中止的信号：不该再等
    const ac2 = new AbortController();
    ac2.abort();
    const t1 = Date.now();
    let caught2 = null;
    try {
      await U.sleep(5000, ac2.signal);
    } catch (err) {
      caught2 = err;
    }
    ok("已中止的信号让 sleep 立即失败", U.isAbortError(caught2) && Date.now() - t1 < 100, "耗时 " + (Date.now() - t1) + "ms");
  }

  console.log("\n[3] pool：并发上限与顺序");

  {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const results = await U.pool(
      items,
      async function (n) {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await delay(5);
        inFlight--;
        return n * 2;
      },
      { concurrency: 3 }
    );

    ok("并发数没有超过上限", maxInFlight <= 3, "峰值 " + maxInFlight);
    ok("并发确实生效了（不是串行）", maxInFlight >= 2, "峰值 " + maxInFlight);
    ok("结果按输入顺序返回", results.length === 10 && results.every(function (v, i) { return v === (i + 1) * 2; }), JSON.stringify(results));
    ok("每个任务都执行了", results.every(function (v) { return v != null; }));
  }

  console.log("\n[4] pool：进度回调");

  {
    const seen = [];
    await U.pool(
      [1, 2, 3, 4],
      async function (n) {
        await delay(2);
        return n;
      },
      {
        concurrency: 2,
        onProgress: function (done, total) {
          seen.push(done + "/" + total);
        },
      }
    );
    ok("onProgress 被调用", seen.length === 4, "调用 " + seen.length + " 次：" + seen.join(","));
    ok("最后一次进度是满的", seen[seen.length - 1] === "4/4", seen[seen.length - 1]);
  }

  console.log("\n[5] pool：错误隔离");

  {
    // 默认行为：单个任务抛错 → 该位置为 null，其余继续
    const results = await U.pool(
      [1, 2, 3],
      async function (n) {
        if (n === 2) throw new Error("第 2 个失败");
        return n;
      },
      { concurrency: 1 }
    );
    ok("单个任务失败不影响其它任务", results[0] === 1 && results[2] === 3, JSON.stringify(results));
    ok("失败位置为 null", results[1] === null, String(results[1]));

    // onError 能拿到错误
    let captured = null;
    await U.pool(
      [1],
      async function () {
        throw new Error("要被捕获");
      },
      {
        concurrency: 1,
        onError: function (err) {
          captured = err;
        },
      }
    );
    ok("onError 收到了错误", !!captured && captured.message === "要被捕获", captured && captured.message);

    // failFast：整体失败
    let fastErr = null;
    try {
      await U.pool(
        [1, 2],
        async function (n) {
          if (n === 2) throw new Error("快速失败");
          return n;
        },
        { concurrency: 1, failFast: true }
      );
    } catch (err) {
      fastErr = err;
    }
    ok("failFast 时整体抛错", !!fastErr && fastErr.message === "快速失败", fastErr && fastErr.message);
  }

  console.log("\n[6] pool：中途中止必须真的停下来");

  {
    const ac = new AbortController();
    let started = 0;
    const t0 = Date.now();
    let caught = null;

    const runner = U.pool(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      async function (n) {
        started++;
        await delay(20);
        return n;
      },
      { concurrency: 2, signal: ac.signal }
    );

    setTimeout(function () {
      ac.abort();
    }, 45);

    try {
      await runner;
    } catch (err) {
      caught = err;
    }

    ok("中止后 pool 抛出 AbortError（而不是安静地返回不完整结果）", U.isAbortError(caught), caught && caught.name);
    ok("中止后没有把 12 个任务全跑完", started < 12, "跑了 " + started + " / 12 个");
    ok("中止是及时的", Date.now() - t0 < 1500, "耗时 " + (Date.now() - t0) + "ms");

    // 已经中止的信号：进去就该抛
    const ac2 = new AbortController();
    ac2.abort();
    let caught2 = null;
    try {
      await U.pool([1, 2, 3], async function () { return 1; }, { concurrency: 2, signal: ac2.signal });
    } catch (err) {
      caught2 = err;
    }
    ok("传入已中止的信号时 pool 立即失败", U.isAbortError(caught2));
  }

  console.log("\n" + "=".repeat(60));
  console.log("中止机制测试：通过 " + pass + " / 失败 " + fail);
  if (failures.length) {
    console.log("\n失败项：");
    failures.forEach(function (f) {
      console.log("  · " + f);
    });
    process.exitCode = 1;
  }
})().catch(function (err) {
  console.error("测试本身抛异常：" + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
