// 附件落盘：文件名来自禅道（用户可控），不能让它跑出目标目录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, readdir } from "node:fs/promises";
import { safeFileName, saveAttachment } from "../lib/channels/attachments.js";

test("路径分隔符与控制字符被收敛掉", () => {
  for (const evil of ["../../etc/passwd", "..\\..\\win.ini", "a/b:c*d?e\"f<g>h|i", "\u0000\u0001x"]) {
    const name = safeFileName(7, evil);
    assert.ok(!name.includes("/"), `残留斜杠：${name}`);
    assert.ok(!name.includes("\\"), `残留反斜杠：${name}`);
    // 这里就是要匹配控制字符，规则在此处没有意义。
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f]/.test(name), `残留控制字符：${name}`);
  }
});

test("空名字 / 纯空白有兜底，已有 id 前缀不重复加", () => {
  assert.equal(safeFileName(9, ""), "9_file");
  assert.equal(safeFileName(9, "   "), "9_file");
  assert.equal(safeFileName(20881, "20881_image.png"), "20881_image.png");
});

test("超长名字被截断到 120 以内", () => {
  const name = safeFileName(3, "长".repeat(300));
  assert.ok(name.length <= 120, `长度 ${name.length}`);
});

test("saveAttachment 真的落在给定目录里，不会越界", async () => {
  const dir = join(tmpdir(), `life-saver-att-${process.pid}`);
  const bytes = Buffer.from("hello");
  const written = await saveAttachment(dir, 42, "../../escape.txt", bytes);
  assert.ok(written.startsWith(dir), `写到了 ${written}`);
  assert.deepEqual(await readFile(written), bytes);
  assert.deepEqual(await readdir(dir), ["42_.._.._escape.txt"]);
  await rm(dir, { recursive: true, force: true });
});
