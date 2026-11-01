/**
 * 直连真禅道，把 read() 的返回原样打出来，定位是解析还是别的问题。
 *   node scripts/debug-read.mjs <account> <password> <kind> <id> [--download]
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpChannel } from "../lib/channels/http/index.js";

const args = process.argv.slice(2);
const download = args.includes("--download");
const [account, password, kind = "bug", id = "5968"] = args.filter((arg) => !arg.startsWith("--"));
const channel = createHttpChannel({
  baseUrl: "http://zentao.example.com",
  account,
  password,
  timeoutMs: 30000,
});

const attachmentDir = download ? await mkdtemp(join(tmpdir(), "zt-http-")) : undefined;
const envelope = await channel.read({
  kind,
  id: Number(id),
  withAttachments: download,
  attachmentDir,
  maxAttachments: 40,
  maxAttachmentBytes: 20 * 1024 * 1024,
});

console.log("返回类型:", typeof envelope, "键:", envelope && Object.keys(envelope));
console.log(JSON.stringify(envelope, null, 2).slice(0, download ? 6000 : 1500));
if (download) console.log("附件目录:", attachmentDir);
await channel.dispose?.();
