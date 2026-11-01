// 两条通道的口径必须能对上：DB 线给 `doing`，HTTP 线给「进行中」+ 中文名。
// 这批测试盯的就是「护栏别因为写法不同把合法写入误杀」——曾经真的全盘误杀过。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePage } from "../lib/channels/http/parse.js";
import { toBugFromPage, toTaskFromPage } from "../lib/channels/http/map.js";
import { parseUserPairs } from "../lib/channels/http/users.js";
import { RESOLUTION_LABEL, STATUS_LABEL, resolutionCode, statusCode } from "../lib/domain/labels.js";

/** 真实页面片段的缩小版：状态装 `<span class="status-xxx">`，人员是中文名 + 「于 时间」。 */
const TASK_PAGE = `
<div class="datalist-item task-status">
  <div class="datalist-item-label">任务状态</div>
  <div class="datalist-item-content"><span class="status-doing">进行中</span></div>
</div>
<div class="datalist-item task-assignedTo">
  <div class="datalist-item-label">指派给</div>
  <div class="datalist-item-content"><a>张三</a> 于 2026-10-30 17:13:53</div>
</div>
<div class="datalist-item task-openedBy">
  <div class="datalist-item-label">由谁创建</div>
  <div class="datalist-item-content"><a>李四</a> 于 2026-10-23 08:39:36</div>
</div>
`;

const BUG_PAGE = `
<div class="datalist-item bug-status">
  <div class="datalist-item-label">Bug状态</div>
  <div class="datalist-item-content"><span class="status-resolved">已解决</span></div>
</div>
<div class="datalist-item bug-resolution">
  <div class="datalist-item-label">解决方案</div>
  <div class="datalist-item-content"><div><span>已解决</span></div></div>
</div>
<div class="datalist-item bug-assignedTo">
  <div class="datalist-item-label">指派给</div>
  <div class="datalist-item-content"><a>王五</a> 于 2026-10-30 14:03:35</div>
</div>
`;

const PAIRS = { zhangsan: "张三", lisi: "李四", wangwu: "王五" };
const resolveAccount = (realname) => Object.entries(PAIRS).find(([, name]) => name === realname)?.[0];

test("页面上的 status-xxx class 要变成机器码，中文原文照旧保留给展示", () => {
  const page = parsePage(TASK_PAGE);
  assert.equal(page.states["任务状态"], "doing");
  const task = toTaskFromPage(page, { id: 1, fallbackTitle: "t" });
  // 展示层还是中文——用户看到的要和禅道页面一致
  assert.equal(task.status, "进行中");
  // 机器码单独放 codes，护栏用它
  assert.equal(task.codes?.status, "doing");
});

test("人员字段要能从中文名反查回账号，反查不到就留空而不是硬塞中文", () => {
  const page = parsePage(TASK_PAGE);
  const withMap = toTaskFromPage(page, { id: 1, fallbackTitle: "t", resolveAccount });
  assert.equal(withMap.assignedTo, "张三", "展示仍是中文名");
  assert.equal(withMap.codes?.assignedTo, "zhangsan");
  assert.equal(withMap.codes?.openedBy, "lisi");

  const withoutMap = toTaskFromPage(page, { id: 1, fallbackTitle: "t" });
  assert.equal(withoutMap.assignedTo, "张三");
  // 状态机器码是页面自己给的，跟反查表无关，照样要有
  assert.equal(withoutMap.codes?.status, "doing");
  // 反查不到账号就不要伪造——留 undefined，护栏那边会据此不下结论
  assert.equal(withoutMap.codes?.assignedTo, undefined);
  assert.equal(withoutMap.codes?.openedBy, undefined);
});

test("BUG 的解决方案页面没有 class，只能靠中文；状态仍然走 class", () => {
  const page = parsePage(BUG_PAGE);
  assert.equal(page.states["Bug状态"], "resolved");
  const bug = toBugFromPage(page, { id: 2, fallbackTitle: "b", resolveAccount });
  assert.equal(bug.status, "已解决");
  assert.equal(bug.codes?.status, "resolved");
  assert.equal(bug.resolution, "已解决");
});

test("状态标签字典：机器码幂等，中文能反查，认不出的返回 undefined（不瞎猜）", () => {
  assert.equal(statusCode("doing"), "doing");
  assert.equal(statusCode("进行中"), "doing");
  assert.equal(statusCode("已解决"), "resolved");
  assert.equal(statusCode("结束"), "closed", "旧版文案也要认");
  assert.equal(statusCode("激活"), "active");
  assert.equal(statusCode("乱写的"), undefined);
  assert.equal(statusCode(""), undefined);
  assert.equal(statusCode(undefined), undefined);
  // 字典里每个值都要能被反查回来，否则界面上会出现「查不到的机器码」
  for (const [code, label] of Object.entries(STATUS_LABEL)) {
    assert.equal(statusCode(label), code, `${label} 应反查为 ${code}`);
  }
});

test("解决方案字典与库内文案一致（这几个曾经翻错过）", () => {
  // 取自 zt_history.field='resolution' 的 newValue 真实分布
  assert.equal(RESOLUTION_LABEL.fixed, "已解决");
  assert.equal(RESOLUTION_LABEL.willnotfix, "不予解决");
  assert.equal(RESOLUTION_LABEL.duplicate, "重复Bug");
  assert.equal(RESOLUTION_LABEL.tostory, "转为研发需求");
  assert.equal(RESOLUTION_LABEL.productized, "产品线调整");
  assert.equal(resolutionCode("已解决"), "fixed");
  assert.equal(resolutionCode("fixed"), "fixed");
  assert.equal(resolutionCode("不认识"), undefined);
});

test("userPairs 解析：company/browse 是两层 JSON，得解两次", () => {
  const inner = JSON.stringify({ title: "公司", userPairs: PAIRS, pager: { recTotal: 3 } });
  const outer = JSON.stringify({ status: "success", data: inner, md5: "x" });
  const pairs = parseUserPairs(outer);
  assert.ok(pairs);
  assert.equal(pairs.get("zhangsan"), "张三");
  assert.equal(pairs.size, 3);
});

test("userPairs 解析：坏回包一律返回 undefined，不抛异常", () => {
  assert.equal(parseUserPairs("not json"), undefined);
  assert.equal(parseUserPairs("{}"), undefined);
  assert.equal(parseUserPairs(JSON.stringify({ status: "fail" })), undefined);
  assert.equal(parseUserPairs(JSON.stringify({ data: "not json either" })), undefined);
  assert.equal(parseUserPairs(JSON.stringify({ data: JSON.stringify({ userPairs: {} }) })), undefined);
});

test("页面里内联的 .label.status-doing 样式表不能被当数据", () => {
  // 真实页面开头就有一大段这种 CSS，全局搜 class 会先命中它
  const page = parsePage(`
    <style>.label.status-doing{color:#333}.label.status-done{color:#999}</style>
    <div class="datalist-item task-status">
      <div class="datalist-item-label">任务状态</div>
      <div class="datalist-item-content"><span class="status-pause">已暂停</span></div>
    </div>
  `);
  assert.equal(page.states["任务状态"], "pause", "只认 datalist-item-content 里的那个");
});
