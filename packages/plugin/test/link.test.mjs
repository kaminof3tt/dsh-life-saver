/**
 * 「用户贴过来的东西」要能认出来。
 *
 * 真实用法里很少有人打「bug 5967」，更常见的是整条链接甩过来。这里把
 * 地址栏里出现过的几种形状都钉一遍，顺便锁住「认不出就别瞎猜」——
 * 猜错编号比报错更糟：会把别人的需求当成你的读出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadTool } from "../lib/tools/read.js";
import { parseZentaoRef } from "life-saver-core/domain/link.js";
import { join } from "node:path";

test("纯编号", () => {
  assert.deepEqual(parseZentaoRef("5967"), { id: 5967 });
  assert.deepEqual(parseZentaoRef(5967), { id: 5967 });
  assert.deepEqual(parseZentaoRef(" 1875 "), { id: 1875 });
});

test("查询串式链接：?m=bug&f=view&bugID=5967", () => {
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/index.php?m=bug&f=view&bugID=5967"), {
    kind: "bug",
    id: 5967,
  });
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/index.php?m=task&f=view&taskID=1875"), {
    kind: "task",
    id: 1875,
  });
  assert.deepEqual(
    parseZentaoRef("http://zentao.example.com/index.php?m=story&f=view&storyID=1313#app=qa"),
    { kind: "story", id: 1313 },
  );
});

test("路径式链接：/zentao/bug-view-5967.html", () => {
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/zentao/bug-view-5967.html"), { kind: "bug", id: 5967 });
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/zentao/task-view-1875.html"), { kind: "task", id: 1875 });
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/story-view-1313.json"), { kind: "story", id: 1313 });
});

test("biz 版通用 id=：?m=story&f=view&id=1389", () => {
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/index.php?m=story&f=view&id=1389"), {
    kind: "story",
    id: 1389,
  });
  // 没带 m= 时也能认出编号，类型交给调用方
  assert.deepEqual(parseZentaoRef("index.php?f=view&id=5968"), { id: 5968 });
  // 其它 xxxID= 参数不能被当成 id=
  assert.deepEqual(parseZentaoRef("http://h/index.php?m=bug&productID=12&f=view"), { kind: "bug" });
});

test("只带类型参数、或只有 hash 时也不乱猜编号", () => {
  assert.deepEqual(parseZentaoRef("#bug=5967"), { kind: "bug", id: 5967 });
  assert.deepEqual(parseZentaoRef("http://zentao.example.com/index.php?m=bug&f=view"), { kind: "bug" });
  assert.deepEqual(parseZentaoRef("storyID=1313"), { kind: "story", id: 1313 });
});

test("认不出来就返回空：不把年份/乱码当编号", () => {
  assert.deepEqual(parseZentaoRef("帮我看下这个需求"), {});
  assert.deepEqual(parseZentaoRef(""), {});
  assert.deepEqual(parseZentaoRef("2026-10-30"), {});
  assert.deepEqual(parseZentaoRef(0), {});
  assert.deepEqual(parseZentaoRef(-3), {});
  assert.deepEqual(parseZentaoRef(1.5), {});
  assert.deepEqual(parseZentaoRef("99999999999999"), {});
  assert.deepEqual(parseZentaoRef(undefined), {});
});

/** 假服务：只记录收到的请求，不碰网络。 */
function makeService() {
  const calls = [];
  return {
    calls,
    limits: () => ({ maxAttachments: 0, maxAttachmentBytes: 0, maxRelated: 0 }),
    config: () => ({ output: { dir: "" } }),
    async read(request) {
      calls.push(request);
      return {
        envelope: {
          source: "db",
          entity: { kind: request.kind, id: request.id, title: "标题", url: "", attachments: [], notes: [{}, {}] },
        },
        rendered: `# ${request.kind} ${request.id}`,
      };
    },
    async relatedOf() {
      return [];
    },
  };
}

test("zentao_read 收链接：链接里的类型优先于 kind 参数", async () => {
  const service = makeService();
  const tool = createReadTool(service.constructor === Object ? service : service);
  const result = await tool.execute(
    { kind: "task", id: "http://zentao.example.com/index.php?m=bug&f=view&bugID=5967" },
    { signal: undefined, agent: { meta: { cwd: "D:/tmp" } } },
  );
  assert.equal(service.calls[0].kind, "bug", "应该按链接里的 m=bug 取，而不是调用方写的 task");
  assert.equal(service.calls[0].id, 5967);
  assert.equal(result.id, 5967);
  assert.equal(result.kind, "bug");
});

test("zentao_read 收认不出的东西：报错要说清楚怎么给", async () => {
  const tool = createReadTool(makeService());
  await assert.rejects(
    () => tool.execute({ kind: "bug", id: "看下这个" }, { signal: undefined }),
    /没从 id 里认出编号/,
  );
});

test("落盘默认目录跟着会话工作区走，不是宿主进程 cwd", async () => {
  const service = makeService();
  const tool = createReadTool(service);
  await tool.execute(
    { kind: "bug", id: "5967", download: true },
    {
      signal: undefined,
      agent: { session: { header: { cwd: "D:/workspace2/some-project" } } },
    },
  );
  assert.equal(
    service.calls[0].attachmentDir,
    join("D:/workspace2/some-project", "zentao-extract", "bug-5967"),
  );
});
