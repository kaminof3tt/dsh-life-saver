/**
 * zentao_bug_op 的执行：确认 / 解决 / 关闭 BUG、加备注、记日志工时。
 *
 * 和 zentao_task_op 一样**会真的写入**，没有预览。护栏在 service 层；
 * 这里额外挡掉三种「参数本身就不成立」的调用：记日志缺工时/缺说明、解决缺方式。
 */

import { BUG_ACTIONS, RESOLUTIONS, type WriteRequest } from "../channels/write.js";
import { parseZentaoRef } from "../domain/link.js";
import { LifeSaverError, type LifeSaverService } from "../service.js";
import { asEnum, asNumber, asText, compact, renderWriteOutcome, type WriteToolOutput } from "../tools/shared.js";
import type { ToolRunContext } from "./context.js";

export async function runBugOpTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<WriteToolOutput> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const ref = parseZentaoRef(args.id);
  if (ref.kind !== undefined && ref.kind !== "bug") {
    throw new LifeSaverError("bad-args", `这是一条 ${ref.kind} 链接，不是 BUG；请用对应的工具`);
  }
  const id = ref.id;
  if (id === undefined || id <= 0) {
    throw new LifeSaverError("bad-args", "参数 id 必须是 BUG 编号，或一条禅道 BUG 链接");
  }

  const action = asEnum(args.action, BUG_ACTIONS);
  const comment = asText(args.comment);
  const resolution = asText(args.resolution);
  const consumed = asNumber(args.consumed, "consumed");

  if (action === "recordworkhour") {
    if (consumed === undefined || consumed <= 0) {
      throw new LifeSaverError("bad-args", "记日志（工时）必须给大于 0 的 consumed，例如 consumed=1.5");
    }
    if (comment === undefined) {
      throw new LifeSaverError("bad-args", "记日志必须给 comment（禅道这个表单的『工作内容』是必填项）");
    }
  }
  if (action === "resolve" && resolution === undefined) {
    throw new LifeSaverError("bad-args", `解决 BUG 必须给 resolution，可选：${RESOLUTIONS.join(" / ")}`);
  }

  const request = compact({
    kind: "bug" as const,
    id,
    action,
    signal: ctx.signal,
    comment,
    resolution,
    resolvedBuild: asText(args.resolvedBuild),
    duplicateBug: asNumber(args.duplicateBug, "duplicateBug"),
    consumed,
    date: asText(args.date),
    assignedTo: asText(args.assignedTo),
    expectStatus: asText(args.expectStatus),
  }) as WriteRequest;

  const result = await service.write(request);
  return renderWriteOutcome("BUG", result, (value) =>
    [
      `状态=${value.status || "—"}`,
      `指派=${value.assignedTo || "—"}`,
      `已确认=${value.confirmed === undefined ? "—" : value.confirmed ? "是" : "否"}`,
      `解决方案=${value.resolution || "—"}`,
    ].join(" · "),
  );
}

export function renderBugOpOutput(value: WriteToolOutput): string {
  return value.markdown ?? "";
}
