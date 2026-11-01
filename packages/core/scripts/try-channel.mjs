/**
 * 用插件自己的 lib 直连真禅道，验证 HTTP 通道：登录 → 取页面 → 解析。
 *   node scripts/try-channel.mjs <account> <password> <kind> <id>
 * 只读，不写配置。
 */
import { createHttpChannel } from "../lib/channels/http/index.js";

const [account, password, kind = "bug", id = "5968"] = process.argv.slice(2);
const channel = createHttpChannel({
  baseUrl: "http://zentao.example.com",
  account,
  password,
  timeoutMs: 30000,
});

const started = Date.now();
try {
  const entity = await channel.read({
    kind,
    id: Number(id),
    withAttachments: false,
    maxAttachments: 0,
    maxAttachmentBytes: 0,
  });
  console.log(`✅ ${kind} ${id} → ${entity.title}`);
  console.log(`   status=${entity.status} assignee=${entity.assignedTo} product=${entity.productName}`);
  console.log(`   正文 ${entity.body.length} 字 / 备注 ${entity.notes.length} 条 / 附件 ${entity.attachments.length} 个`);
  console.log(`   耗时 ${Date.now() - started}ms`);
  if (entity.attachments.length > 0) {
    console.log(`   附件: ${entity.attachments.map((a) => `${a.name}(${a.size}B)`).join(", ")}`);
  }
} catch (error) {
  console.error(`❌ ${error?.code ?? "error"}: ${error?.message}`);
  process.exitCode = 1;
} finally {
  await channel.dispose?.();
}
