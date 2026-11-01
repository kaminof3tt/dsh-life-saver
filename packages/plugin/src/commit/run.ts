/**
 * zentao_commit：把「这次对话的改动」提交成一条带禅道单子信息的提交。
 *
 * 解决两件事：
 *   1. 提交备注固定两行 —— 第一行「类型 #编号 标题」，第二行禅道链接，不用手写；
 *   2. 只提交本次对话动过的文件 —— 靠「私有索引 + 基线差集」，不吃进并行会话
 *      正在改、或者开工前就脏着的文件。
 *
 * 私有索引是关键：`GIT_INDEX_FILE` 指向 `.git/life-saver/index-<会话>.json` 的兄弟文件后，
 * 这个会话 `git add` 的落点、`git commit` 读的索引都跟别人无关。别人把文件 `git add`
 * 进了默认索引，我不会替他提交；我提交的树也不会因为默认索引里有什么而变。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { EntityKind } from "life-saver-core/domain/model.js";
import { LifeSaverError, type LifeSaverService } from "life-saver-core/service.js";
import { currentBranch, firstLine, parsePorcelainZ, runGit } from "./git.js";
import { readState, otherSessions, sessionKeyOf, writeState, type RepoBaseline, type TicketBinding } from "./store.js";

/** 一次提交的入参（已从工具参数里洗过）。 */
export interface CommitRequest {
  readonly kind?: EntityKind;
  readonly id?: number;
  /** 仓库目录；不给就用会话 cwd。 */
  readonly repoPath?: string;
  /** 要提交的文件（相对 cwd 或绝对路径）；不给就用基线差集。 */
  readonly files?: readonly string[];
  /** 自定义提交信息；不给就按单子自动生成两行。 */
  readonly message?: string;
  readonly dryRun?: boolean;
  readonly push?: boolean;
}

/** 执行一次提交需要的上下文。 */
export interface CommitDeps {
  readonly service: LifeSaverService;
  /** 会话工作区（用来解析相对路径、定位仓库）。 */
  readonly cwd: string;
  /** 宿主会话 id；拿不到时是 `default`。 */
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

/** 提交结果（工具输出就是它的子集）。 */
export interface CommitOutput {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly repo: string;
  readonly branch: string;
  readonly sha?: string;
  readonly subject?: string;
  readonly link?: string;
  readonly files: readonly string[];
  /** 因为不属于本次对话而被挡下的文件（开工前就脏的）。 */
  readonly heldBack: readonly string[];
  /** 默认索引里别人暂存的文件：列出来证明没被带进这次提交。 */
  readonly stagedElsewhere: readonly string[];
  readonly warnings: readonly string[];
  readonly dryRun: boolean;
  readonly pushed?: boolean;
  readonly pushMessage?: string;
  readonly markdown: string;
}

const TYPE_WORDS: Record<EntityKind, string> = { story: "需求", task: "任务", bug: "BUG" };

/** 把一条单子变成 message 的两行。 */
export function commitMessageOf(ticket: TicketBinding): { subject: string; link?: string } {
  const subject = `${TYPE_WORDS[ticket.kind]} #${ticket.id} ${ticket.title}`.trim();
  const link = ticket.url?.trim();
  return link === undefined || link === "" ? { subject } : { subject, link };
}

/** 定位仓库根与 git 目录。 */
async function resolveRepo(
  cwd: string,
  repoPath: string | undefined,
  signal?: AbortSignal,
): Promise<{ root: string; gitDir: string }> {
  const start = repoPath === undefined ? cwd : resolve(cwd, repoPath);
  const top = await runGit(start, ["rev-parse", "--show-toplevel"], signal === undefined ? {} : { signal });
  if (top.code !== 0 || top.stdout.trim() === "") {
    throw new LifeSaverError(
      "not-a-repo",
      `\`${start}\` 不是 git 工作树：${firstLine(top.stderr) || "git 没给出原因"}`,
      "把 repo 参数指到某个仓库目录里，或先切到该仓库的会话里再提交。",
    );
  }
  const dir = await runGit(start, ["rev-parse", "--absolute-git-dir"], signal === undefined ? {} : { signal });
  if (dir.code !== 0 || dir.stdout.trim() === "") {
    throw new LifeSaverError("not-a-repo", `取不到 \`${start}\` 的 git 目录：${firstLine(dir.stderr)}`);
  }
  return { root: top.stdout.trim().replace(/\\/g, "/"), gitDir: dir.stdout.trim() };
}

/** 当前脏文件（仓库相对路径，正斜杠）。 */
async function dirtyPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const run = await runGit(
    root,
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    signal === undefined ? {} : { signal },
  );
  if (run.code !== 0) throw new LifeSaverError("git-failed", `git status 失败：${firstLine(run.stderr)}`);
  return parsePorcelainZ(run.stdout);
}

