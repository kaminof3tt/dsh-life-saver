/**
 * zentao_task_op：改一个任务的状态/工时/备注。
 *
 * 这个工具**会真的写禅道**——没有 dry-run。所有保险都放在 service 层：
 * 先读后写、状态白名单、归属校验、expectStatus 断言、写后回读自校验，
 * 并且只接受单条操作。参数归一化与结果渲染在 core，插件只做注册。
 *
 * 动作与禅道页面一一对应，语义已逐句对齐 module/task/model.php：
 *   start          开始（left=0 时禅道会直接判完成）
 *   recordworkhour 记录工时（不改状态，除非 left 归零或原来是 wait/pause）
 *   finish         完成（本次工时可为 0，但那样不会生成工时记录）
 *   pause          暂停
 *   activate       激活（把已完成/已取消/已关闭的任务重新拉回进行中）
 *   close          关闭（只能关「已完成」或「已取消」的）
 *   cancel         取消
 *   comment        只加一条备注，什么都不改
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  TASKOP_SPEC,
  renderTaskOpOutput,
  runTaskOpTool,
  type LifeSaverService,
  type WriteToolOutput,
} from "life-saver-core";
import { parametersOf } from "./parameters.js";

export function createTaskOpTool(service: LifeSaverService) {
  return defineTool({
    name: TASKOP_SPEC.name,
    description: TASKOP_SPEC.description,
    parameters: parametersOf(TASKOP_SPEC),
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
        return [{ type: "text", text: renderTaskOpOutput(value as WriteToolOutput) }];
      },
    },

    async execute(rawArgs, exec) {
      return runTaskOpTool(service, rawArgs, { signal: exec.signal, cwd: process.cwd() });
    },
  });
}
