/**
 * 会话装配层：把一个禅道编号变成「在某个工作区里已经开好、标题写好的新会话」。
 *
 * 为什么放在插件里而不是让模型自己调工具：
 *   宿主确实暴露了 `workspaceRegistry` 与 `sessionController` 两个服务，
 *   但它们的接错方式很挑——`workspaceId` 与 `cwd` 互斥、工作区目录必须已经存在、
 *   会话标题要另外调一次 rename。这套顺序写死在插件里，模型只管说「给 BUG 5967 开工」。
 *
 * 全程只碰两件有副作用的事：git（补齐/快进，见 git.ts）和开新会话。
 * 新会话的提示词默认**不发**：一条提示词就是一轮真实模型调用，得由人点头。
 */

import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LifeSaverConfig } from "life-saver-core/config.js";
import type { LifeSaverService } from "life-saver-core/service.js";
import { LifeSaverError } from "life-saver-core/service.js";
import type { EntityKind } from "life-saver-core/domain/model.js";
import {
  findTarget,
  kindLabel,
  matchTarget,
  normalizePath,
  parseTargets,
  type TargetQuery,
  type WorkspaceTarget,
} from "../domain/targets.js";
import { syncRepos, type RepoSync } from "./git.js";
import { lookupSession, type LookupResult, type SessionSummaryLike } from "./history.js";
import { recordWorkStart } from "../commit/start.js";

/** 宿主工作区注册表：只声明用得上的方法。 */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[];
  create(path: string, title: string): Promise<WorkspaceLike>;
}

