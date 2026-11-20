import type { EntityKind } from "../domain/model.js";

export interface SubmoduleRef {
  readonly match: string;
  readonly branches: readonly string[];
}

export interface RepoRef {
  readonly role: string;
  readonly path: string;
  readonly gitUrl: string;
  readonly branches: readonly string[];
  readonly submodules?: readonly SubmoduleRef[];
}

export interface WorkspaceTarget {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly zentaoProjects: readonly string[];
  readonly repos: readonly RepoRef[];
}

export interface TargetParseResult {
  readonly targets: readonly WorkspaceTarget[];
  readonly errors: readonly string[];
}

export interface TargetQuery {
  readonly projectName?: string;
  readonly productName?: string;
  readonly moduleName?: string;
  readonly title: string;
}

export interface TargetMatch {
  readonly target?: WorkspaceTarget;
  readonly candidates: readonly WorkspaceTarget[];
  readonly reason: string;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

export function normalizePath(path: string): string {
  return path.trim().replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

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
  const path = text(record.path);
  if (name === "") {
    errors.push(`${where}.name 不能为空`);
    return undefined;
  }
  if (path === "" || !isAbsolutePath(path)) {
    errors.push(`${where}.path 必须是绝对路径（当前：${path === "" ? "空" : path}）`);
    return undefined;
  }
  const id = text(record.id) !== "" ? slug(text(record.id)) : slug(name) || `target-${index + 1}`;
  const repos: RepoRef[] = [];
  const rawRepos = record.repos;
  if (rawRepos !== undefined && rawRepos !== null) {
    if (!Array.isArray(rawRepos)) errors.push(`${where}.repos 必须是数组`);
    else {
      rawRepos.forEach((rawRepo, repoIndex) => {
        const repo = parseRepo(rawRepo, `${where}.repos[${repoIndex}]`, errors);
        if (repo !== undefined) repos.push(repo);
      });
    }
  }
  return { id, name, path, zentaoProjects: textList(record.zentaoProjects), repos };
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
  const role = text(record.role) || "仓库";
  return {
    role,
    path,
    gitUrl: text(record.gitUrl),
    branches: parseBranches(record),
    submodules: parseSubmodules(record.submodules, `${where}.submodules`, errors),
  };
}

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

export function submoduleChain(repo: RepoRef, subPath: string): readonly string[] {
  return submoduleRule(repo, subPath)?.branches ?? [];
}

export function submoduleRule(repo: RepoRef, subPath: string): SubmoduleRef | undefined {
  const needle = normalizeWord(subPath);
  if (needle === "") return undefined;
  let best: SubmoduleRef | undefined;
  for (const rule of repo.submodules ?? []) {
    const key = normalizeWord(rule.match);
    if (key === "" || rule.branches.length === 0 || !subPathMatches(needle, key)) continue;
    if (best === undefined || key.length > normalizeWord(best.match).length) best = rule;
  }
  return best;
}

function subPathMatches(path: string, key: string): boolean {
  return path === key || path.endsWith(`/${key}`) || path.split("/").includes(key) || path.includes(key);
}

export function primaryBranch(repo: RepoRef): string {
  return repo.branches[0] ?? "";
}

export function findTarget(targets: readonly WorkspaceTarget[], idOrName: string): WorkspaceTarget | undefined {
  const needle = idOrName.trim().toLowerCase();
  if (needle === "") return undefined;
  return (
    targets.find((item) => item.id.toLowerCase() === needle) ??
    targets.find((item) => item.name.toLowerCase() === needle)
  );
}

export function matchTarget(
  targets: readonly WorkspaceTarget[],
  query: TargetQuery,
  explicitId?: string,
): TargetMatch {
  if (targets.length === 0) {
    return { candidates: [], reason: "还没配置任何工作区目标（插件页 → 工作区与项目）。" };
  }
  if (explicitId !== undefined && explicitId.trim() !== "") {
    const explicit = findTarget(targets, explicitId);
    if (explicit === undefined) return { candidates: targets, reason: `指定的目标 "${explicitId}" 不存在。` };
    return { target: explicit, candidates: [], reason: `按指定目标命中 ${explicit.name}。` };
  }

  const hints = [query.projectName, query.productName].map(normalizeWord).filter((item) => item !== "");
  if (hints.length > 0) {
    const exact = targets.filter((target) => target.zentaoProjects.some((word) => hints.includes(normalizeWord(word))));
    const onlyExact = exact[0];
    if (onlyExact !== undefined && exact.length === 1) return { target: onlyExact, candidates: [], reason: `禅道项目名精确命中 ${onlyExact.name}。` };
    if (exact.length > 1) {
      return { candidates: exact, reason: `禅道项目名同时命中多个工作区（${exact.map((item) => item.name).join("、")}），需要人选。` };
    }
  }

  const fuzzy = targets.filter((target) => {
    const words = [normalizeWord(target.name), normalizeWord(lastSegment(target.path))].filter((item) => item !== "");
    return words.some((word) => hints.some((hint) => hint.includes(word) || word.includes(hint)));
  });
  const onlyFuzzy = fuzzy[0];
  if (onlyFuzzy !== undefined && fuzzy.length === 1) return { target: onlyFuzzy, candidates: [], reason: `按名称包含关系命中 ${onlyFuzzy.name}。` };
  if (fuzzy.length > 1) {
    return { candidates: fuzzy, reason: `名称包含关系同时命中多个工作区（${fuzzy.map((item) => item.name).join("、")}），需要人选。` };
  }
  return { candidates: targets, reason: "禅道项目名没能对上任何工作区，需要人选。" };
}

export function kindLabel(kind: EntityKind): string {
  return kind === "bug" ? "BUG" : kind === "task" ? "任务" : "需求";
}

function lastSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
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
