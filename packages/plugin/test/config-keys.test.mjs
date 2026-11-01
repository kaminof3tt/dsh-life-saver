// 配置键对齐：客户端设置页的字段表（FIELDS）与宿主配置 schema 必须一一对上。
//
// 为什么需要这条断言：FIELDS 是硬编码数组，配置 schema 在 src/config.ts，两边靠人肉同步。
// 一边加了键另一边没跟上，症状是「页面上没入口」或「填了不保存」（diffOps 按 FIELDS 走），
// 而且两边都不报错。这里只读源码文本做对照——客户端 bundle 需要 react 与 window，进不了 node 测试。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Config, unwrapConfig } from "life-saver-core/config.js";

const CLIENT = readFileSync(new URL("../src/client/index.jsx", import.meta.url), "utf8");

/** 配置 schema 展开后的叶子键路径（数组也算叶子：targets 就是一整块 JSON）。 */
function configLeaves() {
  const config = unwrapConfig(new Config({}));
  const out = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      out.push(path.join("."));
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], [...path, key]);
  };
  for (const key of Object.keys(config)) walk(config[key], [key]);
  return out;
}

/** 从客户端源码里抽出 FIELDS 的每一项（path / kind / section）。 */
function clientFields() {
  const start = CLIENT.indexOf("const FIELDS = [");
  assert.notEqual(start, -1, "src/client/index.jsx 里找不到 FIELDS");
  const end = CLIENT.indexOf("\n];", start);
  assert.notEqual(end, -1, "FIELDS 数组没有正常结束");
  const block = CLIENT.slice(start, end);
  const fields = [];
  for (const line of block.split("\n")) {
    const path = /path:\s*\[([^\]]*)\]/.exec(line);
    if (path === null) continue;
    const segments = path[1]
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter((item) => item !== "");
    const kind = /kind:\s*"([a-z]+)"/.exec(line)?.[1];
    const section = /section:\s*"([^"]+)"/.exec(line)?.[1];
    fields.push({ path: segments, kind, section });
  }
  return fields;
}

test("配置键对齐：FIELDS 里每个路径都在配置 schema 里存在", () => {
  const leaves = new Set(configLeaves());
  const missing = clientFields()
    .filter((field) => !leaves.has(field.path.join(".")))
    .map((field) => field.path.join("."));
  assert.deepEqual(missing, [], "这些字段在配置 schema 里找不到（多半是改名后忘了同步）");
});

test("配置键对齐：schema 里每个键都能在页面上改到", () => {
  // mode 是页面顶部的「取数通道」单选，单独提交，不在 FIELDS 里。
  const handledOutsideFields = new Set(["mode"]);
  const covered = new Set([...clientFields().map((field) => field.path.join(".")), ...handledOutsideFields]);
  const uncovered = configLeaves().filter((leaf) => !covered.has(leaf));
  assert.deepEqual(uncovered, [], "这些配置键在设置页上没有入口（新增键记得登记进 FIELDS）");
});

test("配置键对齐：FIELDS 的 kind / section 只用品类里已有的值", () => {
  // kind 决定渲染成什么控件（TextInput 里按 number 转数字），section 决定挂在哪一段；
  // 冒出一个新值不会报错，只会静默渲染成文本框或者干脆不显示，所以这里钉死。
  const kinds = new Set(["text", "number", "boolean", "json"]);
  const sections = new Set(["http", "db", "sftp", "limits", "output", "_hidden"]);
  for (const field of clientFields()) {
    assert.ok(kinds.has(field.kind), `${field.path.join(".")} 的 kind 不认识：${field.kind}`);
    assert.ok(sections.has(field.section), `${field.path.join(".")} 的 section 不认识：${field.section}`);
  }
});

test("配置键对齐：FIELDS 里没有重复路径", () => {
  const paths = clientFields().map((field) => field.path.join("."));
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
  assert.deepEqual(duplicates, []);
});
