/**
 * zentao_read 的执行与渲染。
 *
 * 两个壳都调这里：插件把结果塞进 output schema，MCP 把它转成 content blocks。
 * 逻辑（链接识别、附件落盘目录、关联对象递归、降级提示）只有这一份。
 */

import { join } from "node:path";
import type { ChannelName, EntityKind } from "../domain/model.js";
import { parseZentaoRef } from "../domain/link.js";
import { renderRelatedBanner } from "../domain/render.js";
import { LifeSaverError, type LifeSaverService, type ReadOutcome } from "../service.js";
import { asEntityKind, asScope, compact, degradedText, wrapUntrusted } from "../tools/shared.js";
import type { ToolRunContext } from "./context.js";

export interface ReadToolOutput {
  kind: EntityKind;
  id: number;
  title: string;
  source: ChannelName;
  url?: string;
  degraded?: string;
  markdown: string;
  related?: { kind: EntityKind; id: number; title?: string; markdown: string }[];
  files?: { filename?: string; size?: number; localPath: string }[];
  notes: number;
  attachments: number;
}

/** 附件落盘目录：显式 outDir > 配置 output.dir > <工作区>/zentao-extract/<kind>-<id>。 */
function resolveOutDir(
  service: LifeSaverService,
  ctx: ToolRunContext,
  kind: string,
  id: number,
  outDir: unknown,
): string {
  if (typeof outDir === "string" && outDir.trim()) return outDir.trim();
  const configured = service.config().output.dir.trim();
  if (configured) return join(configured, `${kind}-${id}`);
  return join(ctx.cwd, "zentao-extract", `${kind}-${id}`);
}

export async function runReadTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<ReadToolOutput> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  // id 既可以是编号，也可以是用户直接粘过来的禅道链接——链接里自带的类型优先。
  const ref = parseZentaoRef(args.id);
  const kind = ref.kind ?? asEntityKind(args.kind);
  if (!kind) throw new LifeSaverError("bad-args", "参数 kind 只能是 story / task / bug");
  const id = ref.id;
  if (id === undefined) {
    throw new LifeSaverError(
      "bad-args",
      "没从 id 里认出编号：给个正整数（如 5967），或直接粘禅道链接（?m=bug&f=view&bugID=5967 / bug-view-5967.html）。",
    );
  }

  const limits = service.limits();
  const download = args.download === true;
  const attachmentDir = download ? resolveOutDir(service, ctx, kind, id, args.outDir) : undefined;

  const outcome = await service.read({
    kind,
    id,
    scope: asScope(args.scope),
    withAttachments: download,
    attachmentDir,
    maxAttachments: limits.maxAttachments,
    maxAttachmentBytes: limits.maxAttachmentBytes,
    signal: ctx.signal,
  });

  const includeRelated = args.includeRelated !== false;
  const related: ReadOutcome[] = includeRelated
    ? await service.relatedOf(outcome.envelope, limits.maxRelated, ctx.signal)
    : [];

  const entity = outcome.envelope.entity;
  const files = entity.attachments
    .filter((item) => item.localPath)
    .map((item) => ({ filename: item.filename, size: item.size, localPath: item.localPath as string }));

  return compact({
    kind,
    id,
    title: entity.title,
    source: outcome.envelope.source,
    url: entity.url,
    degraded: degradedText(outcome.degraded) || undefined,
    markdown: outcome.rendered,
    related: related.map((item) =>
      compact({
        kind: item.envelope.entity.kind,
        id: item.envelope.entity.id,
        title: item.envelope.entity.title,
        markdown: item.rendered,
      }),
    ),
    files: files.length > 0 ? files : undefined,
    notes: entity.notes.length,
    attachments: entity.attachments.length,
  });
}

/**
 * 渲染成正文。
 *
 * 关联对象各自带一段 banner 拼在后面，而不是塞进主实体的 markdown——
 * 这样模型能看出「这一段是隔壁那条需求的内容」，不会把两边的状态混着说。
 */
export function renderReadOutput(value: ReadToolOutput): string {
  const head = value.degraded ? `> ⚠️ ${value.degraded}\n\n` : "";
  const related = (value.related ?? [])
    .map((item) => renderRelatedBanner(`关联 ${item.kind} #${item.id}`, item.markdown ?? ""))
    .join("\n\n");
  const body = [head, value.markdown, related].filter(Boolean).join("\n\n");
  return wrapUntrusted(body);
}