export interface WorkspaceLike {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

/** 宿主会话控制器：只声明用得上的方法。 */
export interface SessionControllerLike {
  create(request: { workspaceId?: string }): Promise<{ readonly sessionId: string }>;
  rename?(request: { sessionId: string; title: string }): Promise<{ readonly title: string }>;
  /** 纯读的会话列表（不 resume、不激活 Agent），用来找同编号的旧会话。 */
  list?(request?: Record<string, never>, signal?: AbortSignal): Promise<{ readonly items: readonly SessionSummaryLike[] }>;
  prompt(
    request: {
      sessionId: string;
      content: readonly { type: "text"; text: string }[];
      requestId: string;
      mode?: "followup" | "steer";
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** 一次「开工」的请求。 */
export interface StartRequest {
  readonly kind: EntityKind;
  readonly id: number;
  /** 指定目标：target 的 id 或 name；不填则按禅道项目名自动匹配。 */
  readonly targetId?: string;
  /** 只做准备，不建会话、不发提示词。 */
  readonly dryRun?: boolean;
  /** 显式给的提示词；不填则看 `session.autoPrompt`。 */
  readonly prompt?: string;
  /** 是否补齐缺失的仓库（默认 true：用户要求「目录里缺的项目就主动拉取」）。 */
  readonly cloneMissing?: boolean;
  /** 是否把仓库更新到最新（默认 true：开工前先更新代码）。 */
  readonly update?: boolean;
  /** 是否优先复用同编号的旧会话（默认看 `session.reuseExisting`；给 false 就强行新建）。 */
  readonly reuse?: boolean;
  /** 发起这次调用的会话 id：查旧会话时要排除它自己。 */
  readonly excludeSessionId?: string;
}

/** 一次「开工」的结果，直接当工具输出用。 */
export interface StartResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly target?: { readonly id: string; readonly name: string; readonly path: string };
  readonly workspace?: { readonly id: string; readonly path: string; readonly created: boolean };
  readonly sessionId?: string;
  readonly title?: string;
  /** true = 回到了同编号的旧会话，没有新建。 */
  readonly reused?: boolean;
  readonly prompted: boolean;
  readonly dryRun: boolean;
  readonly repos: readonly RepoSync[];
  readonly warnings: readonly string[];
  readonly candidates?: readonly { readonly id: string; readonly name: string; readonly path: string }[];
  /** 别的目录里也有同编号会话（不自动复用，只提示）。 */
  readonly elsewhere?: readonly { readonly sessionId: string; readonly title: string; readonly cwd: string }[];
  readonly prompt?: string;
  readonly entity?: { readonly title: string; readonly url?: string };
  readonly markdown?: string;
}

export interface LauncherDeps {
  readonly config: () => LifeSaverConfig;
  readonly service: LifeSaverService;
  /** 宿主服务可能晚于本插件挂载，所以每次现取。 */
  readonly workspaceRegistry: () => WorkspaceRegistryLike | undefined;
  readonly sessionController: () => SessionControllerLike | undefined;
  /** 调用方：agent = 模型自己发起，ui = 人在插件页点按钮。 */
  readonly origin: "agent" | "ui";
  readonly logger?: { info?(message: string): void; warn?(message: string): void };
}

/** 目标表里所有可选项（给页面下拉框）。 */
export function describeTargets(config: LifeSaverConfig): readonly WorkspaceTarget[] {
  return parseTargets(config.targets).targets;
}

/**
 * 开工：定位工作区 → 同步仓库 → 建/复用工作区 → 开新会话 →（按配置）发首条提示词 → 发出去了才改名。
 *
 * 每一步失败都返回 `ok:false` 而不是抛错，好让模型把原因原样说给人听；
 * 只有参数级错误（编号不认识）才走 `LifeSaverError`。
 */
export async function startSession(
  deps: LauncherDeps,
  request: StartRequest,
  signal?: AbortSignal,
): Promise<StartResult> {
  const config = deps.config();
  if (config.session.enabled !== true) {
    return fail("session-disabled", "开新会话功能已关闭（设置页 → 开新会话 → 启用）。", true);
  }
  // 人在页面上点按钮 = 明确同意；模型自己发起则要过开关。
  if (deps.origin === "agent" && config.session.agentAutoStart !== true) {
    return fail(
      "auto-start-disabled",
      "模型自主开新会话默认关闭。要么请人在插件页点「在新会话处理」按钮，要么在设置里打开「允许模型主动开新会话」。",
      !!request.dryRun,
    );
  }

  const parsed = parseTargets(config.targets);
  if (parsed.targets.length === 0) {
    return fail(
      "no-targets",
      "还没配置工作区目标表。请到插件设置页 → 工作区目标，填「禅道项目名 → 工作区路径（含各端 git 仓库与分支）」。",
      !!request.dryRun,
    );
  }

  const workspaceRegistry = deps.workspaceRegistry();
  const sessionController = deps.sessionController();
  if (workspaceRegistry === undefined || sessionController === undefined) {
    return fail(
      "host-unavailable",
      "宿主的工作区/会话服务还没就绪（workspaceRegistry / sessionController 取不到），稍后再试。",
      !!request.dryRun,
    );
  }

  // 1. 先读实体：项目名用来匹配目标，标题用来命名会话。
  const outcome = await deps.service.read({
    kind: request.kind,
    id: request.id,
    scope: "brief",
    withAttachments: false,
    maxAttachments: 0,
    maxAttachmentBytes: 0,
    signal,
  });
  const entity = outcome.envelope.entity;
  const query: TargetQuery = {
    ...(field(entity, "projectName") !== undefined ? { projectName: field(entity, "projectName") } : {}),
    ...(field(entity, "productName") !== undefined ? { productName: field(entity, "productName") } : {}),
    ...(field(entity, "moduleName") !== undefined ? { moduleName: field(entity, "moduleName") } : {}),
    title: entity.title,
  };
  const match = matchTarget(parsed.targets, query, request.targetId);
  if (match.target === undefined) {
    return {
      ...fail("target-ambiguous", match.reason, !!request.dryRun),
      candidates: match.candidates.map(briefTarget),
      entity: { title: entity.title, ...(entity.url !== undefined ? { url: entity.url } : {}) },
    };
  }
  const target = match.target;

  // 2. 工作区根目录：不存在时，只有「确实要往里 clone」才建，避免留下一堆空目录。
  const wanted = target.repos.filter((repo) => repo.gitUrl !== "");
  const rootCreated = await ensureRoot(target.path, wanted.length > 0);
  if (!rootCreated.ok) {
    return { ...fail("workspace-missing", rootCreated.message, !!request.dryRun), target: briefTarget(target) };
  }

  // 3. 同步仓库（补齐 + 更新到最新）。这是「开工前先更新代码」的落点。
  const sync = await syncRepos(target.path, target.repos, {
    clone: request.cloneMissing !== false,
    update: request.update !== false,
    ...(signal !== undefined ? { signal } : {}),
  });

  const blocking = sync.results.filter((item) => item.action === "failed");
  if (blocking.length > 0 && request.dryRun !== true) {
    return {
      ...fail("repo-not-ready", `仓库没准备好就开会话等于让人白跑一趟：\n${blocking.map((item) => `- ${item.message}`).join("\n")}`, false),
      target: briefTarget(target),
      repos: sync.results,
      warnings: sync.warnings,
      entity: { title: entity.title, ...(entity.url !== undefined ? { url: entity.url } : {}) },
    };
  }

  // 4. 建/复用工作区：宿主只认「已存在的目录」，重复调用会返回已有实体。
  const existing = workspaceRegistry.list().find((item) => normalizePath(item.path) === normalizePath(target.path));
  const title = sessionTitle(target, request.kind, request.id, entity.title);
  const promptText = buildPrompt(config, target, request.kind, request.id, entity.title, entity.url, sync.results);
  const brief = { title: entity.title, ...(entity.url !== undefined ? { url: entity.url } : {}) };

  // 4.5 同编号的旧会话：用户要求「优先在之前的会话里继续，只认编号，找不到就当新的」。
  // 只认同一个工作区（cwd 一致）的；别的目录里同编号的只当提示，不接管。
  const wantsReuse = request.reuse ?? config.session.reuseExisting !== false;
  let previous: LookupResult["found"];
  let elsewhere: LookupResult["elsewhere"] = [];
  if (wantsReuse) {
    const summaries = await listSessions(sessionController, signal, deps.logger);
    const lookup = lookupSession(summaries, request.kind, request.id, target.path, request.excludeSessionId);
    previous = lookup.found;
    elsewhere = lookup.elsewhere;
  }

  if (request.dryRun === true) {
    if (previous !== undefined) {
      return {
        ok: true,
        message: `试运行：这个工作区里已经有同编号的旧会话「${previous.title}」，真开工时会回到它继续，不新建。`,
        target: briefTarget(target),
        ...(existing !== undefined
          ? { workspace: { id: existing.id, path: existing.path, created: false } }
          : { workspace: { id: "", path: target.path, created: false } }),
        sessionId: previous.sessionId,
        title: previous.title,
        reused: true,
        prompted: false,
        dryRun: true,
        repos: sync.results,
        warnings: sync.warnings,
        ...(elsewhere.length > 0 ? { elsewhere } : {}),
        prompt: promptText,
        entity: brief,
      };
    }
    return {
      ok: true,
      message: "试运行：仓库已按要求探测/同步，会话没有创建。确认无误再去掉 dryRun。",
      target: briefTarget(target),
      ...(existing !== undefined
        ? { workspace: { id: existing.id, path: existing.path, created: false } }
        : { workspace: { id: "", path: target.path, created: true } }),
      title,
      prompted: false,
      dryRun: true,
      repos: sync.results,
      warnings: sync.warnings,
      ...(elsewhere.length > 0 ? { elsewhere } : {}),
      prompt: promptText,
      entity: brief,
    };
  }

  const warnings = [...sync.warnings];
  let workspace: WorkspaceLike;
  let sessionId: string;
  // 新会话一开始不带标题：标题等首条提示词真发出去之后再写（理由见第 6 步）。
  let finalTitle = "";
  let reused = false;

  if (previous !== undefined) {
    // 回到旧会话：它本来就在这个工作区里（cwd 校验过），不新建、也不改名——
    // 禅道那边标题改了也不该把已有会话改名，人的对话记录还挂在那儿。
    reused = true;
    sessionId = previous.sessionId;
    finalTitle = previous.title;
    workspace = existing ?? { id: "", path: target.path, title: target.name };
    if (existing === undefined) {
      warnings.push(
        `旧会话 ${previous.sessionId} 的 cwd 就是 ${target.path}，但宿主的工作区列表里没有登记这个目录；会话能用，只是侧栏里可能看不到它。`,
      );
    }
  } else {
    try {
      workspace = existing ?? (await workspaceRegistry.create(target.path, target.name));
    } catch (error) {
      return { ...fail("workspace-create-failed", `登记工作区失败：${messageOf(error)}`, false), target: briefTarget(target), repos: sync.results };
    }

    // 5. 开新会话。注意：workspaceId 与 cwd 互斥，给了工作区就不能再给 cwd。
    try {
      const created = await sessionController.create({ workspaceId: workspace.id });
      sessionId = created.sessionId;
    } catch (error) {
      return {
        ...fail("session-create-failed", `会话没建成：${messageOf(error)}`, false),
        target: briefTarget(target),
        workspace: { id: workspace.id, path: workspace.path, created: existing === undefined },
        repos: sync.results,
      };
    }

    // 6. 先不改名，标题留空。宿主「新建会话」会复用本工作区里最新的 blank 会话，
    // 而 blank 只看有没有 turn/start —— 一个「改过名但从没说过话」的空壳会被反复复用，
    // 新会话就一直顶着别人的标题；宿主又没有清空标题的接口（空串判非法）。
    // 所以标题推迟到第 7.5 步：首条提示词真的发出去了再写。
  }

  // 6.5 开工记账：把会话与单子绑定，并记下开工那一刻的脏文件。之后 `zentao_commit`
  // 才能分清「这轮新改的」和「开工前就脏着的」。记账失败只提示，不挡开工——
  // 大不了提交流程退化成「必须显式给 files」。
  try {
    const recorded = await recordWorkStart({
      repos: target.repos.map((repo) => ({
        path: isAbsolute(repo.path) ? resolve(repo.path) : resolve(join(target.path, repo.path)),
      })),
      ticket: {
        kind: request.kind,
        id: request.id,
        title: entity.title,
        ...(entity.url !== undefined ? { url: entity.url } : {}),
      },
      sessionId,
      overwriteBaseline: !reused,
      ...(signal === undefined ? {} : { signal }),
    });
    warnings.push(...recorded);
  } catch (error) {
    warnings.push(`开工现场没记上（不影响开工，只是提交时得自己给文件清单）：${messageOf(error)}`);
  }

  // 7. 首条提示词：显式给了就发，否则看配置。默认不发。
  const shouldPrompt = request.prompt !== undefined || config.session.autoPrompt === true;
  let prompted = false;
  if (shouldPrompt) {
    const text = request.prompt !== undefined && request.prompt.trim() !== "" ? request.prompt : promptText;
    try {
      // 注意：宿主的 `prompt(request, signal)` 第一行就是 `signal.throwIfAborted()`，
      // 这个参数**不是可选的**——传 undefined 会当场炸成
      // "Cannot read properties of undefined (reading 'throwIfAborted')"。
      // 我们这条链路本来就没有取消源，所以造一个永不 abort 的 signal 顶上。
      await sessionController.prompt(
        {
          sessionId,
          content: [{ type: "text", text }],
          requestId: `life-saver-${request.kind}-${request.id}-${randomUUID()}`,
          mode: "followup",
        },
        signal ?? new AbortController().signal,
      );
      prompted = true;
    } catch (error) {
      warnings.push(`会话已建好，但首条提示词没发出去：${messageOf(error)}`);
    }
  }

  // 7.5 提示词发出去了，会话才算真的开张：这时候再写标题，它就不再是 blank 空壳，
  // 也就不会被宿主的「新建会话」反复复用、把标题带到下一个新会话上。
  // 改名失败不算致命：会话已经能用，标题后面能自己改。
  if (prompted && !reused) {
    try {
      const renamed = await sessionController.rename?.({ sessionId, title });
      if (renamed?.title !== undefined) finalTitle = renamed.title;
    } catch (error) {
      warnings.push(`会话已建好，但标题没写上（${messageOf(error)}）；可以手动改，不影响干活。`);
    }
  }

  const where = workspace.title !== "" ? workspace.title : target.name;
  const message = reused
    ? prompted
      ? `回到工作区「${where}」里同编号的旧会话，并把首条提示词发了出去。`
      : `回到工作区「${where}」里同编号的旧会话「${finalTitle}」（没发提示词，去会话里接着干）。`
    : prompted
      ? `已在工作区「${where}」开好会话并发了首条提示词${finalTitle !== "" ? `，标题「${finalTitle}」` : ""}。`
      : `已在工作区「${where}」开好会话（提示词没发，标题先空着——免得留下「有标题但没内容」的空壳被反复复用；去会话里确认后自己发）。`;

  return {
    ok: true,
    message,
    target: briefTarget(target),
    workspace: { id: workspace.id, path: workspace.path, created: existing === undefined && !reused },
    sessionId,
    ...(finalTitle !== "" ? { title: finalTitle } : {}),
    reused,
    prompted,
    dryRun: false,
    repos: sync.results,
    warnings,
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    prompt: shouldPrompt ? undefined : promptText,
    entity: brief,
  };
}

/** 读一次会话列表；宿主没这能力或读失败都当「没有旧会话」，不能因此开不了工。 */
async function listSessions(
  controller: SessionControllerLike,
  signal: AbortSignal | undefined,
  logger: LauncherDeps["logger"],
): Promise<readonly SessionSummaryLike[]> {
  if (controller.list === undefined) return [];
  try {
    const result = await controller.list({}, signal ?? new AbortController().signal);
    return Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    logger?.warn?.(`读会话列表失败，这次按「没有旧会话」处理：${messageOf(error)}`);
    return [];
  }
}

/** 建会话前把根目录准备好：没有仓库要 clone 就要求它自己存在（不凭空造空目录）。 */
async function ensureRoot(path: string, mayCreate: boolean): Promise<{ readonly ok: boolean; readonly message: string }> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return { ok: true, message: "" };
    return { ok: false, message: `工作区路径 ${path} 不是目录。` };
  } catch {
    // 不存在
  }
  if (!mayCreate) return { ok: false, message: `工作区目录 ${path} 不存在，而且这个目标没配可自动 clone 的仓库，不替你造空目录。` };
  try {
    await mkdir(path, { recursive: true });
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: `工作区目录 ${path} 建不出来：${messageOf(error)}` };
  }
}

