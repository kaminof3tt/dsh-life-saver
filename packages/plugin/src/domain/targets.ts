/**
 * 工作区目标表：禅道的项目/产品 → 本地工作区目录 → 若干 git 仓库。
 *
 * 为什么是一张表而不是一个字段：一个工作区里经常有多个独立仓库
 * （园区V2 = 后端 + 前端 + 移动端），而禅道上的 projectName 又是别人随手起的，
 * 两边没有天然对应关系。所以这里把「人和模型都看得懂的映射」显式存下来，
 * 再由 `matchTarget` 做匹配；匹配不到就不猜，把候选扔回去让人选。
 *
 * 表以 JSON 字符串存在配置里（`config.targets`）：DSH 的桥接路由只允许写标量，
 * 数组塞不进去（见 `bridge/routes.ts` 的 `config-set`），所以序列化后当字符串存。
 */

import type { EntityKind } from "life-saver-core/domain/model.js";

/**
 * 一个子模块的分支配置：键是模糊匹配词，值是它的分支链。
 *
 * 父子模块仓库里，子模块的分支常常和父仓库不一致（园区前端：父仓库在
 * `develop/v2.6.2`，子模块 `acme-web-admin` 在 `develop/v2.6.2-demo`），
 * 所以留一个自由配置的口子：配了就按配的走，没配就默认跟随父仓库的分支。
 */
export interface SubmoduleRef {
  /** 匹配词：子模块路径、末段目录名，或其中任意一段（大小写不敏感、模糊包含）。 */
  readonly match: string;
  /** 这个子模块的分支链，序号 1 是落点；空数组表示跟随父仓库。 */
  readonly branches: readonly string[];
}

/** 一个 git 仓库：工作区里的一个子项目。 */
export interface RepoRef {
  /** 显示用角色名：后端 / 前端 / 移动端 / 随便什么。 */
  readonly role: string;
  /** 仓库本地路径：绝对路径，或相对工作区根目录的目录名（如 `server`、`web`）。 */
  readonly path: string;
  /** 远端地址；留空表示「只探测、不拉取」。 */
  readonly gitUrl: string;
  /**
   * 分支链，**按序号从低到高**：`[0]` 是序号 1，改动永远落在序号最小的那个，
   * 再依次 cherry-pick 到后面的分支。空数组表示不校验分支。
   */
  readonly branches: readonly string[];
  /** 子模块的分支例外表（键值对式，模糊匹配）；没匹配上的子模块跟随父仓库分支。 */
  readonly submodules?: readonly SubmoduleRef[];
}

/** 一个工作区目标。 */
export interface WorkspaceTarget {
  /** 稳定标识（侧栏/配置里引用它）。 */
  readonly id: string;
  /** 工作区显示名，会成为 DSH 工作区的标题。 */
  readonly name: string;
  /** 工作区根目录绝对路径。 */
  readonly path: string;
  /** 禅道侧的匹配词（projectName / productName）。 */
  readonly zentaoProjects: readonly string[];
  /** 工作区里的 git 仓库。 */
  readonly repos: readonly RepoRef[];
}

/** 解析结果：能用的目标 + 坏掉的条目（坏的只报告，不拖垮整表）。 */
export interface TargetParseResult {
  readonly targets: readonly WorkspaceTarget[];
  readonly errors: readonly string[];
}

/** 匹配用的禅道侧线索。 */
export interface TargetQuery {
  readonly projectName?: string | undefined;
  readonly productName?: string | undefined;
  readonly moduleName?: string | undefined;
  readonly title?: string | undefined;
}

/** 匹配结果。`candidates` 在没匹配上或匹配到多个时给页面/模型用。 */
export interface TargetMatch {
  readonly target?: WorkspaceTarget;
  readonly candidates: readonly WorkspaceTarget[];
  /** 人话原因，直接写进工具输出。 */
  readonly reason: string;
}

/** 绝对路径判定：Windows 盘符、UNC、POSIX 三种写法都认。 */
export function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (path.startsWith("\\\\")) return true;
  return /^[A-Za-z]:[\\/]/.test(path);
}

