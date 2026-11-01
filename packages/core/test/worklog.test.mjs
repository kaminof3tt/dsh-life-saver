// 工时统计的口径测试：用假 DbHandle 顶掉真库，把「按天聚合 / 按对象聚合 / 项目名爬取 / 漏项」锁住。
// 这些口径直接决定周报数字，算错了没人看得出来，所以必须有回归。
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWorklog, assertDate } from "../lib/channels/db/stats.js";

/**
 * 假 DbHandle：按 SQL 片段分派，返回预置行。
 * 只实现统计用到的那些表（effort / task / bug / story / project / action）。
 */
function fakeDb(fixture) {
  return {
    table: (name) => `zt_${name}`,
    async query(sql, params) {
      if (/FROM zt_effort/.test(sql)) return fixture.effort ?? [];
      if (/FROM zt_task\s+WHERE/.test(sql) && /name AS title/.test(sql)) return fixture.tasks ?? [];
      if (/FROM zt_task/.test(sql) && /SELECT id, execution/.test(sql)) return fixture.taskExec ?? [];
      if (/FROM zt_bug/.test(sql)) return fixture.bugs ?? [];
      if (/FROM zt_story/.test(sql)) return fixture.stories ?? [];
      if (/FROM zt_project/.test(sql)) {
        const ids = new Set(params ?? []);
        return (fixture.projects ?? []).filter((row) => ids.has(row.id));
      }
      if (/FROM zt_action/.test(sql)) return fixture.actions ?? [];
      throw new Error(`未预置的查询：${sql}`);
    },
    async one() {
      return undefined;
    },
    async close() {},
  };
}

const EFFORTS = [
  // 同一任务两天各记一笔（验证按对象聚合 + 按天聚合）
  { objectType: "task", objectID: 100, date: "2026-10-26", consumed: 4, left: 6, work: "写接口", account: "tester" },
  { objectType: "task", objectID: 100, date: "2026-10-27", consumed: 6, left: 0, work: "收尾", account: "tester" },
  // 一个 BUG 的工时
  { objectType: "bug", objectID: 900, date: "2026-10-27", consumed: 1.5, left: 0, work: "定位", account: "tester" },
  // 一条 0 工时的空行（禅道里会存在，不能污染合计也不该算「做了什么」）
  { objectType: "task", objectID: 101, date: "2026-10-28", consumed: 0, left: 3, work: "", account: "tester" },
];

test("工时统计：合计 = 各条之和，按对象与按天都自洽", async () => {
  const db = fakeDb({
    effort: EFFORTS,
    tasks: [
      { id: 100, title: "任务一百", status: "done", execution: 50 },
      { id: 101, title: "任务一百零一", status: "doing", execution: 50 },
    ],
    taskExec: [
      { id: 100, execution: 50 },
      { id: 101, execution: 50 },
    ],
    bugs: [{ id: 900, title: "某个 BUG", status: "resolved", execution: 51 }],
    projects: [
      { id: 50, name: "执行甲", type: "sprint", parent: 7 },
      { id: 51, name: "执行乙", type: "stage", parent: 7 },
      { id: 7, name: "项目大甲", type: "project", parent: 0 },
    ],
    actions: [],
  });

  const report = await collectWorklog(db, { account: "tester", from: "2026-10-26", to: "2026-10-28" });

  assert.equal(report.total, 11.5, "4 + 6 + 1.5");
  assert.equal(report.entries.length, 4, "0 工时那条也是工时记录，要保留");
  assert.equal(report.groups.length, 3, "任务 100、任务 101、bug 900");

  const task100 = report.groups.find((g) => g.kind === "task" && g.id === 100);
  assert.equal(task100.consumed, 10);
  assert.equal(task100.firstDate, "2026-10-26");
  assert.equal(task100.lastDate, "2026-10-27");
  assert.equal(task100.title, "任务一百");
  assert.equal(task100.projectName, "项目大甲", "执行要沿 parent 爬到 type=project 那层取名");

  const daily = new Map(report.daily.map((row) => [row.date, row.consumed]));
  assert.equal(daily.get("2026-10-26"), 4);
  assert.equal(daily.get("2026-10-27"), 7.5, "6 + 1.5 同一天要合并");
  assert.equal(daily.get("2026-10-28"), 0);
});

test("工时统计：kind 过滤只留指定类型，合计跟着变", async () => {
  const db = fakeDb({
    effort: EFFORTS,
    tasks: [{ id: 100, title: "任务一百", status: "done", execution: 50 }],
    taskExec: [{ id: 100, execution: 50 }],
    bugs: [{ id: 900, title: "某个 BUG", status: "resolved", execution: 0 }],
    projects: [{ id: 50, name: "项目甲", type: "project", parent: 0 }],
    actions: [],
  });

  const tasksOnly = await collectWorklog(db, { account: "tester", from: "2026-10-26", to: "2026-10-28", kind: "task" });
  assert.equal(tasksOnly.total, 10);
  assert.ok(tasksOnly.entries.every((entry) => entry.kind === "task"));

  const bugsOnly = await collectWorklog(db, { account: "tester", from: "2026-10-26", to: "2026-10-28", kind: "bug" });
  assert.equal(bugsOnly.total, 1.5);
});

test("工时统计：有动作但没记工时的对象要列成漏项，且不混进合计", async () => {
  const db = fakeDb({
    effort: EFFORTS,
    tasks: [{ id: 100, title: "任务一百", status: "done", execution: 50 }],
    taskExec: [{ id: 100, execution: 50 }],
    bugs: [],
    projects: [{ id: 50, name: "项目甲", type: "project", parent: 0 }],
    // 任务 200 完成了但一条工时都没有 —— 统计里必须单独提示，不能悄悄漏掉
    actions: [{ objectType: "task", objectID: 200, action: "finished", date: "2026-10-27 18:00:00" }],
  });

  const report = await collectWorklog(db, { account: "tester", from: "2026-10-26", to: "2026-10-28" });
  assert.equal(report.total, 11.5, "漏项不影响合计");
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].id, 200);
  assert.ok(report.missing[0].actions.includes("finished"));
  // 漏项少于 20 个时不额外加「只列前 20」的警告，这里只认 missing 本身
  assert.equal(report.warnings.length, 0, `不该有多余警告：${JSON.stringify(report.warnings)}`);
});

test("工时统计：空区间返回空报告而不是报错", async () => {
  const db = fakeDb({ effort: [], actions: [] });
  const report = await collectWorklog(db, { account: "nobody", from: "2026-01-01", to: "2026-01-31" });
  assert.equal(report.total, 0);
  assert.deepEqual(report.entries, []);
  assert.deepEqual(report.groups, []);
  assert.deepEqual(report.missing, []);
});

test("assertDate：只认 YYYY-MM-DD，别把 2026-1-1 这种塞进 SQL", () => {
  assert.equal(assertDate("2026-11-01", "开始日期"), "2026-11-01");
  assert.throws(() => assertDate("2026-1-1", "开始日期"), /YYYY-MM-DD|格式/);
  assert.throws(() => assertDate("2026-13-01", "开始日期"), /YYYY-MM-DD|格式|日期/);
  assert.throws(() => assertDate("2026-02-30", "开始日期"), /YYYY-MM-DD|格式|日期/);
  // 闰年边界要放过
  assert.equal(assertDate("2024-02-29", "开始日期"), "2024-02-29");
  assert.throws(() => assertDate("", "开始日期"), /YYYY-MM-DD|格式/);
});
