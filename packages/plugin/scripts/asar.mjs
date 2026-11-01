// 最小 asar 读取器：列目录 / 抽文件。只为读官方插件开发文档用，不参与插件运行。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ASAR = "D:/Program Files/DeepSeek Harness/resources/app.asar";
const buf = readFileSync(ASAR);
// asar = 4B pickle 头 + 3 个 uint32（总头长 / 头长-4 / json 长）+ json + 数据区。
const headerSize = buf.readUInt32LE(4);
const jsonSize = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(16, 16 + jsonSize).toString("utf8"));
const dataStart = 8 + headerSize;

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, path, out);
    else out.push({ path, size: child.size, offset: child.offset });
  }
}

const all = [];
walk(json, "", all);

const [, , command, arg, arg2] = process.argv;
if (command === "ls") {
  const re = arg ? new RegExp(arg) : null;
  for (const item of all) if (!re || re.test(item.path)) console.log(item.size, item.path);
} else if (command === "cat") {
  const item = arg2 === undefined ? all.find((it) => it.path === arg) : all.find((it) => it.path.endsWith(arg));
  if (!item) {
    console.error("not found:", arg);
    process.exit(1);
  }
  const start = dataStart + Number(item.offset);
  process.stdout.write(buf.subarray(start, start + item.size));
} else if (command === "dump") {
  const re = new RegExp(arg);
  const target = arg2;
  let count = 0;
  for (const item of all) {
    if (!re.test(item.path)) continue;
    const start = dataStart + Number(item.offset);
    const outPath = `${target}/${item.path}`;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf.subarray(start, start + item.size));
    count += 1;
  }
  console.log("dumped", count, "files");
}
