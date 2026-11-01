/**
 * zentao_search：按关键词在需求/任务/BUG 里找编号。
 *
 * 用途很直接——用户说「上次那个登录超时的 BUG」，先这里搜出编号，再 zentao_read 取正文。
 * 命中只给编号/标题/状态/指派人，正文一律不在这里返回（避免一次塞满上下文）。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  SEARCH_SPEC,
  renderSearchOutput,
  runSearchTool,
  type LifeSaverService,
  type SearchToolOutput,
} from "life-saver-core";
import { parametersOf } from "./parameters.js";

export function createSearchTool(service: LifeSaverService) {
  return defineTool({
    name: SEARCH_SPEC.name,
    description: SEARCH_SPEC.description,
    parameters: parametersOf(SEARCH_SPEC),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          source: { type: "string" },
          degraded: { type: "string" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string" },
                id: { type: "integer" },
                title: { type: "string" },
                status: { type: "string" },
                assignedTo: { type: "string" },
              },
            },
          },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: renderSearchOutput(value as SearchToolOutput) }];
      },
    },

    async execute(rawArgs, exec) {
      return runSearchTool(service, rawArgs, { signal: exec.signal, cwd: process.cwd() });
    },
  });
}
