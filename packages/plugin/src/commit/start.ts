/**
 * 开工记账：会话建好之后，立刻在每个仓库里记下「这张单子」和「开工那一刻的脏文件清单」。
 *
 * 为什么要记基线：`zentao_commit` 默认只提交「开工之后新出现的改动」。开工前就已经脏着的
 * 文件（上个会话留下的、用户自己改了一半的）不能算这次会话的功劳，记下来才能扣掉。
 *
 * 复用旧会话时不覆盖已有基线——那份基线才是「这轮工作真正开始」的位置，覆盖了就等于
 * 把老会话攒的改动重新算成新的。
 */

import { messageOf } from "life-saver-core/tools/shared.js";
import { gitDirOf, parsePorcelainZ, runGit } from "./git.js";
import { readState, writeState, type TicketBinding } from "./store.js";

export interface WorkStartRepo {
  /** 仓库的绝对路径。 */
  readonly path: string;
}

export interface WorkStartOptions {
  readonly repos: readonly WorkStartRepo[];
  readonly ticket: Omit<TicketBinding, "at">;
  readonly sessionId: string;
  /** 已有基线时是否覆盖（新会话 true，复用旧会话 false）。 */
  readonly overwriteBaseline: boolean;
  readonly signal?: AbortSignal;
}

/** 取 HEAD sha；失败回 undefined。 */
async function headOf(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const run = await runGit(cwd, ["rev-parse", "HEAD"], signal === undefined ? {} : { signal });
  const value = run.stdout.trim();
  return run.code === 0 && value !== "" ? value : undefined;
}

/** 当前脏文件（相对仓库根）。 */
async function dirtyOf(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const run = await runGit(
    cwd,
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    signal === undefined ? {} : { signal },
  );
  return run.code === 0 ? parsePorcelainZ(run.stdout) : [];
}

/**
 * 给每个仓库写一份开工记账。返回需要提示用户的事项（都不是致命错误——
 * 记账失败不该挡住开工，只是这次会话的提交会退化成「必须显式给 files」）。
 */
export async function recordWorkStart(options: WorkStartOptions): Promise<string[]> {
  const warnings: string[] = [];
  const now = new Date().toISOString();
  const ticket: TicketBinding = { ...options.ticket, at: now };

  for (const repo of options.repos) {
    try {
      const gitDir = await gitDirOf(repo.path, options.signal);
      if (gitDir === undefined) {
        warnings.push(`${repo.path} 不是 git 仓库（或取不到 .git），这个目录没有记开工基线。`);
        continue;
      }
      const state = await readState(gitDir, options.sessionId);
      if (state.baseline !== undefined && !options.overwriteBaseline) {
        // 复用旧会话：只补单子信息，基线保持原样。
        await writeState(gitDir, options.sessionId, { ticket });
        continue;
      }
      const [head, dirty] = await Promise.all([headOf(repo.path, options.signal), dirtyOf(repo.path, options.signal)]);
      if (head === undefined) {
        warnings.push(`${repo.path} 取不到 HEAD（可能还没有提交），这个目录没有记开工基线。`);
        await writeState(gitDir, options.sessionId, { ticket });
        continue;
      }
      await writeState(gitDir, options.sessionId, { ticket, baseline: { head, dirty, at: now } });
    } catch (error) {
      warnings.push(`${repo.path} 记开工现场失败：${messageOf(error)}`);
    }
  }

  return warnings;
}
