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
import { parametersOf } from "./parameters.js";

/**
 * 会话所属工作区：交互会话的 cwd 挂在 `session.header.cwd` 上（宿主按它校验
 * 会话归属哪个工作区）；`agent.meta.cwd` 只有声明式 agent 才有。这两个在
 * `ToolRunContext` 的类型里都没有，运行期才摸得到，所以宽松取一遍；
 * 全摸不到才退回进程 cwd，免得把文件写到宿主 profile 里。
 */
function cwdOf(exec: { agent?: unknown }): string {
  const agent = exec.agent as
    | {
        meta?: { cwd?: string };
        cwd?: string;
        workingDirectory?: string;
        session?: { cwd?: string; header?: { cwd?: string } };
      }
    | undefined;
  const candidates = [
    agent?.session?.header?.cwd,
    agent?.meta?.cwd,
    agent?.session?.cwd,
    agent?.cwd,
    agent?.workingDirectory,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return process.cwd();
}

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
