// 工时报告的排版回归：重点是「合计行」用截断前的对象数。
// 线上真踩过：limit=5 时报告抬头写「涉及 5 个对象」，末尾却写「共 32 个对象，这里只展示了前 5 个」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorklogReport } from "../lib/ops/workhours.js";

function group(id, title) {
  return {
    kind: "task",
    id,
    title,
    projectName: "【物管平台】示例项目",
    status: "closed",
    consumed: 4,
    firstDate: "2026-10-26",
    lastDate: "2026-10-26",
    notes: ["开发"],
  };
}

function entry(id, title) {
  return {
    kind: "task",
    id,
    title,
    projectName: "【物管平台】示例项目",
    date: "2026-10-26",
    consumed: 4,
    work: "开发",
    account: "zhangsan",
    status: "closed",
  };
}

function report(patch = {}) {
  return {
    account: "zhangsan",
    from: "2026-10-26",
    to: "2026-11-01",
    total: 12,
    entries: [entry(1, "任务一"), entry(2, "任务二"), entry(3, "任务三")],
    groups: [group(1, "任务一"), group(2, "任务二"), group(3, "任务三")],
    daily: [
      { date: "2026-10-26", consumed: 8, count: 2 },
      { date: "2026-10-27", consumed: 4, count: 1 },
    ],
    missing: [],
    warnings: [],
    ...patch,
  };
}

test("合计行用调用方给的对象数，不被 limit 截断带偏", () => {
  const markdown = renderWorklogReport(report(), false, 32);
  assert.match(markdown, /涉及 32 个对象/);
  assert.doesNotMatch(markdown, /涉及 3 个对象/);
});

test("不给对象数时退回 groups.length，老调用点行为不变", () => {
  const markdown = renderWorklogReport(report(), false);
  assert.match(markdown, /涉及 3 个对象/);
});

test("按对象聚合只在有内容时出现，逐条明细受 detail 控制", () => {
  const brief = renderWorklogReport(report(), false);
  assert.match(brief, /## 做了什么/);
  assert.doesNotMatch(brief, /## 逐条工时/);
  assert.match(brief, /## 按天/);

  const full = renderWorklogReport(report(), true);
  assert.match(full, /## 逐条工时/);
  assert.match(full, /- 2026-10-26 任务 #1 开发 — 4h/);
});

test("漏项段落会带上补记提示", () => {
  const markdown = renderWorklogReport(
    report({ missing: [{ kind: "bug", id: 9, title: "BUG 九", actions: ["opened", "resolved"], lastDate: "2026-10-28" }] }),
    false,
  );
  assert.match(markdown, /## 有动作但没记工时/);
  assert.match(markdown, /BUG #9 BUG 九（opened\/resolved，最后 2026-10-28）/);
  assert.match(markdown, /zentao_task_op 的 recordworkhour/);
});

test("没有对象也没有明细时不硬凑小节", () => {
  const markdown = renderWorklogReport(report({ groups: [], entries: [], daily: [], total: 0 }), true);
  assert.match(markdown, /涉及 0 个对象/);
  assert.doesNotMatch(markdown, /## 做了什么/);
  assert.doesNotMatch(markdown, /## 逐条工时/);
  assert.doesNotMatch(markdown, /## 按天/);
});