/** 默认索引里已经暂存的文件（别的会话 `git add` 进来的）。 */
async function stagedPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const run = await runGit(
    root,
    ["diff", "--cached", "--name-only", "-z"],
    signal === undefined ? {} : { signal },
  );
  if (run.code !== 0) return [];
  return run.stdout
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** 去禅道取一下单子标题与链接（只在显式给了 kind+id 时才走网络）。 */
async function lookupTicket(
  service: LifeSaverService,
  kind: EntityKind,
  id: number,
  signal?: AbortSignal,
): Promise<TicketBinding> {
  const outcome = await service.read({
    kind,
    id,
    scope: "brief",
    withAttachments: false,
    maxAttachments: 0,
    maxAttachmentBytes: 0,
    ...(signal === undefined ? {} : { signal }),
  });
  const entity = outcome.envelope.entity;
  const title = entity.title.trim();
  if (title === "") throw new LifeSaverError("empty-title", `${TYPE_WORDS[kind]} #${id} 取不到标题，拒绝生成提交信息。`);
  return {
    kind,
    id,
    title,
    ...(entity.url === undefined || entity.url.trim() === "" ? {} : { url: entity.url.trim() }),
    at: new Date().toISOString(),
  };
}

/**
 * 把用户给的路径统一成仓库相对路径。
 *
 * 相对路径有两种合理读法：相对会话的工作目录，或相对仓库根。传了 `repo` 之后这两者
 * 常常不是同一个目录（仓库在父目录里、或是某个子目录），只认其中一种就会把正常路径
 * 判成「不在仓库里」。所以先按工作目录解，落不进仓库再按仓库根解。
 */
function toRepoPath(root: string, cwd: string, input: string): string {
  const inside = (absolute: string): string | undefined => {
    const rel = relative(root, absolute).replace(/\\/g, "/");
    if (rel === "" || rel.startsWith("../") || rel === "..") return undefined;
    return rel;
  };
  if (isAbsolute(input)) {
    const rel = inside(input);
    if (rel === undefined) throw new LifeSaverError("bad-args", `\`${input}\` 不在仓库 \`${root}\` 里，不能提交。`);
    return rel;
  }
  const fromCwd = inside(resolve(cwd, input));
  if (fromCwd !== undefined) return fromCwd;
  const fromRoot = inside(resolve(root, input));
  if (fromRoot !== undefined) return fromRoot;
  throw new LifeSaverError("bad-args", `\`${input}\` 不在仓库 \`${root}\` 里，不能提交。`);
}

