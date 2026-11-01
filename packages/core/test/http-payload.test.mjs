// HTTP 写的表单载荷必须与禅道页面一致。
//
// 这一层是「离线」的：HTTP 线没有沙箱，一次真机 POST 就是一次真实写入，
// 所以字段名/名称/算法上的错，必须靠这批断言兜住，而不是靠真机试错。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBugBody, buildTaskBody, readFormDefaults } from "../lib/channels/http/write.js";

const BEFORE = { status: "doing", assignedTo: "zhangsan", consumed: 5, left: 3, openedBy: "lisi" };

test("recordworkhour：字段名必须带数组下标，否则禅道读不到行", () => {
  const body = buildTaskBody(BEFORE, { kind: "task", id: 1, action: "recordworkhour", consumed: 1.5, comment: "联调" });
  // 曾经踩过：平铺的 work/consumed 会被当成「没填」，甚至回一个假的 success
  assert.equal(body.get("work[1]"), "联调");
  assert.equal(body.get("consumed[1]"), "1.5");
  assert.equal(body.get("id[1]"), "");
  assert.ok(body.get("date[1]"), "日期必填，没给就用今天");
  assert.equal(body.get("work"), null, "不能同时出现平铺字段");
  assert.equal(body.get("consumed"), null);
  // left 没给就沿用原值，别把剩余工时冲成 0
  assert.equal(body.get("left[1]"), "3");
});

test("recordworkhour：剩余工时可以显式覆盖，用来「记完就收尾」", () => {
  const body = buildTaskBody(BEFORE, { kind: "task", id: 1, action: "recordworkhour", consumed: 2, left: 0, comment: "x" });
  assert.equal(body.get("left[1]"), "0");
});

test("finish：currentConsumed 是「本次」，consumed 是「旧+本次」，两个都要给", () => {
  const body = buildTaskBody(BEFORE, {
    kind: "task", id: 1, action: "finish", consumed: 2,
    realStarted: "2026-10-30 09:27:00", finishedDate: "2026-11-01 10:00:00",
  });
  assert.equal(body.get("currentConsumed"), "2", "禅道按它算这次的工时增量");
  assert.equal(body.get("consumed"), "7", "总消耗 = 5 + 2");
  assert.equal(body.get("left"), "0");
  assert.equal(body.get("status"), "done");
  assert.equal(body.get("finishedDate"), "2026-11-01 10:00:00");
  assert.equal(body.get("realStarted"), "2026-10-30 09:27:00");
});

test("finish：工时填 0 要给出警告（禅道不会为 0 生成工时记录）", () => {
  const warnings = [];
  buildTaskBody(BEFORE, { kind: "task", id: 1, action: "finish", consumed: 0 }, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不会为这次完成生成工时记录/);
});

test("start：consumed 传的是「新总消耗」，left=0 时禅道会直接判完成", () => {
  const body = buildTaskBody({ status: "wait", assignedTo: "zhangsan", consumed: 0, left: 8 }, {
    kind: "task", id: 1, action: "start", consumed: 1, left: 0, realStarted: "2026-11-01 10:00:00",
  });
  assert.equal(body.get("consumed"), "1");
  assert.equal(body.get("left"), "0");
  assert.equal(body.get("status"), "doing");
});

test("pause / cancel / close：各自的状态字段与 comment 不能串", () => {
  const pause = buildTaskBody(BEFORE, { kind: "task", id: 1, action: "pause", comment: "先停" });
  assert.equal(pause.get("status"), "pause");
  assert.equal(pause.get("comment"), "先停");

  const cancel = buildTaskBody(BEFORE, { kind: "task", id: 1, action: "cancel", comment: "不做了" });
  assert.equal(cancel.get("status"), "cancel");

  // close 不能带 status：禅道那边是 setDefault status='closed'
  const close = buildTaskBody(BEFORE, { kind: "task", id: 1, action: "close", comment: "收工" });
  assert.equal(close.get("status"), null);
  assert.equal(close.get("comment"), "收工");
});

test("activate：left 必填（zt_config 的 task.activate.requiredFields=left）", () => {
  const body = buildTaskBody({ status: "pause", consumed: 16, left: 4 }, { kind: "task", id: 1, action: "activate", left: 2 });
  assert.equal(body.get("left"), "2");
  assert.equal(body.get("status"), "doing");
});

test("comment：空备注要在本地就拒掉，别发一个必失败的请求", () => {
  assert.throws(() => buildTaskBody(BEFORE, { kind: "task", id: 1, action: "comment", comment: "  " }), /备注内容不能为空/);
  const ok = buildTaskBody(BEFORE, { kind: "task", id: 1, action: "comment", comment: "写完了" });
  assert.equal(ok.get("comment"), "写完了");
  assert.equal(ok.get("status"), null);
});

test("BUG recordworkhour：effort 表单的四个数组字段一个都不能少", () => {
  const body = buildBugBody({ kind: "bug", id: 5968, action: "recordworkhour", consumed: 1.5, comment: "排查", date: "2026-11-01" });
  assert.equal(body.get("objectType[1]"), "bug");
  assert.equal(body.get("objectID[1]"), "5968");
  assert.equal(body.get("dates[1]"), "2026-11-01");
  assert.equal(body.get("work[1]"), "排查");
  assert.equal(body.get("consumed[1]"), "1.5");
  assert.equal(body.get("id[1]"), "");
  // 平铺形态会「假成功」（实测返回 success 但没写进去），必须确保没混进来
  assert.equal(body.get("objectID"), null);
  assert.equal(body.get("consumed"), null);
});

