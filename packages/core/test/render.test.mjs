// 渲染层回归测试：模型读到的就是这份 markdown，形状变了要先知道。
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEntity, formatSize, renderRelatedList } from "../lib/domain/render.js";

const png = {
  fileId: 20881,
  filename: "image.png",
  size: 43542,
  addedBy: "hongshun",
  addedDate: "2026-10-30 00:00:00",
  isImage: true,
  localPath: "D:/w/20881_image.png",
};
const docx = {
  fileId: 20890,
  filename: "规则说明.docx",
  size: 22001,
  addedBy: "wangwu",
  addedDate: "2026-10-30 00:00:00",
  isImage: false,
};

function story(over = {}) {
  return {
    kind: "story",
    id: 1420,
    title: "【省协会】估计师注册效验规则调整",
    status: "reviewing",
    stage: "developed",
    pri: 3,
    spec: "见附件图 @@file:20881@@ 与文档 @@file:20890@@。",
    notes: [{ date: "2026-10-30 14:18:02", who: "wangwu", action: "commented", comment: "改成同邮箱提示。" }],
    attachments: [png, docx],
    images: [],
    ...over,
  };
}

test("story 全量：章节顺序、表格、正文内联、备注", () => {
  const md = renderEntity({ entity: story(), source: "db" }, "full");
  const order = ["# 研发需求 #1420", "只读库 + SFTP", "| 字段 | 值 |", "## 需求正文", "## 操作记录 / 备注（1 条）", "## 附件（2 个）"];
  let last = -1;
  for (const marker of order) {
    const at = md.indexOf(marker);
    assert.ok(at > last, `章节顺序不对：${marker}`);
    last = at;
  }
  assert.match(md, /见附件图 !\[image\.png#20881\]\(D:\/w\/20881_image\.png\)/);
  assert.match(md, /`commented` · wangwu/);
  assert.match(md, /规则说明\.docx.*—（未下载）/);
});

test("正文已内联的图不再在末尾重复贴一遍", () => {
  const md = renderEntity({ entity: story(), source: "db" }, "full");
  const occurrences = md.split("![image.png#20881]").length - 1;
  assert.equal(occurrences, 1, "同一张图只应出现一次");
});

test("未内联的图仍会在末尾单独列出（模型才能看到图）", () => {
  const extra = { fileId: 20899, filename: "shot.jpg", size: 9000, isImage: true, localPath: "D:/w/20899_shot.jpg" };
  const md = renderEntity({ entity: story({ attachments: [png, docx, extra] }), source: "db" }, "full");
  assert.match(md, /!\[shot\.jpg#20899\]\(D:\/w\/20899_shot\.jpg\)/);
});

test("未下载的文档在正文里保留可检索锚点，而不是被删掉", () => {
  const md = renderEntity({ entity: story({ spec: "看 @@file:20890@@" }), source: "db" }, "full");
  assert.match(md, /看 📎 规则说明\.docx \(#20890，未下载\)/);
});

test("附件表里查不到的 fileId 也不静默消失", () => {
  const md = renderEntity({ entity: story({ spec: "看 @@file:99999@@" }), source: "db" }, "full");
  assert.match(md, /看 📎 #99999/);
});

test("brief 模式不展开备注与附件", () => {
  const md = renderEntity({ entity: story(), source: "db" }, "brief");
  assert.ok(!md.includes("## 操作记录"));
  assert.match(md, /brief 模式：1 条备注、2 个附件未展开/);
});

test("通道缺字段时明说缺什么，不伪装成空值", () => {
  const md = renderEntity({ entity: story({ stage: undefined }), source: "http", missing: ["story.stage", "story.estimate"] }, "full");
  assert.match(md, /HTTP 页面（登录 cookie）/);
  assert.match(md, /该通道无法提供：阶段、预计工时/);
});

test("task / bug 的正文标题与正文标签", () => {
  const task = renderEntity({ entity: { kind: "task", id: 1875, title: "T", spec: "s", notes: [], attachments: [] }, source: "db" }, "full");
  assert.match(task, /^# 任务 #1875/);
  assert.match(task, /## 任务描述/);
  const bug = renderEntity({ entity: { kind: "bug", id: 5967, title: "B", steps: "复现步骤", notes: [], attachments: [] }, source: "http" }, "full");
  assert.match(bug, /^# BUG #5967/);
  assert.match(bug, /## 重现步骤/);
});

test("空正文兜底，不留空洞标题", () => {
  const md = renderEntity({ entity: story({ spec: "   " }), source: "db" }, "full");
  assert.match(md, /## 需求正文\n\n_（空）_/);
});

test("formatSize 边界", () => {
  assert.equal(formatSize(0), "");
  assert.equal(formatSize(undefined), "");
  assert.equal(formatSize(512), "512B");
  assert.equal(formatSize(43542), "42.5KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0MB");
});

test("关联列表空则不输出章节", () => {
  assert.equal(renderRelatedList("子任务", []), "");
  assert.match(
    renderRelatedList("子任务", [{ kind: "task", id: 1875, title: "做图表", status: "done", assignedTo: "wangwu" }]),
    /## 子任务\n\n- task#1875 做图表 \[done\] wangwu/,
  );
});

function bugFixture(over = {}) {
  return { kind: "bug", id: 5968, title: "【园区物管】业主代码验收意见", status: "激活", pri: 1, notes: [], attachments: [], images: [], steps: "", ...over };
}

test("HTTP 正文自带「## 重现步骤」时不再套一层同名标题", () => {
  const steps = ["## 重现步骤", "[步骤]", "点一下", "[结果]", "崩了"].join("\n\n");
  const md = renderEntity({ entity: bugFixture({ steps }), source: "http" }, "full");
  assert.equal(md.split("## 重现步骤").length - 1, 1, "同名标题只应出现一次");
  assert.ok(md.includes("## 重现步骤" + "\n\n" + "[步骤]"));
  assert.ok(!md.includes("## 重现步骤" + "\n\n" + "## 重现步骤"));
});

test("正文自带的旁支小标题（如「影响范围」）保持原样", () => {
  const steps = ["## 影响范围", "只影响园区"].join("\n\n");
  const md = renderEntity({ entity: bugFixture({ steps }), source: "http" }, "full");
  assert.ok(md.includes("## 重现步骤" + "\n\n" + "## 影响范围" + "\n\n" + "只影响园区"));
});
