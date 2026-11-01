/**
 * 工具的执行与渲染（框架无关）。
 *
 * 这一层是「两个壳共用的那一半」：参数归一化、降级提示、关联对象拼装、
 * markdown 排版全在这里。壳只做两件事——把 spec 注册成自己的格式，
 * 把这里返回的 markdown 包成自己的返回类型（DSH 的 output.render / MCP 的 content blocks）。
 */

export {
  BUGOP_SPEC,
  READ_SPEC,
  SEARCH_SPEC,
  STATUS_SPEC,
  TASKOP_SPEC,
  TOOL_SPECS,
  WORKHOURS_SPEC,
  jsonSchemaOf,
  parametersOf,
  requiredOf,
} from "../specs/index.js";
export type { ToolPropertySpec, ToolPropertyType, ToolSpec } from "../specs/index.js";

export { renderBugOpOutput, runBugOpTool } from "./bugop.js";
export type { ToolRunContext } from "./context.js";
export { renderReadOutput, runReadTool, type ReadToolOutput } from "./read.js";
export { renderSearchOutput, runSearchTool, type SearchToolOutput } from "./search.js";
export { renderStatusMarkdown, renderStatusOutput, runStatusTool, type StatusToolOutput } from "./status.js";
export { renderTaskOpOutput, runTaskOpTool } from "./taskop.js";
export {
  renderWorkhoursOutput,
  renderWorklogReport,
  runWorkhoursTool,
  type WorkhoursToolOutput,
} from "./workhours.js";
