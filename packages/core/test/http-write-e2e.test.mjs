// HTTP 写线端到端：起一个假禅道，真跑「读快照 → 取表单拿 uid → 提 POST → 解回包 → 再读快照」。
//
// 这条链路有两个曾经真踩过的坑，都被下面的用例锁住：
//  1. 禅道表单校验失败回的是 {"result":"fail","message":{"字段":["人话"]}}——早期把它当成功了；
//  2. 写表单必须带 uid（虽然禅道不校验，但缺了老皮肤会 500），而 recordworkhour 那页根本没有 uid。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createHttpChannel } from "../lib/channels/http/index.js";

const ACCOUNT = "tester";
const PASSWORD = "pw-123456";
const md5 = (value) => createHash("md5").update(value, "utf8").digest("hex");

/** 一个最小的任务详情页：字段表放在 .datalist-item 里，正是 parseFields 吃的形状。 */
function taskViewHtml(task) {
  const field = (label, value) =>
    `<div class="datalist-item"><span class="datalist-item-label">${label}：</span><div class="datalist-item-content">${value}</div></div>`;
  return `<div class="datalist">
${field("状态", task.status)}
${field("当前指派", task.assignedTo)}
${field("已消耗", task.consumed)}
${field("剩余", task.left)}
${field("由谁创建", task.openedBy)}
</div>
<div class="detail"><div class="detail-title">描述</div><div class="detail-content">正文</div></div>`;
}

function startFakeZentao(initial) {
  const state = {
    logins: 0,
    sid: "",
    rand: "",
    task: { ...initial },
    /** 收到过的 finish 表单提交体，供断言。 */
    finishBodies: [],
    /** 让 POST 故意走「校验失败」分支。 */
    rejectNextFinish: false,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const query = url.searchParams;
    const cookie = request.headers.cookie ?? "";
    const json = (payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (query.get("m") === "user" && query.get("f") === "refreshRandom") {
      state.sid = `sess-${Date.now().toString(36)}`;
      state.rand = `rand-${Math.random().toString(36).slice(2, 10)}`;
      response.writeHead(200, { "content-type": "text/plain", "set-cookie": [`zentaosid=${state.sid}; path=/`] });
      response.end(state.rand);
      return;
    }

    if (query.get("m") === "user" && query.get("f") === "login") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      state.logins += 1;
      if (!cookie.includes(`zentaosid=${state.sid}`) || !body.includes(md5(md5(PASSWORD) + state.rand))) {
        json({ status: "failed", reason: "登录失败，请检查您的用户名或密码是否填写正确。" });
        return;
      }
      json({ status: "success", locate: "/index.php?m=my&f=index" });
      return;
    }

    if (!cookie.includes(`zentaosid=${state.sid}`)) {
      response.writeHead(302, { location: "/index.php?m=user&f=login" });
      response.end();
      return;
    }

    if (query.get("m") === "my" && query.get("f") === "index") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<div id='mainContent'>我的地盘</div>");
      return;
    }

    // 任务详情（读快照走这里）。zin=1 与整页两种都支持，插件会先试 zin。
    if (query.get("m") === "task" && query.get("f") === "view") {
      const main = taskViewHtml(state.task);
      if (query.get("zin") === "1") {
        json([
          { name: "title", data: `<span>任务 #1 假任务</span>` },
          { name: "main", data: main },
        ]);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><body>${main}</body></html>`);
      return;
    }

    // 完成表单页：真实禅道这里只有一个 uid 是显式字段，其余靠 JS 提交。
    if (query.get("m") === "task" && query.get("f") === "finish" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><body><form action="/index.php?m=task&f=finish&taskID=1" method="post">
<input type="hidden" name="uid" value="uid-abc123" />
<input type="text" name="currentConsumed" value="0" />
</form></body></html>`,
      );
      return;
    }

    if (query.get("m") === "task" && query.get("f") === "finish" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      state.finishBodies.push(body);

      if (state.rejectNextFinish) {
        state.rejectNextFinish = false;
        json({ result: "fail", message: { finishedDate: ["实际完成不能小于实际开始"] } });
        return;
      }

      // 成功：按禅道 finish() 的语义改状态——完成、剩余归零、指派回创建人。
      state.task.status = "已完成";
      state.task.consumed = String(Number(state.task.consumed) + Number(new URLSearchParams(body).get("currentConsumed") ?? 0));
      state.task.left = "0";
      state.task.assignedTo = state.task.openedBy;
      json({ result: "success", message: "保存成功" });
      return;
    }

    response.writeHead(500);
    response.end("unexpected");
  });

  return { server, state };
}

