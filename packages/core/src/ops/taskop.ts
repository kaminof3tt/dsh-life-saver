/**
 * zentao_task_op 的执行：参数归一化 + 调 service.write + 结果渲染。
 *
 * 这个工具**会真的写禅道**——没有 dry-run。所有保险都在 service 层：
 * 先读后写、状态白名单、归属校验、expectStatus 断言、写后回读自校验，
 * 并且只接受单条操作。这里只负责「把参数收干净」和「把结果说清楚」。
 */

import { TASK_ACTIONS, type WriteRequest } from "../channels/write.js";
import { parseZentaoRef } from "../domain/link.js";
import { LifeSaverError, type LifeSaverService } from "../service.js";
import { asEnum, asNumber, asText, compact, renderWriteOutcome, type WriteToolOutput } from "../tools/shared.js";
import type { ToolRunContext } from "./context.js";

export async function runTaskOpTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<WriteToolOutput> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const ref = parseZentaoRef(args.id);
  if (ref.kind !== undefined && ref.kind !== "task") {
    throw new LifeSaverError("bad-args", `这是一条 ${ref.kind} 链接，不是任务；请用对应的工具`);
  }
  const id = ref.id;
  if (id === undefined || id <= 0) {
    throw new LifeSaverError("bad-args", "参数 id 必须是任务编号，或一条禅道任务链接");
  }

  const request = compact({
    kind: "task" as const,
    id,
    action: asEnum(args.action, TASK_ACTIONS),
    signal: ctx.signal,
    comment: asText(args.comment),
    consumed: asNumber(args.consumed, "consumed"),
    left: asNumber(args.left, "left"),
    date: asText(args.date),
    realStarted: asText(args.realStarted),
    finishedDate: asText(args.finishedDate),
    assignedTo: asText(args.assignedTo),
    expectStatus: asText(args.expectStatus),
  }) as WriteRequest;

  const result = await service.write(request);
  return renderWriteOutcome("任务", result, (value) =>
    `状态=${value.status || "—"} · 指派=${value.assignedTo || "—"} · 已消耗=${value.consumed} · 剩余=${value.left}`,
  );
}

export function renderTaskOpOutput(value: WriteToolOutput): string {
  return value.markdown ?? "";
}