test("BUG recordworkhour：工时 <=0 与空工作内容都要拒", () => {
  assert.throws(() => buildBugBody({ kind: "bug", id: 1, action: "recordworkhour", consumed: 0, comment: "x" }), /必须大于 0/);
  assert.throws(() => buildBugBody({ kind: "bug", id: 1, action: "recordworkhour", consumed: 1, comment: "" }), /日志内容不能为空/);
});

test("BUG resolve：fixed 要给解决版本，duplicate 要给原 BUG 号", () => {
  const fixed = buildBugBody({ kind: "bug", id: 1, action: "resolve", resolution: "fixed", resolvedBuild: "主干" });
  assert.equal(fixed.get("resolution"), "fixed");
  assert.equal(fixed.get("resolvedBuild"), "主干");
  assert.equal(fixed.get("buildName"), "主干");

  const dup = buildBugBody({ kind: "bug", id: 1, action: "resolve", resolution: "duplicate", duplicateBug: 42 });
  assert.equal(dup.get("duplicateBug"), "42");
  assert.equal(dup.get("resolvedBuild"), "trunk", "没给版本时按 trunk");

  assert.throws(() => buildBugBody({ kind: "bug", id: 1, action: "resolve" }), /必须给 resolution/);
  assert.throws(() => buildBugBody({ kind: "bug", id: 1, action: "resolve", resolution: "duplicate" }), /必须给 duplicateBug/);
});

test("BUG confirm / close：只带 comment，不带任何状态字段（禅道自己 setDefault）", () => {
  const confirm = buildBugBody({ kind: "bug", id: 1, action: "confirm", comment: "确认了" });
  assert.deepEqual([...confirm.keys()], ["comment"]);
  const close = buildBugBody({ kind: "bug", id: 1, action: "close" });
  assert.equal(close.toString(), "", "没评论就什么都不传");
});

// ---------------------------------------------------------------------------
// 表单默认值回填：禅道 model 多半 `fixer::input('post')` 全量落库，POST 里缺的列会被写成
// 库默认值（本库 sql_mode='' → pri 变 3、type 变空、deadline 变空、assignedTo 被清空）。
// 浏览器不出事是因为它把每个控件的当前值都回传了，所以我们也必须回填。
// ---------------------------------------------------------------------------

test("readFormDefaults：普通 input 与 textarea 的当前值要收进来", () => {
  const html =
    '<input type="hidden" name="status" value="active" />' +
    '<input type="hidden" name="uid" value="abc123" />' +
    '<input type="text" name="left" value="3" />' +
    "<textarea name=\"comment\">  已复核  </textarea>";
  const defaults = readFormDefaults(html);
  assert.equal(defaults.get("status"), "active");
  assert.equal(defaults.get("uid"), null, "uid 由调用方单独设置，不参与默认值");
  assert.equal(defaults.get("left"), "3");
  assert.equal(defaults.get("comment"), "已复核", "textarea 去掉首尾空白");
});

test("readFormDefaults：zui picker / priPicker / datePicker 的 defaultValue 就是当前值", () => {
  const html =
    '<div data-name="assignedTo" zui-create-picker="{&quot;name&quot;:&quot;assignedTo&quot;,&quot;defaultValue&quot;:&quot;zhangsan&quot;}"></div>' +
    '<div data-name="pri" zui-create-priPicker="{&quot;name&quot;:&quot;pri&quot;,&quot;items&quot;:{&quot;1&quot;:&quot;1&quot;},&quot;defaultValue&quot;:1}"></div>' +
    '<div data-name="deadline" zui-create-datePicker="{&quot;name&quot;:&quot;deadline&quot;,&quot;defaultValue&quot;:&quot;2026-10-28&quot;}"></div>' +
    '<div data-name="type" zui-create-picker="{&quot;name&quot;:&quot;type&quot;,&quot;defaultValue&quot;:&quot;Page&quot;}"></div>';
  const defaults = readFormDefaults(html);
  // 这四个正是上一次真机 confirm 被打坏的列（type/pri/deadline/assignedTo）
  assert.equal(defaults.get("assignedTo"), "zhangsan");
  assert.equal(defaults.get("pri"), "1", "数字型 defaultValue 也要认");
  assert.equal(defaults.get("deadline"), "2026-10-28");
  assert.equal(defaults.get("type"), "Page");
});

test("readFormDefaults：空值、JS 拼串占位值、附件与多人任务字段一律跳过", () => {
  // 页面模板里的占位值是 `' + assignedTo + '`（单引号包着 JS 拼接串），这里用字符码拼出来避免转义地狱
  const q = String.fromCharCode(39);
  const placeholder = q + " + assignedTo + " + q;
  const placeholder2 = q + " + estimate + " + q;
  const html =
    '<div zui-create-picker="{&quot;name&quot;:&quot;resolution&quot;,&quot;defaultValue&quot;:&quot;&quot;}"></div>' +
    '<input type="hidden" name="team[]" value="' + placeholder + '" />' +
    '<input type="text" name="teamEstimate" value="' + placeholder2 + '" />' +
    '<input type="file" name="files[]" value="" />' +
    '<input type="checkbox" name="createBuild" value="1" />';
  const defaults = readFormDefaults(html);
  assert.equal(defaults.get("resolution"), null, "空默认值不回填");
  assert.equal(defaults.get("team[]"), null, "JS 拼串占位值不能写进库");
  assert.equal(defaults.get("teamEstimate"), null);
  assert.equal(defaults.get("files[]"), null);
  assert.equal(defaults.get("createBuild"), null, "未勾选的 checkbox 不该回填");
});

test("readFormDefaults：HTML 实体要还原成原字符", () => {
  const html = '<input type="hidden" name="buildName" value="a&amp;b&quot;c" />';
  assert.equal(readFormDefaults(html).get("buildName"), 'a&b"c');
});
