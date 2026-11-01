import type { ToolSpec } from "./types.js";

/** zentao_workhours：任意区间的工时事实。只读。 */
export const WORKHOURS_SPEC: ToolSpec = {
  name: "zentao_workhours",
  description:
    "统计某个禅道账号在指定时间段内做了哪些工作、消耗多少工时（不限于一周，任意区间）。" +
    "数据来自库里的工时表，按对象聚合，并列出「有动作但没记工时」的漏项。只读，不改任何数据。",
  properties: {
    from: {
      type: "string",
      description: "开始日期 YYYY-MM-DD（含当天）。",
      required: true,
    },
    to: {
      type: "string",
      description: "结束日期 YYYY-MM-DD（含当天）。只查一天就让 from=to。",
      required: true,
    },
    account: {
      type: "string",
      description: "禅道账号；不填则用配置里的默认账号。",
    },
    kind: {
      type: "string",
      enum: ["story", "task", "bug"],
      description: "只看某一类对象；不填三类都算。",
    },
    detail: {
      type: "boolean",
      description: "是否展开逐条工时明细（默认只给按对象汇总）。",
    },
    limit: {
      type: "integer",
      description: "最多展示多少个对象（默认 30，上限 50）；超出会在说明里提示。",
    },
  },
};
