/**
 * zentao_read：把一条需求/任务/BUG 连正文、备注、操作记录、附件一起取出来。
 *
 * 这是插件的唯一主入口。默认不落盘附件（避免一次调用往工作区里塞几十兆），
 * 需要实体文件时把 download 打开，落盘路径会写回结果里。
 *
 * 描述、参数与取数逻辑都在 core（`life-saver-core`）：插件只提供「会话工作区在哪」
 * 与「结果长什么样」两件宿主相关的事。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  READ_SPEC,
  renderReadOutput,
  runReadTool,
  type LifeSaverService,
  type ReadToolOutput,
} from "life-saver-core";
import { cwdOf } from "./context.js";
import { parametersOf } from "./parameters.js";

export function createReadTool(service: LifeSaverService) {
  return defineTool({
    name: READ_SPEC.name,
    description: READ_SPEC.description,
    parameters: parametersOf(READ_SPEC),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          id: { type: "integer" },
          title: { type: "string" },
          source: { type: "string" },
          url: { type: "string" },
          degraded: { type: "string" },
          markdown: { type: "string" },
          related: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string" },
                id: { type: "integer" },
                title: { type: "string" },
                markdown: { type: "string" },
              },
            },
          },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                filename: { type: "string" },
                size: { type: "integer" },
                localPath: { type: "string" },
              },
            },
          },
          notes: { type: "integer" },
          attachments: { type: "integer" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: renderReadOutput(value as ReadToolOutput) }];
      },
    },

    async execute(rawArgs, exec) {
      return runReadTool(service, rawArgs, { signal: exec.signal, cwd: cwdOf(exec) });
    },
  });
}
