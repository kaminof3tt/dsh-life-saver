// 配置字段必须全部 volatile —— 否则自建设置页保存会 500（dsh-settings 只允许写 volatile 路径）。
// 这个测试就是防止「加了个字段，忘了 .volatile()」这类只有点保存时才暴露的坑。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");

/** 找出 Config schema 里所有叶子字段：key、缩进、以及它的整段声明文本。 */
function leafFields(text) {
  const lines = text.split(/\r?\n/);
  const fields = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)([A-Za-z_][\w]*):\s*Schema\.(.*)$/.exec(lines[index]);
    if (!match) continue;
    const [, indent, key, rest] = match;
    const depth = indent.length;
    // 收集本字段的声明块：直到出现同层或更浅的新字段 / 收尾括号
    const block = [rest];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^\s*[A-Za-z_][\w]*:/.test(line) && line.search(/\S/) <= depth) break;
      if (/^\s*[}\])]/.test(line) && line.search(/\S/) <= depth) break;
      block.push(line);
    }
    fields.push({ key, depth, isObject: /^object/.test(rest), text: block.join("\n") });
  }
  return fields;
}

test("每个叶子配置字段都标了 .volatile()", () => {
  const leaves = leafFields(source).filter((field) => !field.isObject);
  assert.ok(leaves.length >= 8, `只找到 ${leaves.length} 个叶子字段，解析可能不对`);
  const offenders = leaves.filter((field) => !/\.volatile\(/.test(field.text)).map((field) => field.key);
  assert.deepEqual(offenders, [], `这些字段没标 .volatile()，设置页保存会失败：${offenders.join(", ")}`);
});

test("凭据 refs 与文档写法一致（密码不进配置）", () => {
  const refs = [...source.matchAll(/"(ZENTAO_[A-Z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(refs)].sort(), ["ZENTAO_DB_PASSWORD", "ZENTAO_PASSWORD", "ZENTAO_SFTP_PASSWORD"]);
  // 配置 schema 里不允许出现 password 字段
  assert.ok(!/password:\s*Schema\./i.test(source), "配置里出现了 password 字段，密码应走凭据中心");
});

test("解析器自检：能认出嵌套层级", () => {
  const sample = `
export const Config = Schema.object({
  mode: Schema.union(["auto"]).default("auto").volatile(),
  http: Schema.object({
    baseUrl: Schema.string().default(""),
  }).collapse(),
});
`;
  const fields = leafFields(sample);
  const baseUrl = fields.find((field) => field.key === "baseUrl");
  assert.ok(baseUrl, "没找到嵌套字段");
  assert.equal(baseUrl.depth, 4);
  assert.ok(!/\.volatile\(/.test(baseUrl.text), "这个样例本就该判失败");
});
