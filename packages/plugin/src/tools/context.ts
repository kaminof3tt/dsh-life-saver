/**
 * 从 `ToolRunContext` 里摸宿主现场的公共小工具。
 *
 * `cwd` 和会话 id 都不在 `ToolRunContext` 的类型里（宿主按实现透传，各版本位置还不太一样），
 * 所以统一在这里宽松取一遍，别处不要再各写一份 —— 取不到时的兜底策略必须只有一处。
 */

/** 会话所属工作区；全摸不到才退回进程 cwd，免得把文件写到宿主 profile 里。 */
export function cwdOf(exec: { agent?: unknown }): string {
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

/** 发起本次调用的会话 id；拿不到就是 undefined。 */
export function sessionIdOf(exec: { agent?: unknown }): string | undefined {
  const agent = exec.agent as { id?: unknown; session?: { id?: unknown; header?: { id?: unknown } } } | undefined;
  const candidates = [agent?.session?.id, agent?.session?.header?.id, agent?.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}
