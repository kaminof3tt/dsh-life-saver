/**
 * 六个工具的规格（名字 / 中文描述 / 参数）。
 *
 * 两个壳都从这里取描述与参数表：DSH 插件翻译成 `defineTool({ parameters })`，
 * MCP 服务器翻译成 `inputSchema`。`zentao_session_start` 不在其中——它要宿主
 * 的 workspaceRegistry / sessionController，MCP 侧拿不到。
 */

export { BUGOP_SPEC } from "./bugop.js";
export { READ_SPEC } from "./read.js";
export { SEARCH_SPEC } from "./search.js";
export { STATUS_SPEC } from "./status.js";
export { TASKOP_SPEC } from "./taskop.js";
export { WORKHOURS_SPEC } from "./workhours.js";
export { jsonSchemaOf, parametersOf, requiredOf } from "./types.js";
export type { ToolPropertySpec, ToolPropertyType, ToolSpec } from "./types.js";

import { BUGOP_SPEC } from "./bugop.js";
import { READ_SPEC } from "./read.js";
import { SEARCH_SPEC } from "./search.js";
import { STATUS_SPEC } from "./status.js";
import { TASKOP_SPEC } from "./taskop.js";
import { WORKHOURS_SPEC } from "./workhours.js";
import type { ToolSpec } from "./types.js";

/** 按注册顺序排列：先读的，再搜的，再体检，最后才是会写数据的那几个。 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  READ_SPEC,
  SEARCH_SPEC,
  STATUS_SPEC,
  WORKHOURS_SPEC,
  TASKOP_SPEC,
  BUGOP_SPEC,
];
