/**
 * zentao_workhours：统计某人在任意时段内做了哪些事、消耗多少工时。
 *
 * 不是「周报生成器」，是「把区间内的工时事实取出来」：明细、按对象汇总、
 * 逐日汇总，外加一份「有动作但没记工时」的漏项提醒。
 * 想写成周报/月报/项目小结，拿这里的结构化结果再去组织文字即可。
 *
 * 口径与渲染都在 core：`zt_effort` 是唯一按人来源，不能用 zt_task.consumed 汇总。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  WORKHOURS_SPEC,
  renderWorkhoursOutput,
  runWorkhoursTool,
  type LifeSaverService,
  type WorkhoursToolOutput,
} from "life-saver-core";
import { parametersOf } from "./parameters.js";

export function createWorkhoursTool(service: LifeSaverService) {
  return defineTool({
    name: WORKHOURS_SPEC.name,
    description: WORKHOURS_SPEC.description,
    parameters: parametersOf(WORKHOURS_SPEC),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          total: { type: "number" },
          markdown: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: renderWorkhoursOutput(value as WorkhoursToolOutput) }];
      },
    },

    async execute(rawArgs, exec) {
      return runWorkhoursTool(service, rawArgs, { signal: exec.signal, cwd: process.cwd() });
    },
  });
}
