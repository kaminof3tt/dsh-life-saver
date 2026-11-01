/**
 * 工具执行上下文：两个壳各自能提供的最小环境。
 *
 * 插件能拿到会话 cwd（附件默认落盘在会话工作区下），MCP 只有进程 cwd——
 * 差别就收在这一个字段里，执行逻辑不分叉。
 */
export interface ToolRunContext {
  /** 取消信号（插件来自 exec.signal，MCP 来自客户端请求取消）。 */
  readonly signal?: AbortSignal;
  /** 工作区根目录：附件落盘与默认 outDir 的基准。 */
  readonly cwd: string;
}