/** 会话标题：一眼能看出是哪条禅道单子。 */
function sessionTitle(target: WorkspaceTarget, kind: EntityKind, id: number, title: string): string {
  return `${kindLabel(kind)} #${id} ${title}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * 会话产物目录名：和会话名一致，只把文件系统不认的字符换掉。
 *
 * 会话名里带 `#`、空格、中文都是常态，Windows 只拦 `\ / : * ? " < > |` 与控制字符；
 * 末尾的点和空格在 Windows 上会被静默吞掉，一并去掉，否则提示词里写的路径和实际建出来的不是同一个。
 */
function artifactDirName(sessionName: string): string {
  const cleaned = sessionName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned === "" ? "session" : cleaned;
}

/**
 * 首条提示词：只给「编号 + 环境事实 + 该做什么」。
 *
 * 刻意不把正文塞进来——正文模型自己会用 zentao_read 再读一遍，
 * 塞进来既费 token 又容易和新读到的内容冲突（用户可能在会话里已经改过禅道）。
 */
function buildPrompt(
  config: LifeSaverConfig,
  target: WorkspaceTarget,
  kind: EntityKind,
  id: number,
  title: string,
  url: string | undefined,
  repos: readonly RepoSync[],
): string {
  const reposText =
    repos.length === 0
      ? "（这个工作区没配仓库）"
      : repos
          .map((item) => `- ${item.role}：${item.path}${item.branch !== undefined ? `（${item.branch}）` : ""}${item.submodules !== undefined ? `，${item.submodules.length} 个子模块` : ""} —— ${item.message}`)
          .join("\n");
  const chainText = branchChainText(target);
  const subChainText = submoduleChainText(target);
  const zentao = url !== undefined ? url : `禅道 ${kindLabel(kind)} #${id}`;
  const submoduleSummary = submoduleText(repos);
  // 会话名与产物目录名同源：会话改名成 `BUG #5967 登录页报错`，产物目录就是工作区根目录下同名的那一个。
  const sessionName = sessionTitle(target, kind, id, title);
  const artifactDir = join(target.path, artifactDirName(sessionName));
  const custom = config.session.promptTemplate.trim();
  if (custom !== "") {
    return fill(custom, {
      kind: kindLabel(kind),
      id: String(id),
      title,
      target: target.name,
      dir: artifactDir,
      repos: reposText,
      branches: chainText === "" ? "（没配分支链）" : chainText,
      submodulebranches: subChainText === "" ? "（子模块都跟随父仓库分支）" : subChainText,
      submodules: submoduleSummary === "" ? "（没有子模块）" : submoduleSummary,
      zentao,
    });
  }
  return [
    `处理${kindLabel(kind)} #${id}：${title}`,
    "",
    `工作区：${target.name}（${target.path}）`,
    `会话产物目录（按需创建）：${artifactDir}`,
    `这个目录不是开局任务，别先建：只有真要落文件（脚本、日志、导出的数据、截图、临时笔记）时才在工作区根目录建它（名字和会话名「${sessionName}」一致，已存在就直接用），文件都放里面；一个文件都不用落就别建，免得工作区里堆一堆空文件夹。别把文件塞进仓库、也别散落在工作区根目录。代码本身的修改照旧落在对应仓库里，不要挪进这个目录。`,
    "仓库状态（已开工前同步）：",
    reposText,
    "",
    `先跑 zentao_read(kind="${kind}", id="${id}") 把正文、备注、附件读全，再动手。`,
    "改动前先确认当前分支与需求一致；不要动没让你动的模块；不要 git push。",
    ...(submoduleSummary === "" ? [] : ["", "父子模块（子模块跟着父仓库同一条链走）：", submoduleSummary]),
    ...(chainText === "" ? [] : ["", "分支链（序号由小到大，改动只落在序号 1）：", chainText]),
    ...(subChainText === "" ? [] : ["", "子模块分支（和父仓库不一致的那些）：", subChainText]),
    ...(chainText === "" ? [] : ["", "代码只改在序号 1 的分支上；改完按分支链一路 cherry-pick 上去（1→2→3…），每一步都要在下一个分支上 `git cherry-pick` 上一个分支的提交；冲突先在当步解决再继续，不要跳序号、不要在后面的分支上重复手改。"]),
    ...(chainText === "" || submoduleSummary === "" ? [] : ["", `父仓库下面有子模块时，子模块按它自己的分支链走（没单独配的就跟父仓库同一条链），并分清两种情况：(a) 父仓库自己有代码改动 → 父仓库按它的链 cp，每次 cp 完父仓库，子模块里对应的那条提交也要按同一顺序 cp 上去（先 commit 子模块，再 commit 父仓库的指针，两个提交一起往上走）；(b) 只改了子模块、父仓库自身没有代码改动 → 父仓库不要 cherry-pick（没有父仓库代码要搬），只按父仓库的分支链逐个分支把子模块指针更新到子模块对应分支上的新提交、各提交一次「更新 X 子模块指针」，子模块自己的链仍按顺序 cp 上去。子模块有未提交改动的先别动它，宁可停下来问。`]),
    `禅道原文：${zentao}`,
  ].join("\n");
}

/** 子模块状态的人话摘要：只列真的有子模块的仓库；一个都没有时返回空字符串。 */
function submoduleText(repos: readonly RepoSync[]): string {
  const lines: string[] = [];
  for (const item of repos) {
    const subs = item.submodules ?? [];
    if (subs.length === 0) continue;
    const counts = [
      [subs.filter((sub) => sub.action === "updated").length, "已快进到最新"],
      [subs.filter((sub) => sub.action === "up-to-date").length, "本来就在最新"],
      [subs.filter((sub) => sub.action === "switched").length, "换了分支并跟上最新"],
    ] as const;
    const parts: string[] = [];
    for (const [count, label] of counts) if (count > 0) parts.push(`${count} 个${label}`);
    const skipped = subs.filter((sub) => sub.action === "skipped");
    const failed = subs.filter((sub) => sub.action === "failed");
    if (skipped.length > 0) {
      parts.push(`${skipped.length} 个没动（${skipped.map((sub) => `${sub.path} ${shortReason(sub.message)}`).join("；")}）`);
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} 个更新失败（${failed.map((sub) => `${sub.path} ${shortReason(sub.message)}`).join("；")}）`);
    }
    const branches = [...new Set(subs.map((sub) => sub.branch).filter((branch): branch is string => branch !== undefined))];
    lines.push(`- ${item.role}：共 ${subs.length} 个子模块，${parts.join("，")}${branches.length === 0 ? "" : `；分支：${branches.join("、")}`}`);
  }
  return lines.join("\n");
}

/** 子模块分支的人话清单：只列「单独配了分支」的子模块；一条都没有时返回空字符串。 */
function submoduleChainText(target: WorkspaceTarget): string {
  const lines: string[] = [];
  for (const repo of target.repos) {
    const chainOfRepo =
      repo.branches.length === 0 ? "（父仓库没配分支）" : repo.branches.map((branch, index) => `${index + 1}. ${branch}`).join(" → ");
    const rows = (repo.submodules ?? [])
      .filter((rule) => rule.branches.length > 0)
      .map((rule) => {
        const chain = rule.branches.map((branch, index) => `${index + 1}. ${branch}`).join(" → ");
        return `${rule.match}：${chain}`;
      });
    if (rows.length === 0) continue;
    lines.push(`- ${repo.role}（父仓库 ${chainOfRepo}）：${rows.join("；")}`);
  }
  return lines.join("\n");
}

/** 分支链的人话清单：只列配了分支的仓库。全都没配时返回空字符串，提示词里这一段就整段省掉。 */
function branchChainText(target: WorkspaceTarget): string {
  const lines: string[] = [];
  for (const repo of target.repos) {
    if (repo.branches.length === 0) continue;
    const chain = repo.branches.map((branch, index) => `${index + 1}. ${branch}`).join(" → ");
    lines.push(`- ${repo.role}：${chain}`);
  }
  return lines.join("\n");
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (whole, key: string) => values[key.toLowerCase()] ?? whole);
}

function briefTarget(target: WorkspaceTarget): { id: string; name: string; path: string } {
  return { id: target.id, name: target.name, path: target.path };
}

function fail(code: string, message: string, dryRun: boolean): StartResult {
  return { ok: false, code, message, prompted: false, dryRun, repos: [], warnings: [] };
}

/** 从实体上取一个可选的文字字段：三种实体（需求/任务/BUG）字段不完全一样。 */
function field(entity: object, key: "projectName" | "productName" | "moduleName"): string | undefined {
  const value = (entity as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提示词里给子模块留一行摘要：截到第一个句读，太长的再砍一刀。 */
function shortReason(message: string): string {
  const cut = message.split(/[：，。]/u)[0]?.trim() ?? "";
  const text = cut === "" ? message.trim() : cut;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 直接按 id/name 找目标（页面下拉里选中后回传）。 */
export { findTarget };
