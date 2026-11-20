/**
 * 提交用的 git 原语。
 *
 * 与 `session/git.ts` 的区别只有一点：这里允许注入环境变量（`GIT_INDEX_FILE`），
 * 整个「并行会话互不干扰」的机制就靠它——每个会话用自己的索引文件，
 * 谁 `git add` 了什么都只落在自己的索引里，`git commit` 也只认自己的索引。
 */

import { execFile } from "node:child_process";

/** 一条 git 命令的结果；失败不抛错，信息塞进结果里。 */
export interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 提交这类操作可能很慢（大仓库、钩子），给足时间。 */
const GIT_TIMEOUT_MS = 120_000;

/**
 * 跑一条 git 命令。
 *
 * `env` 会叠在 `process.env` 之上；`GIT_INDEX_FILE` 一给，这条命令看到的索引
 * 就是那个私有文件，默认索引（别的会话正在用的）完全不受影响。
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly env?: Record<string, string> } = {},
): Promise<GitRun> {
  const env = options.env === undefined ? process.env : { ...process.env, ...options.env };
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        env,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
        resolvePromise({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (error === null ? "" : error.message),
        });
      },
    );
  });
}

/** 取第一行有意义的信息（跳过 git 的 hint 噪音）。 */
export function firstLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.find((line) => !line.startsWith("hint:")) ?? lines[0] ?? "";
}

/**
 * 解析 `git status --porcelain -z` 的输出，返回仓库相对路径（正斜杠）的集合。
 *
 * `-z` 下重命名条目是 `XY 旧路径\0新路径\0`——两个路径都要吃掉，否则会把新路径
 * 当成一条独立记录，下一次解析全错位。
 */
export function parsePorcelainZ(raw: string): string[] {
  const parts = raw.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry === undefined || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const renamed = status.includes("R") || status.includes("C");
    if (renamed) {
      // 旧路径跳过，只记新路径。
      index += 1;
      if (path !== "") paths.push(path);
      continue;
    }
    if (path !== "") paths.push(path);
  }
  return paths;
}

/** 取分支名；游离头时回 `HEAD`。 */
export async function currentBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const run = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal === undefined ? {} : { signal });
  const value = run.stdout.trim();
  return value === "" ? "HEAD" : value;
}

/** 仓库的 git 目录；不是仓库或取不到时回 undefined（调用方当「跳过」处理）。 */
export async function gitDirOf(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const run = await runGit(cwd, ["rev-parse", "--absolute-git-dir"], signal === undefined ? {} : { signal });
  const value = run.stdout.trim();
  return run.code === 0 && value !== "" ? value : undefined;
}