/** 主流程。 */
export async function runCommit(request: CommitRequest, deps: CommitDeps): Promise<CommitOutput> {
  const signal = deps.signal;
  const key = sessionKeyOf(deps.sessionId);
  const { root, gitDir } = await resolveRepo(deps.cwd, request.repoPath, signal);
  const branch = await currentBranch(root, signal);

  const state = await readState(gitDir, key);

  // 1) 单子：显式给了就去禅道取真标题，没给就用会话开工时绑定的那张。
  // 自定义 message 时单子可以不填——有人只是想提交一次，不想挂单子，那也不该拦。
  const ticket =
    request.kind !== undefined && request.id !== undefined
      ? await lookupTicket(deps.service, request.kind, request.id, signal)
      : state.ticket;
  const custom = request.message !== undefined && request.message.trim() !== "";
  if (ticket === undefined && !custom) {
    throw new LifeSaverError(
      "no-ticket",
      "不知道该往提交信息里写哪张单子。",
      "传 kind + id（如 kind=bug, id=5967），或先用 zentao_session_start 从单子开工——那时会把这个会话和单子绑好。" +
        "也可以直接给 message 自己写提交信息，这样就不需要单子。",
    );
  }

  // 2) 提交信息：显式 message 优先，否则按单子生成两行。
  const auto = ticket === undefined ? undefined : commitMessageOf(ticket);
  const subject = custom ? request.message.trim() : (auto?.subject ?? "");
  const body = custom ? undefined : auto?.link;

  // 3) 要提交哪些文件。
  const current = await dirtyPaths(root, signal);
  const baseline = state.baseline;
  let files: string[];
  if (request.files !== undefined && request.files.length > 0) {
    files = request.files.map((item) => toRepoPath(root, deps.cwd, item));
  } else if (baseline !== undefined) {
    const before = new Set(baseline.dirty);
    files = current.filter((path) => !before.has(path));
  } else {
    throw new LifeSaverError(
      "no-baseline",
      "这个会话没有开工基线，算不出「本次动过哪些文件」。",
      "要么用 files 明确列出要提交的文件，要么下次用 zentao_session_start 从单子开工（那会记下基线）。",
    );
  }

  const unique = [...new Set(files)].sort();
  const unknown = unique.filter((path) => !current.includes(path));
  if (unknown.length > 0) {
    throw new LifeSaverError(
      "not-dirty",
      `这些文件当前没有改动，提交不了：${unknown.join("、")}`,
      "git 里已经是干净状态（可能已经提交过，或路径写错）。",
    );
  }
  if (unique.length === 0) {
    throw new LifeSaverError("nothing-to-commit", "本次对话没有需要提交的改动。", "工作区是干净的，或改动都在开工前的既有脏文件里。");
  }

  const heldBack = baseline === undefined ? [] : current.filter((path) => baseline.dirty.includes(path));
  const stagedElsewhere = (await stagedPaths(root, signal)).filter((path) => !unique.includes(path));
  const warnings: string[] = [];

  // 并行会话：git 记不住「这个文件是谁改的」，默认差集区分不了。别的会话也在这个仓库
  // 里开工过时如实说明，而不是假装隔离得很干净——要精确就传 files。
  if (request.files === undefined || request.files.length === 0) {
    const others = await otherSessions(gitDir, key);
    if (others.length > 0) {
      warnings.push(
        `这个仓库里还有 ${others.length} 个会话留下过开工记录（${others.join("、")}）；` +
          "默认的「开工后新出现的改动」可能把它们正在改的文件也算进来。要精确就传 files，列出本次真正动过的文件。",
      );
    }
  }

  const head = (await runGit(root, ["rev-parse", "HEAD"], signal === undefined ? {} : { signal })).stdout.trim();
  if (baseline !== undefined && baseline.head !== "" && baseline.head !== head) {
    warnings.push(
      `开工后这个仓库的 HEAD 变过（${baseline.head.slice(0, 8)} → ${head.slice(0, 8)}），可能有别的会话在这儿提交过。` +
        "本次只提交下面这些文件；如果其中有别人刚改的，用 files 参数精确指定。",
    );
  }

  const preview: CommitOutput = {
    ok: true,
    message: request.dryRun === true ? "试运行：下面这些文件会被提交。" : "即将提交。",
    repo: root,
    branch,
    subject,
    ...(body === undefined ? {} : { link: body }),
    files: unique,
    heldBack,
    stagedElsewhere,
    warnings,
    dryRun: request.dryRun === true,
    markdown: "",
  };

  if (request.dryRun === true) return { ...preview, markdown: renderCommitOutput(preview) };

  // 4) 私有索引：从 HEAD 起步，只加我们的文件，提交出来的树里没有别人的东西。
  const storeDir = join(gitDir, "life-saver");
  await mkdir(storeDir, { recursive: true });
  const indexFile = join(storeDir, `index-${key}`);
  const messageFile = join(storeDir, `message-${key}.txt`);
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    await rm(indexFile, { force: true });
    const readTree = await runGit(root, ["read-tree", head], { env, ...(signal === undefined ? {} : { signal }) });
    if (readTree.code !== 0) {
      throw new LifeSaverError("git-failed", `准备私有索引失败：${firstLine(readTree.stderr)}`);
    }

    const added = await runGit(root, ["add", "-A", "--", ...unique], { env, ...(signal === undefined ? {} : { signal }) });
    if (added.code !== 0) {
      throw new LifeSaverError("git-failed", `git add 失败：${firstLine(added.stderr)}`);
    }

    const staged = await runGit(root, ["diff", "--cached", "--name-only", "-z"], {
      env,
      ...(signal === undefined ? {} : { signal }),
    });
    const stagedFiles = staged.stdout
      .split("\0")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const strays = stagedFiles.filter((path) => !unique.includes(path));
    if (strays.length > 0) {
      throw new LifeSaverError(
        "staging-mismatch",
        `私有索引里出现了没让我们提交的文件：${strays.join("、")}`,
        "这不该发生，先别提交；把这条报错发出来。",
      );
    }
    if (stagedFiles.length === 0) {
      throw new LifeSaverError("nothing-to-commit", "这些文件在私有索引里没有产生任何变更。");
    }

    // 第一行是标题、空一行、再跟正文。少了那个空行，git 会把两行当同一段落：
    // `git log --pretty=%s` 会把链接拼进标题里（`%b` 变空），GitHub/IDE 的标题栏也跟着变丑。
    const text = body === undefined ? `${subject}\n` : `${subject}\n\n${body}\n`;
    await writeFile(messageFile, text, "utf8");
    const committed = await runGit(root, ["commit", "-F", messageFile], {
      env,
      ...(signal === undefined ? {} : { signal }),
    });
    if (committed.code !== 0) {
      throw new LifeSaverError(
        "commit-failed",
        `git commit 失败：${firstLine(committed.stderr) || firstLine(committed.stdout)}`,
      );
    }

    const sha = (await runGit(root, ["rev-parse", "HEAD"], signal === undefined ? {} : { signal })).stdout.trim();

    // 5) 把默认索引里这些路径对齐到新 HEAD——别的会话不会看到「已暂存但内容过时」的条目。
    await runGit(root, ["reset", "-q", "HEAD", "--", ...unique], signal === undefined ? {} : { signal });

    // 6) 基线前移：同一对话再提交一次时，不会把这次的文件又算一遍。
    const nextBaseline: RepoBaseline = {
      head: sha,
      dirty: await dirtyPaths(root, signal),
      at: new Date().toISOString(),
    };
    await writeState(gitDir, key, { ...(ticket === undefined ? {} : { ticket }), baseline: nextBaseline });

    let pushed: boolean | undefined;
    let pushMessage: string | undefined;
    if (request.push === true) {
      if (branch === "HEAD") {
        pushed = false;
        pushMessage = "游离头（detached HEAD），不知道该推到哪个分支，没推。";
      } else {
        const push = await runGit(root, ["push"], signal === undefined ? {} : { signal });
        pushed = push.code === 0;
        pushMessage =
          push.code === 0 ? `已推送到 origin/${branch}。` : `推送失败：${firstLine(push.stderr) || firstLine(push.stdout)}`;
        if (!pushed) warnings.push(pushMessage);
      }
    }

    const done: CommitOutput = {
      ...preview,
      message: `已提交 ${sha.slice(0, 8)}（${unique.length} 个文件）${pushed === true ? "，并已推送" : ""}。`,
      sha,
      ...(pushed === undefined ? {} : { pushed }),
      ...(pushMessage === undefined ? {} : { pushMessage }),
    };
    return { ...done, markdown: renderCommitOutput(done) };
  } finally {
    await rm(indexFile, { force: true });
    await rm(messageFile, { force: true });
  }
}

