import type { ToolSpec } from "./types.js";

/** zentao_search：按关键词找编号。正文一律不在这里给。 */
export const SEARCH_SPEC: ToolSpec = {
  name: "zentao_search",
  description:
    "在禅道的需求(story)/任务(task)/BUG(bug)里按关键词搜索，返回编号与标题。" +
    "只用于找到编号，正文请接着用 zentao_read 读。",
  properties: {
    query: {
      type: "string",
      description: "关键词，会同时匹配标题；支持中文。",
      required: true,
    },
    kind: {
      type: "string",
      enum: ["story", "task", "bug"],
      description: "只搜某一类；不填则三类一起搜。",
    },
    limit: {
      type: "integer",
      description: "最多返回多少条（默认 10，上限 50）。",
    },
  },
};
