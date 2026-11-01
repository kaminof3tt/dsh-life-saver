// 新皮肤（禅道 15+/biz）详情页的解析回归。
//
// 这个结构是从真机页面上抄下来的，和 12.x 的差异都在这里：
//   - 没有 <title>，标题在 `.entity-title-text` 的 title 属性上；
//   - 正文是 `.detail-section`，不是 `.detail`；相关需求那类旁支块要排除；
//   - 备注面板的属性值是 JS 对象字面量（末尾挂着 fileActions:function），整体 JSON.parse 会炸；
//   - 「指派给」格子里人和时间挤在一起：「张三 于 2026-10-30 17:13:53」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { toBugFromPage } from "../lib/channels/http/map.js";
import { parsePage } from "../lib/channels/http/parse.js";

const escapeAttr = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// String.raw 保证 `\n` / `\/` 原样保留——禅道写在属性里的就是这个形状。
const HISTORY_ATTR = escapeAttr(
  String.raw`{"objectID":5968,"objectType":"bug","actions":[{"id":84192,"action":"opened","content":"2026-10-30 17:13:53, 由 <strong>赵六<\/strong> 创建。\n"},{"id":84193,"action":"assigned","content":"2026-10-30 17:13:53, 由 <strong>赵六<\/strong> 指派给 <strong>张三<\/strong>。\n"}],"fileActions":function(file){\nreturn getFileActions(file);\n}}`,
);

const PAGE = `
<div class="detail-view">
  <div class="detail-header" zui-key="title">
    <span class="label label-id gray-300-outline">5968</span>
    <span class="entity-title-text text-lg text-clip font-bold" title="【园区物管】竣工验收管理：新增维修对象名称后提示查询失败">【园区物管】竣工验收管理：新增维修对象名称后提示查询失败</span>
  </div>
  <div class="detail-body row gap-2 items-start" zui-key="body">
    <div class="detail-main" zui-key="main">
      <div class="datalist">
        <div class="datalist-item"><div class="datalist-item-label" title="所属产品">所属产品</div><div class="datalist-item-content"><a href="/index.php?m=product&f=view&productID=17">【G 端】维修资金</a></div></div>
        <div class="datalist-item"><div class="datalist-item-label" title="严重程度">严重程度</div><div class="datalist-item-content"><span class="severity" data-severity="2">2.非常严重</span></div></div>
        <div class="datalist-item"><div class="datalist-item-label" title="优先级">优先级</div><div class="datalist-item-content"><span class="pri-1">1</span></div></div>
        <div class="datalist-item"><div class="datalist-item-label" title="Bug类型">Bug类型</div><div class="datalist-item-content">页面展示</div></div>
        <div class="datalist-item"><div class="datalist-item-label" title="指派给">指派给</div><div class="datalist-item-content">张三 于 2026-10-30 17:13:53</div></div>
        <div class="datalist-item"><div class="datalist-item-label" title="由谁创建">由谁创建</div><div class="datalist-item-content">赵六 于 2026-10-30 17:13:53</div></div>
        <div class="datalist-item bug-status"><div class="datalist-item-label" title="Bug状态">Bug状态</div><div class="datalist-item-content">激活</div></div>
      </div>
      <div class="detail-sections canvas shadow rounded" zui-key="main">
        <div class="detail-section" zui-key="重现步骤">
          <div class="detail-section-title"><span class="text-md">重现步骤</span></div>
          <div class="detail-section-content">
            <div class="article"><p>[步骤]</p><p>新增维修对象名称后点确定</p><p>[结果]</p><p><img src="/index.php?m=file&amp;f=read&amp;t=png&amp;fileID=20927" /></p></div>
          </div>
        </div>
      </div>
      <div class="detail-sections canvas shadow rounded" zui-key="related">
        <div class="detail-section"><div class="detail-section-title">相关需求</div>
          <div class="detail-section-content">1383【园区物管V2】维修资金竣工验收业主验收逻辑修改及字段优化</div></div>
      </div>
      <div class="detail-sections canvas shadow rounded" zui-key="historyWrapper">
        <div zui-create zui-create-historyPanel="${HISTORY_ATTR}"></div>
      </div>
    </div>
  </div>
</div>
`;

test("新皮肤页面：标题取 entity-title-text 的 title 属性", () => {
  const page = parsePage(PAGE);
  assert.equal(page.title, "【园区物管】竣工验收管理：新增维修对象名称后提示查询失败");
});

test("新皮肤页面：正文只认 detail-section，相关需求那类旁支块不算进来", () => {
  const page = parsePage(PAGE);
  assert.equal(page.sections.length, 1);
  assert.equal(page.sections[0].label, "重现步骤");
  assert.match(page.sections[0].text, /新增维修对象名称后点确定/);
  assert.doesNotMatch(page.sections[0].text, /1383/);
});

test("新皮肤页面：历史面板的值是 JS 对象字面量，也要能抠出 actions", () => {
  const page = parsePage(PAGE);
  assert.equal(page.notes.length, 2);
  assert.deepEqual(
    page.notes.map((note) => [note.action, note.who, note.date, note.comment]),
    [
      ["opened", "赵六", "2026-10-30 17:13:53", "创建。"],
      ["assigned", "赵六", "2026-10-30 17:13:53", "指派给 张三。"],
    ],
  );
});

test("新皮肤页面：「指派给」格子里人和时间要拆开", () => {
  const bug = toBugFromPage(parsePage(PAGE), { id: 5968, fallbackTitle: "bug #5968" });
  assert.equal(bug.assignedTo, "张三");
  assert.equal(bug.openedBy, "赵六");
  assert.equal(bug.openedDate, "2026-10-30 17:13:53");
  assert.equal(bug.status, "激活");
  assert.equal(bug.severity, 2);
  assert.equal(bug.pri, 1);
  assert.equal(bug.productName, "【G 端】维修资金");
  assert.equal(bug.type, "页面展示");
  assert.deepEqual(bug.images.map((image) => image.fileId), [20927]);
});
