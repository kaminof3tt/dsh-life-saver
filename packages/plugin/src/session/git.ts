/**
 * 仓库探测、补齐与同步。
 *
 * 三件事，按风险从低到高：
 *   1. 探测（只读）：分支、origin、脏不脏、目标分支在不在；
 *   2. 补齐：目录里压根没有仓库时，按配置的 git 地址 clone 一份；
 *   3. 同步：切到配置的分支并快进到远端最新。
 *
 * 第 3 步是「开新会话前先更新代码」这条硬规矩的落点：
 * 不更新就开工，改的可能是别人昨天已经改过的代码。
 *
 * 三条底线：**不**在脏工作区上切换/合并（先报错让人处理），
 * **不** force、**不** reset、**不** stash —— 一个插件没资格替人丢掉改动。
 */

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { primaryBranch, submoduleRule, type RepoRef } from "../domain/targets.js";

/** 单条 git 命令的超时：clone 大仓库要久一点。 */
const PROBE_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** 一个子模块的现场状态。 */
export interface SubmoduleState {
  /** 相对父仓库的路径（`git submodule status` 里那一列）。 */
  readonly path: string;
  /** 子模块当前分支；游离头（detached）时是 undefined。 */
  readonly branch?: string;
  /** 还没初始化（`git submodule status` 前面是 `-`）。 */
  readonly uninitialized?: boolean;
  /** 指针与父仓库记录的不一致（前面是 `+`）。 */
  readonly drifted?: boolean;
  /** 子模块自己有未提交改动。 */
  readonly dirty?: boolean;
  /** 未提交改动的条数。 */
  readonly dirtyCount?: number;
  /** 它应该在的分支：配了子模块分支就用配的，没配跟随父仓库。 */
  readonly target?: string;
  /** `target` 是从哪来的：`submodule` = 单独配的，`parent` = 跟随父仓库。 */
  readonly targetFrom?: "submodule" | "parent";
  /** 命中的配置键（`targetFrom === "submodule"` 时有值）；没配或没匹配上时没有。 */
  readonly matchedBy?: string;
}

/** 一条仓库的现场状态。 */
export interface RepoProbe {
  readonly role: string;
  /** 解析后的绝对路径。 */
  readonly path: string;
  /** 目录在不在。 */
  readonly exists: boolean;
  /** 是不是一个 git 工作树。 */
  readonly isRepo: boolean;
  /** 当前分支；游离头时为 HEAD 或空。 */
  readonly currentBranch?: string;
  /** `remote.origin.url`。 */
  readonly originUrl?: string;
  /**
   * 父仓库自身是否干净（不含子模块）。
   *
   * 必须用 `--ignore-submodules=all` 判：父子模块仓库里子模块指针漂移会输出
   * ` M acme-autonomy`，把它当成「人改的代码」会让这类仓库永远被判脏、永远不更新。
   */
  readonly dirty?: boolean;
  /** 父仓库自身改动/未跟踪文件的数量。 */
  readonly dirtyCount?: number;
  /** 这个仓库里有没有子模块。 */
  readonly hasSubmodules?: boolean;
  /** 子模块清单（含分支、脏不脏）。 */
  readonly submodules?: readonly SubmoduleState[];
  /** 期望分支在本地或远端是否存在。 */
  readonly branchExists?: boolean;
  /** 配置里写的地址与仓库实际 origin 是否一致。 */
  readonly originMatches?: boolean;
  /** 探测失败之类的人话说明。 */
  readonly note?: string;
}

/** 一次探测的汇总。 */
export interface ProbeReport {
  readonly root: string;
  readonly repos: readonly RepoProbe[];
  /** 需要 clone 才能用的仓库（配置了 gitUrl、但本地没有）。 */
  readonly missing: readonly RepoProbe[];
  /** 值得在提示词里提醒的状态（脏、分支不符、地址不符）。 */
  readonly warnings: readonly string[];
}

/** 仓库绝对路径：绝对路径直接用，相对路径挂到工作区根下。 */
export function resolveRepoPath(root: string, repo: RepoRef): string {
  return isAbsolute(repo.path) ? resolve(repo.path) : resolve(join(root, repo.path));
}

