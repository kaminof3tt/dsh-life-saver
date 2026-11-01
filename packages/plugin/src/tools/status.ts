/**
 * zentao_status：体检。配了没、连得上吗、两条通道各自能干什么。
 *
 * 排障时的第一条命令。刻意不返回任何密码，只回「有没有配」。
 * 文案在 core 里，与 MCP 服务器共用——两边对「能不能用」的说法必须一致。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  STATUS_SPEC,
  renderStatusOutput,
  runStatusTool,
  type LifeSaverService,
  type StatusToolOutput,
} from "life-saver-core";
import { parametersOf } from "./parameters.js";

export function createStatusTool(service: LifeSaverService) {
  return defineTool({
    name: STATUS_SPEC.name,
    description: STATUS_SPEC.description,
    parameters: parametersOf(STATUS_SPEC),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
          reachable: { type: "boolean" },
          markdown: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: renderStatusOutput(value as StatusToolOutput) }];
      },
    },

    async execute(_args, exec) {
      return runStatusTool(service, { signal: exec.signal, cwd: process.cwd() });
    },
  });
}
