/**
 * 工时统计（只读库专有）。
 *
 * 口径以 `zt_effort` 为准，不用 `zt_task.consumed`：库里大量历史任务 consumed 有值
 * 但 effort 没有明细行，用 consumed 汇总会得到「有工时，但查不到干了什么」。
 *
 * 三个容易出错的点，这里都处理了：
 *   1. objectType 在 effort 里是 task/bug/story，但 story 的历史数据里可能写成
 *      requirement/epic，所以按并集过滤；
 *   2. 已删除的工时行 deleted=1 要排掉；
 *   3. 有动作但没记工时的情况单独列出来（recordworkhour 之外的 started/assigned
 *      也算「这事动过」），提醒用户补记，而不是假装工时是完整的。
 */

import type { RowDataPacket } from "mysql2/promise";
import type { EntityKind } from "../../domain/model.js";
import type { MissingWorklog, WorklogEntry, WorklogGroup, WorklogQuery, WorklogReport } from "../stats.js";
import type { DbHandle } from "./pool.js";

interface EffortRow extends RowDataPacket {
  readonly objectType: string | null;
  readonly objectID: number | null;
  readonly date: string | null;
  readonly consumed: string | number | null;
  readonly left: string | number | null;
  readonly work: string | null;
  readonly account: string | null;
}

interface TitleRow extends RowDataPacket {
  readonly id: number;
  readonly title: string | null;
  readonly status: string | null;
}

interface TaskExecRow extends RowDataPacket {
  readonly id: number;
  readonly execution: number | null;
}

/** zt_project 里的一行（项目/执行/项目集都在这张表）。 */
interface ProjectNodeRow extends RowDataPacket {
  readonly id: number;
  readonly name: string | null;
  readonly type: string | null;
  readonly parent: number | null;
}

interface TaskTitleRow extends RowDataPacket {
  readonly title: string | null;
}

interface ActionRow extends RowDataPacket {
  readonly objectType: string | null;
  readonly objectID: number | null;
  readonly action: string | null;
  readonly date: string | null;
}

/** 需求类对象在历史数据里的所有 objectType 写法。 */
const STORY_TYPES = ["story", "requirement", "epic"] as const;

/** effort 的 objectType → 领域实体类型。 */
function toKind(objectType: string | null): EntityKind | undefined {
  const value = (objectType ?? "").toLowerCase();
  if (value === "task") return "task";
  if (value === "bug") return "bug";
  if ((STORY_TYPES as readonly string[]).includes(value)) return "story";
  return undefined;
}

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 保留两位小数，避免 0.1+0.2 那种尾巴。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 校验 YYYY-MM-DD；统计区间不接受模糊日期，宁可直接报错。
 *
 * 除了形状，还要挡掉「形状对但日子不存在」的输入（2026-13-01、2026-02-30）。
 * 这类值扔进 SQL 的 BETWEEN 不会报错，只会静默查出空结果——比直接报错难查得多。
 */
export function assertDate(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${what} 需要 YYYY-MM-DD 格式，收到：${JSON.stringify(value)}`);
  }
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const asDate = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== (month ?? 1) - 1 ||
    asDate.getUTCDate() !== day
  ) {
    throw new Error(`${what} 不是真实存在的日期：${JSON.stringify(value)}（需要 YYYY-MM-DD）`);
  }
  return value;
}

/**
 * 按人 + 区间统计工时。
 *
 * 查询次数不固定：三类对象（task / bug / story）各一次标题查询、每个任务一次
 * 执行链查询（上限 20 次）、漏项一条聚合查询。再做纯内存聚合——数据量很小
 * （一个人一个月的工时通常几十行），没必要让 SQL 承担展示逻辑。
 */
export async function collectWorklog(db: DbHandle, query: WorklogQuery): Promise<WorklogReport> {
  const warnings: string[] = [];
  const rows = await db.query<EffortRow>(
    `SELECT objectType, objectID, \`date\`, consumed, \`left\`, work, account
       FROM ${db.table("effort")}
      WHERE account = ? AND deleted = 0 AND \`date\` BETWEEN ? AND ?
      ORDER BY \`date\`, id`,
    [query.account, query.from, query.to],
    query.signal,
  );

  const wanted = new Set<EntityKind>();
  for (const row of rows) {
    const kind = toKind(row.objectType);
    if (!kind) continue;
    if (query.kind && kind !== query.kind) continue;
    wanted.add(kind);
  }

  const meta = await loadMeta(db, rows, query, query.signal);
  const entries: WorklogEntry[] = [];
  for (const row of rows) {
    const kind = toKind(row.objectType);
    if (!kind) {
      warnings.push(`跳过一条无法识别的工时记录：objectType=${JSON.stringify(row.objectType)}`);
      continue;
    }
    if (query.kind && kind !== query.kind) continue;
    const id = row.objectID ?? 0;
    const info = meta.get(`${kind}:${id}`);
    entries.push({
      kind,
      id,
      title: info?.title ?? `${kind}#${id}`,
      projectName: info?.projectName,
      date: (row.date ?? "").slice(0, 10),
      consumed: num(row.consumed),
      left: row.left === null ? undefined : num(row.left),
      work: row.work?.trim() ? row.work.trim() : undefined,
      account: row.account ?? query.account,
      status: info?.status,
    });
  }

  const groups = groupByObject(entries);
  const daily = summarizeDaily(entries);
  const missing = await findMissingWorklogs(db, query, entries, wanted, warnings, query.signal);
  const total = round2(entries.reduce((sum, entry) => sum + entry.consumed, 0));

  return {
    account: query.account,
    from: query.from,
    to: query.to,
    total,
    entries,
    groups,
    daily,
    missing,
    warnings,
  };
}