/**
 * 探测一个工作区下的全部仓库。
 *
 * `signal` 只控制「别再往下跑了」，已经发出去的 git 命令会自己超时。
 */
export async function probeRepos(
  root: string,
  repos: readonly RepoRef[],
  signal?: AbortSignal,
): Promise<ProbeReport> {
  const probed: RepoProbe[] = [];
  for (const repo of repos) {
    if (signal?.aborted === true) break;
    probed.push(await probeRepo(root, repo, signal));
  }
  const missing = probed.filter((item) => !item.isRepo && item.note !== "没有配置 git 地址，跳过");
  const warnings: string[] = [];
  for (const item of probed) {
    if (!item.isRepo) {
      warnings.push(
        item.note === "没有配置 git 地址，跳过"
          ? `${item.role}（${item.path}）目录不存在且没配 git 地址，无法自动补齐。`
          : `${item.role}（${item.path}）还没有 git 仓库：${item.note ?? "目录不存在或不是仓库"}。`,
      );
      continue;
    }
    if (item.dirty === true) warnings.push(`${item.role} 有 ${item.dirtyCount ?? "若干"} 处未提交的改动，注意别覆盖别人的工作。`);
    if (item.originMatches === false) warnings.push(`${item.role} 的 origin 与配置里写的地址不一致（实际：${item.originUrl ?? "无"}）。`);
    for (const sub of item.submodules ?? []) {
      if (sub.dirty === true) warnings.push(`${item.role} 的子模块 ${sub.path} 有 ${sub.dirtyCount ?? "若干"} 处未提交改动，更新时会跳过它。`);
      else if (sub.target !== undefined && sub.branch !== undefined && sub.branch !== sub.target) {
        const why = sub.targetFrom === "submodule" ? `配置里给它的分支（${sub.matchedBy ?? ""}）` : "父仓库的分支";
        warnings.push(`${item.role} 的子模块 ${sub.path} 在 ${sub.branch}，按${why}应该切到 ${sub.target}，更新时会切过去。`);
      }
    }
  }
  return { root, repos: probed, missing, warnings };
}

/** 探测单个仓库；任何一步失败都只记进 `note`，不抛。 */
export async function probeRepo(root: string, repo: RepoRef, signal?: AbortSignal): Promise<RepoProbe> {
  const path = resolveRepoPath(root, repo);
  const base = { role: repo.role, path };
  let exists = false;
  try {
    const info = await stat(path);
    exists = info.isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return repo.gitUrl === ""
      ? { ...base, exists: false, isRepo: false, note: "没有配置 git 地址，跳过" }
      : { ...base, exists: false, isRepo: false, note: "目录不存在，可按配置自动 clone" };
  }

  const inside = await git(path, ["rev-parse", "--is-inside-work-tree"], signal);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return repo.gitUrl === ""
      ? { ...base, exists: true, isRepo: false, note: "目录存在但不是 git 仓库，且没配 git 地址（不会动它）" }
      : { ...base, exists: true, isRepo: false, note: "目录存在但不是 git 仓库（目录非空，不会自动 clone 覆盖）" };
  }

  const [branchResult, urlResult, statusResult, submodules] = await Promise.all([
    git(path, ["rev-parse", "--abbrev-ref", "HEAD"], signal),
    git(path, ["config", "--get", "remote.origin.url"], signal),
    // 必须带 --ignore-submodules=all：否则子模块指针漂移（` M acme-autonomy`）会被当成
    // 人改的代码，父子模块仓库就永远被判脏、永远不更新。
    git(path, ["status", "--porcelain", "--ignore-submodules=all"], signal),
    readSubmodules(path, repo, signal),
  ]);
  const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
  const originUrl = urlResult.code === 0 ? urlResult.stdout.trim() : undefined;
  const dirtyCount = statusResult.code === 0 ? countLines(statusResult.stdout) : undefined;

  let branchExists: boolean | undefined;
  const primary = primaryBranch(repo);
  if (primary !== "") {
    const local = await git(path, ["rev-parse", "--verify", `refs/heads/${primary}`], signal);
    if (local.code === 0) branchExists = true;
    else {
      const remote = await git(path, ["rev-parse", "--verify", `refs/remotes/origin/${primary}`], signal);
      branchExists = remote.code === 0;
    }
  }

  return {
    ...base,
    exists: true,
    isRepo: true,
    ...(currentBranch !== undefined ? { currentBranch } : {}),
    ...(originUrl !== undefined ? { originUrl: redactUrl(originUrl) } : {}),
    ...(dirtyCount !== undefined ? { dirty: dirtyCount > 0, dirtyCount } : {}),
    ...(branchExists !== undefined ? { branchExists } : {}),
    ...(repo.gitUrl !== "" && originUrl !== undefined ? { originMatches: sameRemote(originUrl, repo.gitUrl) } : {}),
    ...(submodules.length > 0 ? { hasSubmodules: true, submodules } : {}),
  };
}