/** 渲染成人看的 markdown。 */
export function renderCommitOutput(value: CommitOutput): string {
  const lines: string[] = [];
  lines.push(value.dryRun ? `## 试运行：将提交 ${value.files.length} 个文件` : `## ${value.message}`);
  lines.push("");
  lines.push("```text");
  if (value.subject !== undefined) lines.push(value.subject);
  if (value.link !== undefined) lines.push(value.link);
  lines.push("```");
  lines.push("");
  lines.push(`- 仓库：\`${value.repo}\`（${value.branch}）`);
  if (value.sha !== undefined) lines.push(`- 提交：\`${value.sha.slice(0, 12)}\``);
  lines.push("", "### 会提交的文件", ...value.files.map((path) => `- \`${path}\``));
  if (value.heldBack.length > 0) {
    lines.push(
      "",
      `### 没提交的改动（开工前就脏着，可能是你自己或别的会话的）`,
      ...value.heldBack.map((path) => `- \`${path}\``),
    );
  }
  if (value.stagedElsewhere.length > 0) {
    lines.push(
      "",
      "### 别人暂存、这次没带上的文件",
      ...value.stagedElsewhere.map((path) => `- \`${path}\``),
    );
  }
  if (value.warnings.length > 0) {
    lines.push("", "### 注意", ...value.warnings.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}