async function withServer(initial, run) {
  const { server, state } = startFakeZentao(initial);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const channel = createHttpChannel({
    baseUrl: `http://127.0.0.1:${port}`,
    account: ACCOUNT,
    password: PASSWORD,
    timeoutMs: 5000,
  });
  try {
    return await run(channel, state);
  } finally {
    await channel.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
}

const INITIAL = { status: "进行中", assignedTo: "zhangsan", consumed: "5", left: "3", openedBy: "lisi" };

test("HTTP 写线：finish 走完「读快照 → 取 uid → 提交 → 再读快照」", async () => {
  await withServer(INITIAL, async (channel, state) => {
    const outcome = await channel.write({
      kind: "task",
      id: 1,
      action: "finish",
      consumed: 2,
      realStarted: "2026-10-30 09:00:00",
      finishedDate: "2026-11-01 10:00:00",
      comment: "做完了",
    });

    // 写前快照来自真实页面解析
    assert.equal(outcome.channel, "http");
    assert.equal(outcome.actionName, "finished");
    assert.equal(outcome.before.status, "进行中");
    assert.equal(outcome.before.consumed, 5);
    assert.equal(outcome.before.left, 3);

    // 写后快照是回读的，不是我们猜的
    assert.equal(outcome.after.status, "已完成");
    assert.equal(outcome.after.left, 0);
    assert.equal(outcome.after.consumed, 7, "consumed 应该是「旧 + 本次」");
    assert.equal(outcome.after.assignedTo, "lisi", "完成后指派回创建人");
    assert.deepEqual(outcome.warnings, [], "状态变了就不该有警告");

    // 提交体：uid 来自表单页；currentConsumed 是本次、consumed 是新总量
    assert.equal(state.finishBodies.length, 1);
    const body = new URLSearchParams(state.finishBodies[0]);
    assert.equal(body.get("uid"), "uid-abc123");
    assert.equal(body.get("currentConsumed"), "2");
    assert.equal(body.get("consumed"), "7");
    assert.equal(body.get("realStarted"), "2026-10-30 09:00:00");
    assert.equal(body.get("finishedDate"), "2026-11-01 10:00:00");
    assert.equal(body.get("status"), "done");
    assert.equal(body.get("left"), "0");
    assert.equal(body.get("comment"), "做完了");
  });
});

test("HTTP 写线：禅道校验失败要变成 write-rejected，并把字段名和人话都带出来", async () => {
  await withServer(INITIAL, async (channel, state) => {
    state.rejectNextFinish = true;
    await assert.rejects(
      () =>
        channel.write({
          kind: "task",
          id: 1,
          action: "finish",
          consumed: 1,
          realStarted: "2026-11-01 10:00:00",
          finishedDate: "2026-11-01 09:00:00",
        }),
      (error) => {
        assert.equal(error.code, "write-rejected");
        assert.match(error.message, /finishedDate/);
        assert.match(error.message, /实际完成不能小于实际开始/);
        return true;
      },
    );
    // 失败不能把数据改坏
    assert.equal(state.task.status, "进行中");
    assert.equal(state.task.consumed, "5");
  });
});

test("HTTP 写线：本次工时填 0 要明确警告（禅道不会生成工时记录）", async () => {
  await withServer(INITIAL, async (channel) => {
    const outcome = await channel.write({
      kind: "task",
      id: 1,
      action: "finish",
      consumed: 0,
      realStarted: "2026-10-30 09:00:00",
      finishedDate: "2026-11-01 10:00:00",
    });
    assert.equal(outcome.after.status, "已完成");
    assert.ok(
      outcome.warnings.some((item) => item.includes("不会为这次完成生成工时记录")),
      `应该警告工时为 0，实际：${JSON.stringify(outcome.warnings)}`,
    );
  });
});

test("HTTP 写线：空备注在发请求前就被我方拦下，不浪费一次 POST", async () => {
  await withServer(INITIAL, async (channel) => {
    await assert.rejects(
      () => channel.write({ kind: "task", id: 1, action: "comment", comment: "   " }),
      (error) => {
        assert.equal(error.code, "write-rejected");
        assert.match(error.message, /不能为空/);
        return true;
      },
    );
  });
});
