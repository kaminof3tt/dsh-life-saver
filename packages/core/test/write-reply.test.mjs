// 写操作的「回包判定」是最容易静默出错的地方：判错了不会报错，只会悄悄什么都没写。
// 实测踩过的坑：禅道表单校验失败回的是 {"result":"fail","message":{"finishedDate":["…"]}}
// —— result 是字符串 "fail"、message 是个对象。早期只判 result === "success"，其余一律当成功。
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeWriteReply, extractUid } from "../lib/channels/http/write.js";

test("judgeWriteReply：只认明确的成功", () => {
  assert.equal(judgeWriteReply('{"result":"success","message":"保存成功"}').ok, true);
  assert.equal(judgeWriteReply('{"result":true}').ok, true);
  // JS 跳转文本也算成功（recordEstimate / comment 这类入口回的是脚本）
  assert.equal(judgeWriteReply("js::locate('http://x/index.php?m=task&f=view')").ok, true);
  assert.equal(judgeWriteReply("js::reload('parent')").ok, true);
  assert.equal(judgeWriteReply("js::closeModal('parent.parent')").ok, true);
});

test("judgeWriteReply：result 是 fail / false 都算失败，不能当成功", () => {
  const fail = judgeWriteReply('{"result":"fail","message":{"finishedDate":["实际完成不能小于实际开始"]}}');
  assert.equal(fail.ok, false);
  assert.match(fail.message, /实际完成不能小于实际开始/);
  assert.match(fail.message, /finishedDate/);

  const refused = judgeWriteReply('{"result":false,"message":"您没有访问权限"}');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /您没有访问权限/);

  // 没有 result 标记时按失败算更安全（宁可不认，也不能假报成功）
  assert.equal(judgeWriteReply('{"message":"whatever"}').ok, false);
});

test("judgeWriteReply：message 是对象/数组时要摊平成一句话", () => {
  assert.equal(
    judgeWriteReply('{"result":"fail","message":{"name":["不能为空"],"left":["必须是数字"]}}').message,
    "name: 不能为空；left: 必须是数字",
  );
  assert.equal(judgeWriteReply('{"result":"fail","message":["第一条","第二条"]}').message, "第一条；第二条");
});

test("judgeWriteReply：js::error 里的原文要带出来，认不出的回包也不能当成功", () => {
  const error = judgeWriteReply("js::error('left 必须是数字')");
  assert.equal(error.ok, false);
  assert.match(error.message, /left 必须是数字/);

  const strange = judgeWriteReply("<html>something unexpected</html>");
  assert.equal(strange.ok, false);
  assert.match(strange.message, /无法识别/);
});

test("judgeWriteReply：会话过期要抛出去（让上层重登），不算业务失败", () => {
  assert.throws(
    () => judgeWriteReply('{"result":false,"message":"登录已超时，请重新登入!","load":"login"}'),
    (error) => error.code === "login",
  );
});

test("extractUid：从表单 HTML 里抠隐藏 uid，没有就返回空串", () => {
  assert.equal(extractUid('<input type="hidden" name="uid" value="6ae610d82e547" />'), "6ae610d82e547");
  assert.equal(extractUid("<input name='uid' value='abc'>"), "abc");
  assert.equal(extractUid('<input name="comment" value="x" />'), "");
});

test("judgeWriteReply：禅道回「HTML 外壳 + script」的跳转，要认成成功（曾把成功报成失败）", () => {
  // 真实回包长这样：comment 写完，禅道 echo 了一段 js::reload
  const reload = `<html><meta charset='utf-8'/><style>body{background:white}</style><script>if(parent !== window) parent.location.reload(); else location.reload();</script>`;
  const result = judgeWriteReply(reload);
  assert.equal(result.ok, true, "写入确实发生了，不能报成无法识别");
  assert.equal(result.message, "保存成功");

  const locate = `<html><meta charset='utf-8'/><style>body{background:white}</style><script>location.href='/index.php?m=task&f=view&taskID=2042';</script>`;
  assert.equal(judgeWriteReply(locate).ok, true);

  const closeModal = "<script>parent.$('.modal').modal('hide');</script>";
  assert.equal(judgeWriteReply(closeModal).ok, true);
});

test("judgeWriteReply：同样的 HTML 外壳里如果是 alert，就是业务报错", () => {
  const alert = `<html><meta charset='utf-8'/><style>body{background:white}</style><script>alert('实际完成不能小于实际开始');</script>`;
  const result = judgeWriteReply(alert);
  assert.equal(result.ok, false);
  assert.match(result.message, /实际完成不能小于实际开始/);
});

test("judgeWriteReply：HTML 外壳但脚本里既没跳转也没 alert，仍然不能当成功", () => {
  const odd = "<html><script>console.log('???');</script></html>";
  assert.equal(judgeWriteReply(odd).ok, false);
});