/**
 * 读一个仓库的子模块清单。
 *
 * 只读：`git submodule status` 拿路径与「是否初始化/指针是否漂移」，再对每个已初始化的
 * 子模块读一次它自己的分支与脏状态。空输出（没有子模块）返回空数组。
 *
 * 刻意不做 `git submodule update`：那会把人工切好的分支打成 detached HEAD。
 */
async function readSubmodules(
  path: string,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<readonly SubmoduleState[]> {
  const status = await git(path, ["submodule", "status"], signal);
  if (status.code !== 0) return [];
  const rows = status.stdout.split("\n").filter((line) => line.trim() !== "");
  if (rows.length === 0) return [];

  const parentPrimary = primaryBranch(repo);
  const found: SubmoduleState[] = [];
  for (const row of rows) {
    const parsed = parseSubmoduleRow(row);
    if (parsed === undefined) continue;
    const rule = submoduleRule(repo, parsed.path);
    const chain = rule?.branches ?? [];
    const target = chain[0] ?? parentPrimary;
    const targetFields =
      target === ""
        ? {}
        : {
            target,
            ...(chain.length > 0 ? { targetFrom: "submodule" as const } : { targetFrom: "parent" as const }),
            ...(rule !== undefined ? { matchedBy: rule.match } : {}),
          };
    if (parsed.uninitialized === true) {
      found.push({ path: parsed.path, uninitialized: true, ...targetFields });
      continue;
    }
    const subPath = resolve(join(path, parsed.path));
    const [branchResult, subStatus] = await Promise.all([
      git(subPath, ["rev-parse", "--abbrev-ref", "HEAD"], signal),
      git(subPath, ["status", "--porcelain"], signal),
    ]);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
    const subDirty = subStatus.code === 0 ? countLines(subStatus.stdout) : undefined;
    found.push({
      path: parsed.path,
      ...(branch !== "" && branch !== "HEAD" ? { branch } : {}),
      ...(parsed.drifted === true ? { drifted: true } : {}),
      ...(subDirty !== undefined ? { dirty: subDirty > 0, dirtyCount: subDirty } : {}),
      ...targetFields,
    });
  }
  return found;
}

/** 解析 `git submodule status` 的一行：`<前缀><sha> <路径> (<描述>)`。 */
function parseSubmoduleRow(row: string): { readonly path: string; readonly uninitialized?: boolean; readonly drifted?: boolean } | undefined {
  const flag = row.charAt(0);
  const uninitialized = flag === "-";
  const drifted = flag === "+";
  // 前缀只可能是 ' ' / '-' / '+' / 'U'；其余情况说明不是标准输出，整行当路径兜底。
  const body = flag === " " || uninitialized || drifted || flag === "U" ? row.slice(1) : row;
  const match = /^\S+\s+(.+?)(?:\s+\(.*\))?$/.exec(body.trim());
  const subPath = match?.[1]?.trim();
  if (subPath === undefined || subPath === "") return undefined;
  return { path: subPath, ...(uninitialized ? { uninitialized: true } : {}), ...(drifted ? { drifted: true } : {}) };
}

/**
 * 补齐一个缺失的仓库。
 *
 * 只在「目录不存在」或「目录存在但是空的」时动手；非空目录里没有仓库就报错不覆盖。
 */
export async function cloneRepo(
  root: string,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<{ readonly ok: boolean; readonly path: string; readonly message: string }> {
  const path = resolveRepoPath(root, repo);
  if (repo.gitUrl === "") {
    return { ok: false, path, message: `${repo.role} 没配 git 地址，无法自动补齐。` };
  }
  const probe = await probeRepo(root, repo, signal);
  if (probe.isRepo) return { ok: true, path, message: `${repo.role} 已就绪（${probe.currentBranch ?? "未知分支"}）。` };
  if (probe.exists) {
    return {
      ok: false,
      path,
      message: `${repo.role} 的目录 ${path} 已存在但不是 git 仓库（可能是别的项目或遗留文件），不自动覆盖。请人工确认后再试。`,
    };
  }

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    return { ok: false, path, message: `${repo.role} 创建上级目录失败：${messageOf(error)}` };
  }
  const primary = primaryBranch(repo);
  // 只拉序号最小的那条分支：改动永远落在它上面，其余分支到时按需 fetch。
  const args = primary === ""
    ? ["clone", repo.gitUrl, path]
    : ["clone", "--branch", primary, "--single-branch", repo.gitUrl, path];
  const result = await git(dirname(path), args, signal, CLONE_TIMEOUT_MS);
  if (result.code !== 0) {
    return { ok: false, path, message: `${repo.role} clone 失败：${redactUrl(firstErrorLine(result.stderr)) || redactUrl(firstErrorLine(result.stdout)) || `exit ${result.code}`}` };
  }
  // 父子模块仓库：clone 完把子模块拉下来（只按父仓库记录的提交初始化，不切分支）。
  const initialized = await initSubmodules(path, repo, signal);
  return {
    ok: true,
    path,
    message: `${repo.role} 已 clone 到 ${path}${primary === "" ? "" : `（分支 ${primary}）`}${initialized === "" ? "" : `，${initialized}`}。`,
  };
}

/** clone 之后按父仓库记录的提交初始化子模块；没有子模块就什么都不做。 */
async function initSubmodules(path: string, repo: RepoRef, signal?: AbortSignal): Promise<string> {
  const modules = await readSubmodules(path, repo, signal);
  if (modules.length === 0) return "";
  const result = await git(path, ["submodule", "update", "--init", "--recursive"], signal, CLONE_TIMEOUT_MS);
  if (result.code !== 0) return `子模块初始化失败（${firstErrorLine(result.stderr) || `exit ${result.code}`}），需要手动 git submodule update --init`;
  return `子模块 ${modules.length} 个已初始化（按父仓库记录的提交，未切分支）`;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 一个仓库的同步结果（补齐 + 切分支 + 快进）。 */
export interface RepoSync {
  readonly role: string;
  readonly path: string;
  /** 做了什么：cloned / switched / up-to-date / skipped。 */
  readonly action: "cloned" | "switched" | "updated" | "up-to-date" | "untouched" | "failed";
  readonly branch?: string;
  readonly message: string;
  /** 失败时的一句话原因，写进工具输出。 */
  readonly error?: string;
  /** 父子模块仓库里各子模块的处理结果。 */
  readonly submodules?: readonly SubmoduleSync[];
}

/** 一个子模块的同步结果。 */
export interface SubmoduleSync {
  readonly path: string;
  readonly branch?: string;
  /** updated / up-to-date：跟上了远端；switched：换了分支；skipped：没动；failed：出错了。 */
  readonly action: "updated" | "up-to-date" | "switched" | "skipped" | "failed";
  readonly message: string;
}

/**
 * 一次调用要做的事。
 *
 * - `clone`：目录里没有仓库时按配置补一份（用户明确要求「缺的就主动拉取」）；
 * - `update`：把仓库切到配置的分支并快进到远端最新（默认开，对应「开工前先更新代码」）。
 */
export interface SyncOptions {
  readonly clone: boolean;
  readonly update: boolean;
  readonly signal?: AbortSignal;
}

/**
 * 同步一个工作区下的全部仓库。
 *
 * 逐个来，不并发：clone 和 merge 都吃磁盘/网络，串行反而更好排错，
 * 而且第一条失败时后面的结果仍然完整。
 */
export async function syncRepos(
  root: string,
  repos: readonly RepoRef[],
  options: SyncOptions,
): Promise<{ readonly results: readonly RepoSync[]; readonly warnings: readonly string[] }> {
  const results: RepoSync[] = [];
  for (const repo of repos) {
    if (options.signal?.aborted === true) break;
    results.push(await syncRepo(root, repo, options));
  }
  const warnings = results.filter((item) => item.action === "failed").map((item) => `${item.role}：${item.error ?? item.message}`);
  for (const item of results) {
    for (const sub of item.submodules ?? []) {
      if (sub.action === "failed") warnings.push(`${item.role} 的子模块 ${sub.path}：${sub.message}`);
    }
  }
  return { results, warnings };
}

/** 同步单个仓库。任何失败都收进返回值，不抛。 */
export async function syncRepo(root: string, repo: RepoRef, options: SyncOptions): Promise<RepoSync> {
  const result = await syncRepoMain(root, repo, options);
  if (!options.update || result.action === "failed") return result;
  const submodules = await syncSubmodules(result.path, repo, options.signal);
  return submodules.length === 0 ? result : { ...result, submodules };
}

/**
 * 父仓库更新完之后，跟着更新子模块。
 *
 * 每个子模块的目标分支：
 * - 配置里按模糊匹配配了分支 → 用配的那条（园区前端：父仓库 `develop/v2.6.2`，
 *   子模块 `acme-web-admin` 实际在 `develop/v2.6.2-demo`，靠这条配）；
 * - 没配 → 跟随父仓库的序号 1 分支。
 *
 * 现场规则（一律不碰未提交的改动）：
 * - 有未提交改动 → 原样不动，只报告；
 * - 不在目标分支上 → 目标分支在本地或 origin 存在才切，切完再快进；不存在就原样不动并说明；
 * - 已经在目标分支上 → fetch + 只快进。
 *
 * 不下 `git submodule update`：那会把人工切好的分支打成 detached HEAD。
 */
async function syncSubmodules(
  path: string,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<readonly SubmoduleSync[]> {
  const modules = await readSubmodules(path, repo, signal);
  const results: SubmoduleSync[] = [];
  for (const sub of modules) {
    if (signal?.aborted === true) break;
    if (sub.uninitialized === true) {
      results.push({ path: sub.path, action: "skipped", message: "还没初始化（目录是空的），跳过；需要时手动 git submodule update --init。" });
      continue;
    }
    if (sub.dirty === true) {
      results.push({
        path: sub.path,
        ...(sub.branch !== undefined ? { branch: sub.branch } : {}),
        action: "skipped",
        message: `有 ${sub.dirtyCount ?? "若干"} 处未提交改动，原样不动（先提交再开工）。`,
      });
      continue;
    }

    const subPath = resolve(join(path, sub.path));
    const target = sub.target ?? "";

    // 没配分支、父仓库也没配分支：回到老行为——在哪个分支就快进哪个。
    if (target === "") {
      if (sub.branch === undefined) {
        results.push({ path: sub.path, action: "skipped", message: "处于游离头（detached），父仓库和它自己都没配分支，不猜，原样不动。" });
        continue;
      }
      const forwarded = await fastForward(subPath, sub.branch, signal);
      results.push({
        path: sub.path,
        branch: sub.branch,
        action: forwarded.ok ? (forwarded.changed ? "updated" : "up-to-date") : "failed",
        message: forwarded.message,
      });
      continue;
    }

    // 已经在目标分支上：直接快进。
    if (sub.branch === target) {
      const forwarded = await fastForward(subPath, target, signal);
      results.push({
        path: sub.path,
        branch: target,
        action: forwarded.ok ? (forwarded.changed ? "updated" : "up-to-date") : "failed",
        message: forwarded.message,
      });
      continue;
    }

    // 需要换分支：目标分支存在才切，不存在就别乱动。
    const reason = sub.targetFrom === "submodule" ? `按配置（${sub.matchedBy ?? ""}）` : "跟随父仓库";
    const switched = await checkoutBranch(subPath, target, signal);
    if (!switched.ok) {
      results.push({
        path: sub.path,
        ...(sub.branch !== undefined ? { branch: sub.branch } : {}),
        action: "skipped",
        message: `应该在 ${target}（${reason}），但这个分支在它本地和 origin 都不存在，原样不动。如果它本来就该用别的分支，在配置里给子模块单独写一条。`,
      });
      continue;
    }
    const forwarded = await fastForward(subPath, target, signal);
    results.push({
      path: sub.path,
      branch: target,
      action: forwarded.ok ? "switched" : "failed",
      message: `${switched.message}${forwarded.ok ? " " : " "}${forwarded.message}`,
    });
  }
  return results;
}

/** 同步主流程；子模块在 `syncRepo` 里补齐。 */
async function syncRepoMain(root: string, repo: RepoRef, options: SyncOptions): Promise<RepoSync> {
  const path = resolveRepoPath(root, repo);
  const base = { role: repo.role, path };
  let probe = await probeRepo(root, repo, options.signal);

  if (!probe.isRepo) {
    if (!options.clone) {
      return { ...base, action: "untouched", message: `${repo.role} 没有可用的仓库（自动补齐已关闭）：${probe.note ?? "未就绪"}` };
    }
    const cloned = await cloneRepo(root, repo, options.signal);
    if (!cloned.ok) return { ...base, action: "failed", message: cloned.message, error: cloned.message };
    probe = await probeRepo(root, repo, options.signal);
    const freshPrimary = primaryBranch(repo);
    if (options.update && freshPrimary !== "") {
      const updated = await fastForward(path, freshPrimary, options.signal);
      return {
        ...base,
        action: updated.ok ? "cloned" : "failed",
        branch: freshPrimary,
        message: `${cloned.message}${updated.ok ? "" : ` ${updated.message}`}`,
        ...(updated.ok ? {} : { error: updated.message }),
      };
    }
    return { ...base, action: "cloned", ...(probe.currentBranch !== undefined ? { branch: probe.currentBranch } : {}), message: cloned.message };
  }

  if (!options.update) {
    return { ...base, action: "untouched", message: `${repo.role} 已就绪（更新已关闭）。` };
  }

  const primary = primaryBranch(repo);
  const target = primary !== "" ? primary : probe.currentBranch ?? "";
  if (target === "") {
    return { ...base, action: "untouched", message: `${repo.role} 处于游离头状态且没配分支，跳过更新。` };
  }

  // 脏工作区不切分支、不合并：宁可停下来让人看清楚，也不要把改动卷进 merge。
  if (probe.dirty === true) {
    return {
      ...base,
      action: "untouched",
      branch: target,
      message: `${repo.role} 有 ${probe.dirtyCount ?? "若干"} 处未提交改动，跳过更新（先提交或 stash 再开工）。`,
    };
  }

  if (primary !== "" && probe.currentBranch !== primary) {
    const switched = await checkoutBranch(path, primary, options.signal);
    if (!switched.ok) {
      return { ...base, action: "failed", branch: primary, message: switched.message, error: switched.message };
    }
    const forwarded = await fastForward(path, primary, options.signal);
    return {
      ...base,
      action: forwarded.ok ? "switched" : "failed",
      branch: primary,
      message: `${switched.message}${forwarded.ok ? "" : ` ${forwarded.message}`}`,
      ...(forwarded.ok ? {} : { error: forwarded.message }),
    };
  }

  const forwarded = await fastForward(path, target, options.signal);
  return {
    ...base,
    action: forwarded.ok ? (forwarded.changed ? "updated" : "up-to-date") : "failed",
    branch: target,
    message: forwarded.message,
    ...(forwarded.ok ? {} : { error: forwarded.message }),
  };
}

/** 切到目标分支：本地有就直接切，只有远端有就建跟踪分支。 */
async function checkoutBranch(path: string, branch: string, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly message: string }> {
  const local = await git(path, ["rev-parse", "--verify", `refs/heads/${branch}`], signal);
  if (local.code === 0) {
    const switched = await git(path, ["checkout", branch], signal);
    if (switched.code !== 0) return { ok: false, message: `${branch} 切换失败：${firstErrorLine(switched.stderr)}` };
    return { ok: true, message: `已切换到 ${branch}。` };
  }
  const fetched = await git(path, ["fetch", "--prune", "origin"], signal, 120_000);
  if (fetched.code !== 0) return { ok: false, message: `fetch 失败：${firstErrorLine(fetched.stderr)}` };
  const remote = await git(path, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`], signal);
  if (remote.code !== 0) return { ok: false, message: `分支 ${branch} 在本地和 origin 都不存在。` };
  const created = await git(path, ["checkout", "-b", branch, `origin/${branch}`], signal);
  if (created.code !== 0) return { ok: false, message: `从 origin/${branch} 建分支失败：${firstErrorLine(created.stderr)}` };
  return { ok: true, message: `已从 origin/${branch} 建出 ${branch}。` };
}

/** fetch + 只快进合并；分叉就报错，绝不 merge 出个乱七八糟的历史。 */
async function fastForward(
  path: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: boolean; readonly changed: boolean; readonly message: string }> {
  const fetched = await git(path, ["fetch", "--prune", "origin"], signal, 120_000);
  if (fetched.code !== 0) return { ok: false, changed: false, message: `fetch 失败：${firstErrorLine(fetched.stderr)}` };
  const upstream = await git(path, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`], signal);
  if (upstream.code !== 0) return { ok: false, changed: false, message: `origin 上找不到分支 ${branch}，跳过更新。` };
  const before = await git(path, ["rev-parse", "HEAD"], signal);
  const merged = await git(path, ["merge", "--ff-only", `origin/${branch}`], signal, 120_000);
  if (merged.code !== 0) {
    return {
      ok: false,
      changed: false,
      message: `无法快进到 origin/${branch}（本地有分叉提交）：${firstErrorLine(merged.stderr) || firstErrorLine(merged.stdout)}`,
    };
  }
  const after = await git(path, ["rev-parse", "HEAD"], signal);
  const changed = before.code === 0 && after.code === 0 && before.stdout.trim() !== after.stdout.trim();
  return { ok: true, changed, message: changed ? `已更新到 origin/${branch} 最新。` : `已在 origin/${branch} 最新，无需更新。` };
}

/** 把地址里的凭据打掉：`https://user:pass@host/x.git` → `https://***@host/x.git`。 */
export function redactUrl(text: string): string {
  return text.replace(/([a-z+]+:\/\/)([^/@\s]*:[^/@\s]*@)/gi, "$1***@");
}

/** 跑一条 git 命令；不抛错，失败信息塞进结果里。 */
function git(cwd: string, args: readonly string[], signal?: AbortSignal, timeout = PROBE_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        ...(signal !== undefined ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
        resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error === null ? "" : error.message) });
      },
    );
  });
}

/** 判断两个远端地址是否指向同一个仓库：忽略协议差异与结尾 `.git` / 斜杠。 */
function sameRemote(left: string, right: string): boolean {
  return simplifyRemote(left) === simplifyRemote(right);
}

function simplifyRemote(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/**
 * 取第一行有意义的信息（跳过 git 的 hint 提示，它们对调用方是噪音）。
 *
 * 顺手打码：这些文案会经 `RepoSync.message` 拼进会话开场提示词并被持久化，
 * git 的报错里常常整条回显 remote 地址，带 `user:pass@` 时会直接把密码写进聊天记录。
 */
function firstErrorLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return redactUrl(lines.find((line) => !line.startsWith("hint:")) ?? lines[0] ?? "");
}

/** 数行数（`git status --porcelain` 那种一行一条的输出）。 */
function countLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