/** 一次性把用到的对象标题/状态取回来，避免逐条查询。 */
async function loadMeta(
  db: DbHandle,
  rows: readonly EffortRow[],
  query: WorklogQuery,
  signal?: AbortSignal,
): Promise<Map<string, { title?: string; status?: string; projectName?: string }>> {
  const ids = { task: new Set<number>(), bug: new Set<number>(), story: new Set<number>() };
  for (const row of rows) {
    const kind = toKind(row.objectType);
    if (!kind || !row.objectID) continue;
    if (query.kind && kind !== query.kind) continue;
    ids[kind].add(row.objectID);
  }

  const out = new Map<string, { title?: string; status?: string; projectName?: string }>();

  const take = (kind: EntityKind, list: readonly TitleRow[]) => {
    for (const row of list) {
      out.set(`${kind}:${row.id}`, { title: row.title ?? undefined, status: row.status ?? undefined });
    }
  };

  if (ids.task.size > 0) {
    take(
      "task",
      await db.query<TitleRow>(
        `SELECT id, name AS title, status FROM ${db.table("task")}
          WHERE id IN (${placeholders(ids.task.size)})`,
        [...ids.task],
        signal,
      ),
    );
  }
  if (ids.bug.size > 0) {
    take(
      "bug",
      await db.query<TitleRow>(
        `SELECT id, title, status FROM ${db.table("bug")}
          WHERE id IN (${placeholders(ids.bug.size)})`,
        [...ids.bug],
        signal,
      ),
    );
  }
  if (ids.story.size > 0) {
    // 需求表没有 execution 列（层级靠 product / project），别照抄 task/bug 的列。
    take(
      "story",
      await db.query<TitleRow>(
        `SELECT id, title, status FROM ${db.table("story")}
          WHERE id IN (${placeholders(ids.story.size)})`,
        [...ids.story],
        signal,
      ),
    );
  }

  // 任务挂在执行上，执行挂在项目上；周报里「这个月做了哪些项目」靠这一列。
  // 注意：禅道的「执行」不是独立表——执行就是 zt_project 里 type=sprint/stage/kanban
  // 的行（本库没有 zt_execution，查它会直接报 ER_NO_SUCH_TABLE）。层级用 parent 串：
  // 执行.parent → 所属项目；若挂到看板上再一层，继续往上爬到 type='project'。
  if (ids.task.size > 0) {
    const taskRows = await db.query<TaskExecRow>(
      `SELECT id, execution FROM ${db.table("task")} WHERE id IN (${placeholders(ids.task.size)})`,
      [...ids.task],
      signal,
    );
    const executionIds = new Set<number>();
    for (const row of taskRows) if (row.execution) executionIds.add(row.execution);
    if (executionIds.size > 0) {
      const projectNames = await resolveProjectNames(db, [...executionIds], signal);
      for (const row of taskRows) {
        const projectName = row.execution ? projectNames.get(row.execution) : undefined;
        if (!projectName) continue;
        const current = out.get(`task:${row.id}`);
        if (current) out.set(`task:${row.id}`, { ...current, projectName });
      }
    }
  }

  return out;
}

/**
 * 由执行 id 反推「所属项目名」。
 *
 * zt_project 一张表同时装项目(type=project)、执行(sprint/stage/kanban)和项目集(program)，
 * 所以沿 parent 往上找到 type='project' 那一层即可；找不到就退回执行自己的名字。
 * 最多爬 4 层，防止脏数据成环。
 */
async function resolveProjectNames(
  db: DbHandle,
  executionIds: readonly number[],
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (executionIds.length === 0) return names;

  const visited = new Map<number, ProjectNodeRow>();
  let pending = [...new Set(executionIds)];
  for (let depth = 0; depth < 4 && pending.length > 0; depth += 1) {
    const missing = pending.filter((id) => !visited.has(id));
    if (missing.length === 0) break;
    const rows = await db.query<ProjectNodeRow>(
      `SELECT id, name, type, parent FROM ${db.table("project")}
        WHERE id IN (${placeholders(missing.length)})`,
      missing,
      signal,
    );
    for (const row of rows) visited.set(row.id, row);
    pending = rows
      .map((row) => row.parent ?? 0)
      .filter((id) => id > 0 && !visited.has(id));
  }

  for (const id of executionIds) {
    let cursor = visited.get(id);
    const own = cursor?.name ?? undefined;
    let chosen: string | undefined;
    let hops = 0;
    while (cursor && hops < 5) {
      if (cursor.type === "project") {
        chosen = cursor.name ?? undefined;
        break;
      }
      const parentId = cursor.parent ?? 0;
      cursor = parentId > 0 ? visited.get(parentId) : undefined;
      hops += 1;
    }
    const label = chosen ?? own;
    if (label) names.set(id, label);
  }
  return names;
}

