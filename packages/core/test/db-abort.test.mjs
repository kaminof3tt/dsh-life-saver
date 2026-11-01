// 慢查询 / 连不上库时，工具调用必须能被“停止”打断，而不是把会话挂死。
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../lib/channels/db/pool.js";

const blackhole = {
  host: "10.255.255.1", // 不可路由地址：连接会一直挂在 TCP 握手
  port: 3306,
  user: "nobody",
  database: "zentao",
  prefix: "zt_",
  connectionLimit: 1,
};

test("已经取消的信号：立刻拒绝，不发起查询", async () => {
  const handle = await openDb({ db: blackhole, password: "x", connectTimeoutMs: 2000 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => handle.one("SELECT 1", [], ac.signal), (error) => error.code === "aborted");
  await handle.close().catch(() => undefined);
});

test("运行中取消：几百毫秒内返回，不等连接超时", async () => {
  const handle = await openDb({ db: blackhole, password: "x", connectTimeoutMs: 5000 });
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 150);
  try {
    await handle.one("SELECT 1", [], ac.signal);
  } catch (error) {
    // 两种结果都算正常：abort 生效（code=aborted），或者连接被立刻拒绝
    // （取决于本机路由，此时 abort 还没来得及生效）。
    assert.ok(
      error.code === "aborted" || (typeof error.message === "string" && error.message.length > 0),
      `意外错误：${String(error && error.code)}`,
    );
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `取消耗时 ${elapsed}ms，说明没走 abort 路径`);
  // 收尾：abandon 掉的连接失败不能把进程带走（有监听器 + catch 兜底）
  await handle.close().catch(() => undefined);
});

test("连接池后台错误不会变成未捕获异常", async () => {
  // 没有监听器时 pool 的 'error' 事件会直接崩进程，这里模拟一次后台失败。
  const handle = await openDb({ db: blackhole, password: "x", connectTimeoutMs: 300 });
  const problems = [];
  const onUnhandled = (error) => problems.push(error);
  process.once("unhandledRejection", onUnhandled);
  await handle.one("SELECT 1").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.removeListener("unhandledRejection", onUnhandled);
  await handle.close().catch(() => undefined);
  assert.deepEqual(problems, []);
});
