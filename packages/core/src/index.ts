/**
 * `life-saver-core` 的公开入口。
 *
 * 两个壳（DSH 插件 / MCP 服务器）都从这里取服务与类型；壳自己不该再拼
 * 「哪几个文件能 import」的知识。深路径导出（`life-saver-core/channels/write.js`
 * 之类）仍然可用，因为工具层与桥接层确实需要更细的粒度，但**新代码优先走这里**：
 * 一旦某个符号被壳依赖，把它写进本文件，才能保证以后挪文件不至于静默断链。
 */

export {
  LifeSaverService,
  LifeSaverError,
  type ChannelHealth,
  type DiscoveryStatus,
  type ReadOptions,
  type ReadOutcome,
  type SearchOutcome,
  type ServiceDeps,
  type StatusOutcome,
  type WriteResult,
} from "./service.js";

export {
  Config,
  SECRET_REFS,
  SETTINGS_NAMESPACE,
  applyOverrides,
  channelSignature,
  normalizeBaseUrl,
  readSecretsFromEnv,
  resolveMode,
  unwrapConfig,
  type ChannelMode,
  type LifeSaverConfig,
  type Secrets,
} from "./config.js";

export {
  ACTION_LABELS,
  BUG_ACTIONS,
  RESOLUTIONS,
  TASK_ACTIONS,
  type BugWriteAction,
  type Resolution,
  type TaskWriteAction,
  type WriteAction,
  type WriteKind,
  type WriteRequest,
  type WriteSnapshot,
  type WriteOutcome,
} from "./channels/write.js";

export {
  ChannelError,
  supportsWrite,
  type Channel,
  type ChannelCaps,
  type ProbeResult,
  type ReadRequest,
  type SearchHit,
  type SearchRequest,
} from "./channels/types.js";

export {
  ENTITY_KINDS,
  isEntityKind,
  type Entity,
  type EntityKind,
  type Note,
  type Attachment,
} from "./domain/model.js";

export { renderEntity } from "./domain/render.js";

export {
  asEntityKind,
  asEnum,
  asNumber,
  asScope,
  asText,
  clampLimit,
  compact,
  degradedNote,
  degradedText,
  messageOf,
  renderWriteOutcome,
  sourceLabel,
  wrapUntrusted,
  type WriteToolOutput,
} from "./tools/shared.js";

/**
 * 工具规格 + 执行：两个壳（插件 / MCP）共用的那一半。
 *
 * 壳不该自己再写一遍中文描述或「怎么取一条 BUG」——改一次忘一次，模型看到
 * 两套说法。这里给出的是 { 名字, 描述, 参数表 } 与 { 执行, 渲染 }。
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
  renderBugOpOutput,
  renderReadOutput,
  renderSearchOutput,
  renderStatusMarkdown,
  renderStatusOutput,
  renderTaskOpOutput,
  renderWorkhoursOutput,
  renderWorklogReport,
  runBugOpTool,
  runReadTool,
  runSearchTool,
  runStatusTool,
  runTaskOpTool,
  runWorkhoursTool,
  type ReadToolOutput,
  type SearchToolOutput,
  type StatusToolOutput,
  type ToolPropertySpec,
  type ToolPropertyType,
  type ToolRunContext,
  type ToolSpec,
  type WorkhoursToolOutput,
} from "./ops/index.js";
