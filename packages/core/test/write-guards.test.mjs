// 写操作的「前置护栏」——这些判定发生在连库之前，所以用死连接也能测：
// 关掉总开关必须直接拒绝、动作白名单必须挡住跨 kind 的动作、id 必须合法。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, unwrapConfig } from "../lib/config.js";
import { LifeSaverService } from "../lib/service.js";
import { TASK_ACTIONS, BUG_ACTIONS, RESOLUTIONS } from "../lib/channels/write.js";
import { supportsWrite } from "../lib/channels/types.js";

const base = unwrapConfig(new Config({}));

/** 全部指向 127.0.0.1:1（立刻 ECONNREFUSED），保证任何「真去连」的路径都失败得很快。 */
function serviceWith(write = {}) {
  const config = {
    ...base,
    mode: "db",
    http: { ...base.http, baseUrl: "http://127.0.0.1:1", account: "tester" },
    db: { ...base.db, host: "127.0.0.1", port: 1, user: "root" },
    write: { ...base.write, ...write },
  };
  return new LifeSaverService({ config: () => config, secrets: async () => ({ dbPassword: "x" }) });
}

test("supportsWrite：任务与 BUG 的动作集合互不串味", () => {
  for (const action of TASK_ACTIONS) assert.equal(supportsWrite("task", action), true, action);
  for (const action of BUG_ACTIONS) assert.equal(supportsWrite("bug", action), true, action);
  assert.equal(supportsWrite("task", "resolve"), false);
  assert.equal(supportsWrite("bug", "finish"), false, "finish 是任务的动作，BUG 上不认");
  assert.equal(supportsWrite("task", "nonsense"), false);
});

test("动作集合与禅道真实枚举对齐（别凭印象加动作）", () => {
  assert.deepEqual([...TASK_ACTIONS].sort(), [
    "activate",
    "cancel",
    "close",
    "comment",
    "finish",
    "pause",
    "recordworkhour",
    "start",
  ]);
  assert.deepEqual([...BUG_ACTIONS].sort(), ["close", "comment", "confirm", "recordworkhour", "resolve"]);
  // resolution 是库里的真实枚举（zt_bug.resolution），多一个少一个都会写脏数据
  assert.deepEqual([...RESOLUTIONS], [
    "fixed",
    "external",
    "willnotfix",
    "notrepro",
    "bydesign",
    "duplicate",
    "tostory",
    "postponed",
    "productized",
  ]);
});

test("write.enabled=false 时直接拒绝，连库都不连", async () => {
  const service = serviceWith({ enabled: false });
  await assert.rejects(
    () => service.write({ kind: "task", id: 1, action: "finish" }),
    (error) => {
      assert.equal(error.code, "write-disabled");
      assert.match(error.message, /只能读|只读/);
      assert.ok(error.hint, "要告诉用户去哪打开");
      return true;
    },
  );
  await service.dispose();
});

test("动作不合法要在连库之前报 bad-args", async () => {
  const service = serviceWith();
  await assert.rejects(
    () => service.write({ kind: "task", id: 1, action: "resolve" }),
    (error) => error.code === "bad-args",
  );
  await assert.rejects(
    () => service.write({ kind: "story", id: 1, action: "comment" }),
    (error) => error.code === "bad-args",
  );
  await assert.rejects(
    () => service.write({ kind: "task", id: 0, action: "comment", comment: "x" }),
    (error) => error.code === "bad-args",
  );
  await service.dispose();
});

test("真去连的时候，连不上要说清是 db 通道的原因", async () => {
  const service = serviceWith({ mode: "db" });
  await assert.rejects(
    () => service.write({ kind: "task", id: 1, action: "comment", comment: "x" }),
    (error) => {
      // 先读后写：第一道就是读取失败，错误里要能看出是读不到
      assert.ok(error.code);
      assert.match(String(error.message), /db|连接|ECONNREFUSED|读取/);
      return true;
    },
  );
  await service.dispose();
});
