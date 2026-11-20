import { LifeSaverError } from "../service.js";
import { parseZentaoRef } from "../domain/link.js";
import { isEntityKind } from "../domain/model.js";
import { runCommit, type CommitRequest } from "../workspace/commit.js";
import type { ToolRunContext } from "./context.js";
import type { LifeSaverService } from "../service.js";

export interface CommitToolOutput {
  readonly markdown: string;
}

/**
 * 工具参数 → 提交请求。
 *
 * 两个壳（插件 / MCP）共用这一份归一化：编号可以贴链接、`files` 既可以给数组
 * （插件 schema 是数组）也可以给逗号分隔的字符串（老 MCP 客户端可能这么写）。
 */
export function commitRequestOf(rawArgs: unknown): CommitRequest {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const ref = parseZentaoRef(args.id);
  const kind = ref.kind ?? (isEntityKind(args.kind) ? args.kind : undefined);
  const id = ref.id;
  if (args.id !== undefined && id === undefined) {
    throw new LifeSaverError("bad-args", "没从 id 里认出编号：给个正整数（如 5967），或直接粘禅道链接。");
  }
  const files = typeof args.files === "string"
    ? args.files.split(/[,，;；]/).map((item) => item.trim()).filter((item) => item !== "")
    : Array.isArray(args.files)
      ? args.files.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : undefined;
  return {
    ...(kind === undefined || id === undefined ? {} : { kind, id }),
    ...(typeof args.repo === "string" && args.repo.trim() !== "" ? { repoPath: args.repo.trim() } : {}),
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    ...(typeof args.message === "string" && args.message.trim() !== "" ? { message: args.message } : {}),
    ...(args.dryRun === true ? { dryRun: true } : {}),
    ...(args.push === true ? { push: true } : {}),
  };
}

export async function runCommitTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<CommitToolOutput> {
  const result = await runCommit(commitRequestOf(rawArgs), {
    service,
    cwd: ctx.cwd,
    sessionId: ctx.sessionId ?? "default",
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  return { markdown: result.markdown };
}

export function renderCommitToolOutput(value: CommitToolOutput): string {
  return value.markdown;
}