/**
 * 有动作但没工时的对象。
 *
 * 只取「人真的动过手」的动作：assigned/opened 这种是别人派给你或系统生成，
 * 算进漏项会把列表撑爆；started/finished/closed/resolved/recordworkhour 才代表
 * 「这件事你在做」。recordworkhour 本身也可能漏（有动作无 effort 行），所以也看一眼。
 */
async function findMissingWorklogs(
  db: DbHandle,
  query: WorklogQuery,
  entries: readonly WorklogEntry[],
  wanted: ReadonlySet<EntityKind>,
  warnings: string[],
  signal?: AbortSignal,
): Promise<MissingWorklog[]> {
  const kinds = query.kind ? [query.kind] : [...wanted];
  if (kinds.length === 0) kinds.push("task", "bug");
  const types = kinds.flatMap((kind) => (kind === "story" ? [...STORY_TYPES] : [kind]));
  if (types.length === 0) return [];

  const rows = await db.query<ActionRow>(
    `SELECT objectType, objectID, action, \`date\`
       FROM ${db.table("action")}
      WHERE actor = ? AND \`date\` BETWEEN ? AND ?
        AND objectType IN (${placeholders(types.length)})
        AND action IN ('started','finished','closed','resolved','recordestimate','activated','canceled','paused')
      ORDER BY \`date\` DESC
      LIMIT 500`,
    [query.account, `${query.from} 00:00:00`, `${query.to} 23:59:59`, ...types],
    signal,
  );

  const covered = new Set(entries.map((entry) => `${entry.kind}:${entry.id}`));
  const bucket = new Map<string, { kind: EntityKind; id: number; actions: string[]; lastDate: string }>();
  for (const row of rows) {
    const kind = toKind(row.objectType);
    if (!kind || !row.objectID) continue;
    const key = `${kind}:${row.objectID}`;
    if (covered.has(key)) continue;
    const existing = bucket.get(key);
    const action = row.action ?? "";
    const date = (row.date ?? "").slice(0, 10);
    if (existing) {
      if (!existing.actions.includes(action)) existing.actions.push(action);
      if (date > existing.lastDate) existing.lastDate = date;
    } else {
      bucket.set(key, { kind, id: row.objectID, actions: [action], lastDate: date });
    }
  }

  if (bucket.size === 0) return [];
  const ids = [...bucket.values()];
  if (ids.length >= 20) warnings.push(`有 ${ids.length} 个对象动过手但没记工时，这里只列前 20 个`);

  const out: MissingWorklog[] = [];
  for (const item of ids.slice(0, 20)) {
    const info = await db.one<TaskTitleRow>(
      item.kind === "bug"
        ? `SELECT title FROM ${db.table("bug")} WHERE id = ?`
        : item.kind === "task"
          ? `SELECT name AS title FROM ${db.table("task")} WHERE id = ?`
          : `SELECT title FROM ${db.table("story")} WHERE id = ?`,
      [item.id],
      signal,
    );
    out.push({ ...item, title: info?.title ?? `${item.kind}#${item.id}` });
  }
  return out;
}

function groupByObject(entries: readonly WorklogEntry[]): WorklogGroup[] {
  interface Acc {
    kind: EntityKind;
    id: number;
    title: string;
    projectName?: string;
    status?: string;
    consumed: number;
    firstDate: string;
    lastDate: string;
    notes: string[];
  }
  const map = new Map<string, Acc>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.id}`;
    const existing = map.get(key);
    if (existing) {
      existing.consumed = round2(existing.consumed + entry.consumed);
      if (entry.date < existing.firstDate) existing.firstDate = entry.date;
      if (entry.date > existing.lastDate) existing.lastDate = entry.date;
      if (entry.work && !existing.notes.includes(entry.work)) existing.notes.push(entry.work);
      continue;
    }
    map.set(key, {
      kind: entry.kind,
      id: entry.id,
      title: entry.title,
      projectName: entry.projectName,
      status: entry.status,
      consumed: entry.consumed,
      firstDate: entry.date,
      lastDate: entry.date,
      notes: entry.work ? [entry.work] : [],
    });
  }
  return [...map.values()].sort((a, b) => b.consumed - a.consumed);
}

function summarizeDaily(entries: readonly WorklogEntry[]): { date: string; consumed: number; count: number }[] {
  const map = new Map<string, { consumed: number; count: number }>();
  for (const entry of entries) {
    const existing = map.get(entry.date);
    if (existing) {
      existing.consumed = round2(existing.consumed + entry.consumed);
      existing.count += 1;
    } else {
      map.set(entry.date, { consumed: entry.consumed, count: 1 });
    }
  }
  return [...map.entries()]
    .map(([date, value]) => ({ date, consumed: value.consumed, count: value.count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 生成 N 个问号占位符。 */
function placeholders(count: number): string {
  return Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
}
