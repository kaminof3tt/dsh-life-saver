import { LifeSaverError, type LifeSaverService } from "../service.js";
import { parseZentaoRef } from "../domain/link.js";
import { isEntityKind } from "../domain/model.js";
import { runWorkStart } from "../workspace/work-start.js";
import type { ToolRunContext } from "./context.js";

export interface WorkStartToolOutput {
  readonly markdown: string;
}

export async function runWorkStartTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<WorkStartToolOutput> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const ref = parseZentaoRef(args.id);
  const kind = ref.kind ?? (isEntityKind(args.kind) ? args.kind : undefined);
  if (kind === undefined) throw new LifeSaverError("bad-args", "参数 kind 只能是 story / task / bug");
  const id = ref.id;
  if (id === undefined) throw new LifeSaverError("bad-args", "没从 id 里认出编号：给个正整数（如 5967），或直接粘禅道链接。");
  const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : ctx.sessionId;
  if (sessionId === undefined || sessionId === "") {
    throw new LifeSaverError("bad-args", "缺少 sessionId：MCP 客户端没有稳定会话 id 时给一个人工标识；同一任务一直用同一个值。");
  }
  const result = await runWorkStart(
    {
      kind,
      id,
      ...(typeof args.targetId === "string" && args.targetId.trim() !== "" ? { targetId: args.targetId.trim() } : {}),
      ...(args.cloneMissing === false ? { cloneMissing: false } : {}),
      ...(args.update === false ? { update: false } : {}),
      ...(args.dryRun === true ? { dryRun: true } : {}),
    },
    { service, sessionId, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) },
  );
  return { markdown: result.markdown };
}

export function renderWorkStartToolOutput(value: WorkStartToolOutput): string {
  return value.markdown;
}