/** 路径归一化：只用于比较，不碰文件系统。 */
export function normalizePath(path: string): string {
  return path.trim().replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * 解析配置里的目标表。
 *
 * 永不抛错：配置写坏一个条目不应该让整个插件不可用，坏条目进 `errors`。
 * 空串 / 空数组都当成「没配」。
 */
export function parseTargets(raw: unknown): TargetParseResult {
  const errors: string[] = [];
  let value: unknown = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return { targets: [], errors };
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      return { targets: [], errors: [`targets 不是合法 JSON：${messageOf(error)}`] };
    }
  }
  if (value === undefined || value === null) return { targets: [], errors };
  if (!Array.isArray(value)) return { targets: [], errors: ["targets 必须是数组"] };

  const targets: WorkspaceTarget[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const parsed = parseTarget(item, index, errors);
    if (parsed === undefined) return;
    let id = parsed.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${parsed.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    targets.push(id === parsed.id ? parsed : { ...parsed, id });
  });
  return { targets, errors };
}

function parseTarget(item: unknown, index: number, errors: string[]): WorkspaceTarget | undefined {
  const where = `targets[${index}]`;
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`${where} 不是对象`);
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const name = text(record.name);
  if (name === "") {
    errors.push(`${where}.name 不能为空`);
    return undefined;
  }
  const path = text(record.path);
  if (path === "" || !isAbsolutePath(path)) {
    errors.push(`${where}.path 必须是绝对路径（当前：${path === "" ? "空" : path}）`);
    return undefined;
  }
  const id = text(record.id) !== "" ? slug(text(record.id)) : slug(name) || `target-${index + 1}`;
  const zentaoProjects = textList(record.zentaoProjects);
  const repos: RepoRef[] = [];
  const rawRepos = record.repos;
  if (rawRepos !== undefined && rawRepos !== null) {
    if (!Array.isArray(rawRepos)) {
      errors.push(`${where}.repos 必须是数组`);
    } else {
      rawRepos.forEach((rawRepo, repoIndex) => {
        const repo = parseRepo(rawRepo, `${where}.repos[${repoIndex}]`, errors);
        if (repo !== undefined) repos.push(repo);
      });
    }
  }
  return { id, name, path, zentaoProjects, repos };
}

function parseRepo(raw: unknown, where: string, errors: string[]): RepoRef | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${where} 不是对象`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const path = text(record.path);
  if (path === "") {
    errors.push(`${where}.path 不能为空（绝对路径，或相对工作区根目录的目录名）`);
    return undefined;
  }
  const role = text(record.role) !== "" ? text(record.role) : "仓库";
  return {
    role,
    path,
    // 原样保留：clone 要用真地址（带凭据的 https 地址是唯一能免交互克隆的方式）。
    // 打码只发生在「要展示给人看」的地方——见 `session/git.ts` 的 redactUrl。
    gitUrl: text(record.gitUrl),
    branches: parseBranches(record),
    submodules: parseSubmodules(record.submodules, `${where}.submodules`, errors),
  };
}

/**
 * 子模块分支表：`{ "acme-web-admin": "develop/v2.6.2-demo" }` 这种键值对最省事，
 * 也收 `[{ match: "...", branches: ["...", "..."] }]`（要配分支链时用）。
 * 值可以是单分支字符串，也可以是逗号分隔的链或数组。
 */
function parseSubmodules(raw: unknown, where: string, errors: string[]): SubmoduleRef[] {
  const kept: SubmoduleRef[] = [];
  if (raw === undefined || raw === null) return kept;
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${where}[${index}] 不是对象`);
        return;
      }
      const record = item as Record<string, unknown>;
      const match = text(record.match);
      if (match === "") {
        errors.push(`${where}[${index}].match 不能为空（子模块路径或目录名的一段）`);
        return;
      }
      kept.push({ match, branches: parseBranches(record) });
    });
    return kept;
  }
  if (typeof raw === "object") {
    for (const [match, value] of Object.entries(raw as Record<string, unknown>)) {
      const key = match.trim();
      if (key === "") continue;
      kept.push({ match: key, branches: dedupe(textList(value)) });
    }
    return kept;
  }
  errors.push(`${where} 应该是键值对对象或数组`);
  return kept;
}

/**
 * 分支链：新写法是 `branches: ["a", "b"]`（有序），老写法是单个 `branch: "a"`。
 * 两种都认，老配置不用改；同时给了就以 `branches` 为准。
 */
function parseBranches(record: Record<string, unknown>): string[] {
  const chain = textList(record.branches);
  if (chain.length > 0) return dedupe(chain);
  const legacy = text(record.branch);
  return legacy === "" ? [] : [legacy];
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    kept.push(item);
  }
  return kept;
}

/**
 * 子模块的分支链：配了就用配的，没配返回空数组（调用方按「跟随父仓库」处理）。
 *
 * 匹配是模糊的：`acme-web-admin` 能对上 `acme-web-admin`、
 * `packages/acme-web-admin`、`acme-web-admin-h5` 这些写法；多个命中取最长的那个。
 */
