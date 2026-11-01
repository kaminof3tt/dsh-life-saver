#!/usr/bin/env node
// 把版本号写进根 manifest 与两个包的 version。
// 发布流水线用的是「发的时候现改、不提交」——所以这个脚本只动文件、不碰 git。
//
//   node scripts/apply-version.mjs 0.9.0
//
// 两个包的依赖写法保持 workspace:*：pnpm publish 会把它改写成精确版本，
// 正好等于三个 manifest 里的同一个 version，lockstep 靠这一点成立。
import { readFileSync, writeFileSync } from "node:fs";

const version = (process.argv[2] || "").trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`版本号不合法：${version || "(空)"}；应形如 0.9.0`);
  process.exit(1);
}

const manifests = [
  new URL("../package.json", import.meta.url),
  new URL("../packages/core/package.json", import.meta.url),
  new URL("../packages/plugin/package.json", import.meta.url),
];

for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name} → ${version}`);
}
