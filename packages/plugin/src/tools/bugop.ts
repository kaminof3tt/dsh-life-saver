/**
 * zentao_bug_op：确认 / 解决 / 关闭 BUG，或只加一条备注。
 *
 * 和 zentao_task_op 一样**会真的写入**，没有预览。护栏在 service 层，
 * 参数归一化与渲染在 core。
 *
 * 动作与禅道页面一一对应（语义对齐 module/bug/model.php）：
 *   confirm  确认 BUG（只改 confirmed=1 与 assignedDate，不解决、不发通知）
 *   resolve  解决 BUG（必须给 resolution；fixed 还要 resolvedBuild，duplicate 还要 duplicateBug）
 *   close    关闭 BUG（禅道流程里通常是测试确认后再关）
 *   comment  只加一条备注
 *   recordworkhour  记一条「日志」（工时）；同一条 BUG 可以记多条，累计相加
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  BUGOP_SPEC,
  renderBugOpOutput,
  runBugOpTool,
  type LifeSaverService,
  type WriteToolOutput,
} from "life-saver-core";
import { parametersOf } from "./parameters.js";

export function createBugOpTool(service: LifeSaverService) {
  return defineTool({
    name: BUGOP_SPEC.name,
    description: BUGOP_SPEC.description,
    parameters: parametersOf(BUGOP_SPEC),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string" },
          kind: { type: "string" },
          id: { type: "integer" },
          action: { type: "string" },
          actionName: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          message: { type: "string" },
          warnings: { type: "array", items: { type: "string" } },
          degraded: { type: "string" },
          markdown: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: renderBugOpOutput(value as WriteToolOutput) }];
      },
    },

    async execute(rawArgs, exec) {
      return runBugOpTool(service, rawArgs, { signal: exec.signal, cwd: process.cwd() });
    },
  });
}