export function submoduleChain(repo: RepoRef, subPath: string): readonly string[] {
  return submoduleRule(repo, subPath)?.branches ?? [];
}

/** 命中的那条子模块配置；没配或没匹配上返回 undefined。 */
export function submoduleRule(repo: RepoRef, subPath: string): SubmoduleRef | undefined {
  const needle = normalizeWord(subPath);
  if (needle === "") return undefined;
  let best: SubmoduleRef | undefined;
  // `?? []` 是防御：老目标对象（或测试里手搓的）可能没有这个字段。
  for (const rule of repo.submodules ?? []) {
    const key = normalizeWord(rule.match);
    if (key === "" || rule.branches.length === 0) continue;
    if (!subPathMatches(needle, key)) continue;
    if (best === undefined || key.length > normalizeWord(best.match).length) best = rule;
  }
  return best;
}


/** 子模块路径是否命中一条配置（大小写不敏感；认全路径、末段、任意一段、子串）。 */
function subPathMatches(path: string, key: string): boolean {
  if (path === key) return true;
  if (path.endsWith(`/${key}`)) return true;
  const segments = path.split("/");
  if (segments.includes(key)) return true;
  return path.includes(key);
}

/** 序号最小的那个分支（改动落点）；没配分支时返回空串。 */
export function primaryBranch(repo: RepoRef): string {
  return repo.branches[0] ?? "";
}

/**
 * 显式指定的目标 id（`zentao_session_start` 的 targetId、页面下拉选的值）。
 * 允许写 name，省得人去记 id。
 */
export function findTarget(targets: readonly WorkspaceTarget[], idOrName: string): WorkspaceTarget | undefined {
  const needle = idOrName.trim().toLowerCase();
  if (needle === "") return undefined;
  return targets.find((item) => item.id.toLowerCase() === needle) ?? targets.find((item) => item.name.toLowerCase() === needle);
}

/**
 * 禅道对象 → 工作区目标。
 *
 * 顺序：显式 id > `zentaoProjects` 精确命中 > 名称/目录末段模糊命中 > 不猜。
 * 命中多个一律当「需要人选」，宁可多问一句，也别把 BUG 开到错的工作区。
 */
export function matchTarget(targets: readonly WorkspaceTarget[], query: TargetQuery, explicitId?: string): TargetMatch {
  if (targets.length === 0) {
    return { candidates: [], reason: "还没配置任何工作区目标（插件页 → 工作区与项目）。" };
  }
  if (explicitId !== undefined && explicitId.trim() !== "") {
    const explicit = findTarget(targets, explicitId);
    if (explicit === undefined) {
      return { candidates: targets, reason: `指定的目标 "${explicitId}" 不存在。` };
    }
    return { target: explicit, candidates: [], reason: `按指定目标命中 ${explicit.name}。` };
  }

  const hints = [query.projectName, query.productName].map(normalizeWord).filter((item) => item !== "");
  if (hints.length > 0) {
    const exact = targets.filter((target) => target.zentaoProjects.some((word) => hints.includes(normalizeWord(word))));
    if (exact.length === 1) {
      const only = exact[0];
      if (only !== undefined) return { target: only, candidates: [], reason: `禅道项目名精确命中 ${only.name}。` };
    }
    if (exact.length > 1) {
      return { candidates: exact, reason: `禅道项目名同时命中多个工作区（${exact.map((item) => item.name).join("、")}），需要人选。` };
    }
  }

  const fuzzy = targets.filter((target) => {
    const words = [normalizeWord(target.name), normalizeWord(lastSegment(target.path))].filter((item) => item !== "");
    return words.some((word) => hints.some((hint) => hint.includes(word) || word.includes(hint)));
  });
  if (fuzzy.length === 1) {
    const only = fuzzy[0];
    if (only !== undefined) return { target: only, candidates: [], reason: `按名称包含关系命中 ${only.name}。` };
  }
  if (fuzzy.length > 1) {
    return { candidates: fuzzy, reason: `名称包含关系同时命中多个工作区（${fuzzy.map((item) => item.name).join("、")}），需要人选。` };
  }
  return { candidates: targets, reason: "禅道项目名没能对上任何工作区，需要人选。" };
}

/** 实体类型的中文名，提示文案用。 */
export function kindLabel(kind: EntityKind): string {
  return kind === "bug" ? "BUG" : kind === "task" ? "任务" : "需求";
}

function lastSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last ?? "";
}

function normalizeWord(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,，;；]/)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
