import { isAbsolute, join, resolve } from "node:path";
import { LifeSaverError, type LifeSaverService } from "../service.js";
import { recordWorkStart } from "./commit-start.js";
import { syncRepos, type RepoSync } from "./git.js";
import { artifactDirOf, briefTarget, ensureRoot, sessionTitle, type BriefTarget } from "./layout.js";
import { matchTarget, parseTargets } from "./targets.js";

export interface WorkStartRequest {
  readonly kind: "story" | "task" | "bug";
  readonly id: number;
  readonly targetId?: string;
  readonly cloneMissing?: boolean;
  readonly update?: boolean;
  readonly dryRun?: boolean;
}

export interface WorkStartOutput {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly target?: BriefTarget;
  readonly repos: readonly RepoSync[];
  readonly warnings: readonly string[];
  readonly candidates?: readonly BriefTarget[];
  readonly artifactDir?: string;
  readonly title: string;
  readonly markdown: string;
}

export interface WorkStartDeps {
  readonly service: LifeSaverService;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

function renderWorkStart(value: WorkStartOutput): string {
  const lines = [`## ${value.ok ? value.message : `没成：${value.message}`}`];
  if (value.target !== undefined) lines.push(`- 工作区：${value.target.name} — \`${value.target.path}\``);
  if (value.artifactDir !== undefined) lines.push(`- 产物目录（按需创建）：\`${value.artifactDir}\``);
  if (value.candidates !== undefined && value.candidates.length > 0) {
    lines.push("", "### 候选工作区（选一个再传 targetId）", ...value.candidates.map((item) => `- \`${item.id}\` ${item.name} — \`${item.path}\``));
  }
  if (value.repos.length > 0) {
    lines.push("", "### 仓库");
    for (const repo of value.repos) {
      lines.push(`- **${repo.role}** \`${repo.path}\`${repo.branch !== undefined ? ` [${repo.branch}]` : ""} — ${repo.action}：${repo.message}`);
    }
  }
  if (value.warnings.length > 0) lines.push("", "### 注意", ...value.warnings.map((item) => `- ${item}`));
  return lines.join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fieldOf(entity: object, key: string): string | undefined {
  const value = (entity as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

export async function runWorkStart(request: WorkStartRequest, deps: WorkStartDeps): Promise<WorkStartOutput> {
  if (deps.sessionId.trim() === "") throw new LifeSaverError("bad-args", "sessionId 不能为空");
  const config = deps.service.config();
  const parsed = parseTargets(config.targets);
  if (parsed.targets.length === 0) {
    const value: WorkStartOutput = { ok: false, code: "no-targets", message: "还没配置工作区目标表。请配置 ZENTAO_TARGETS。", repos: [], warnings: [], title: "", markdown: "" };
    return { ...value, markdown: renderWorkStart(value) };
  }

  const outcome = await deps.service.read({
    kind: request.kind,
    id: request.id,
    scope: "brief",
    withAttachments: false,
    maxAttachments: 0,
    maxAttachmentBytes: 0,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  const entity = outcome.envelope.entity;
  const match = matchTarget(parsed.targets, {
    projectName: typeof entity.projectName === "string" ? entity.projectName : undefined,
    productName: fieldOf(entity, "productName"),
    moduleName: typeof entity.moduleName === "string" ? entity.moduleName : undefined,
    title: entity.title,
  }, request.targetId);
  if (match.target === undefined) {
    const value: WorkStartOutput = {
      ok: false,
      code: "target-ambiguous",
      message: match.reason,
      repos: [],
      warnings: [],
      candidates: match.candidates.map(briefTarget),
      title: entity.title,
      markdown: "",
    };
    return { ...value, markdown: renderWorkStart(value) };
  }

  const target = match.target;
  const cloneMissing = request.cloneMissing !== false;
  const update = request.update !== false;
  const root = await ensureRoot(target.path, cloneMissing && target.repos.some((repo) => repo.gitUrl !== ""));
  if (!root.ok) throw new LifeSaverError("workspace-missing", root.message);
  const sync = await syncRepos(target.path, target.repos, { clone: cloneMissing, update, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
  const blocking = sync.results.filter((item) => item.action === "failed");
  const title = sessionTitle(request.kind, request.id, entity.title);
  const artifactDir = artifactDirOf(target, title);
  const warnings = [...sync.warnings];
  if (blocking.length > 0) warnings.push(`仓库没准备好：${blocking.map((item) => `${item.role}：${item.message}`).join("；")}`);

  if (request.dryRun !== true) {
    if (blocking.length > 0) {
      const value: WorkStartOutput = {
        ok: false,
        code: "repo-not-ready",
        message: "仓库没准备好，没有记录开工基线。",
        target: briefTarget(target),
        repos: sync.results,
        warnings,
        artifactDir,
        title,
        markdown: "",
      };
      return { ...value, markdown: renderWorkStart(value) };
    }
    try {
      warnings.push(...await recordWorkStart({
        repos: target.repos.map((repo) => ({ path: isAbsolute(repo.path) ? resolve(repo.path) : resolve(join(target.path, repo.path)) })),
        ticket: {
          kind: request.kind,
          id: request.id,
          title: entity.title,
          ...(entity.url === undefined || entity.url.trim() === "" ? {} : { url: entity.url.trim() }),
        },
        sessionId: deps.sessionId,
        overwriteBaseline: true,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      }));
    } catch (error) {
      warnings.push(`开工现场没记上（提交时需要显式给文件清单）：${messageOf(error)}`);
    }
  }

  const value: WorkStartOutput = {
    ok: blocking.length === 0,
    code: blocking.length === 0 ? undefined : "repo-not-ready",
    message: request.dryRun === true
      ? "试运行：仓库已探测/同步，没有记录开工基线。"
      : blocking.length === 0
        ? "已同步仓库并记录开工基线。"
        : "仓库没准备好，没有记录开工基线。",
    target: briefTarget(target),
    repos: sync.results,
    warnings,
    artifactDir,
    title,
    markdown: "",
  };
  return { ...value, markdown: renderWorkStart(value) };
}
