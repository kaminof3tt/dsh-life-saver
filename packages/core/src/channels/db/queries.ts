/**
 * 禅道只读库的全部 SQL，集中在这一个文件里。
 *
 * 为什么集中：读代码的人一眼能看到「这个插件到底读了哪些表、读了哪些列」，
 * 而不用在映射逻辑里翻。也正因为集中，表前缀与列名的变化只有一处要改。
 *
 * 所有值一律走占位符；表名由 DbHandle.table() 拼，前缀已校验。
 * 库里存的是禅道的既有事实（HTML 正文、逗号分隔的 file id 列表等），
 * 清洗留给领域层，这一层只负责「取准」。
 */

import type { RowDataPacket } from "mysql2/promise";

import { DEFAULT_DB_FEATURES, type DbFeatures } from "../../domain/discovery.js";
import type { DbHandle } from "./pool.js";

/** 附件行的公共形状（zt_file）。 */
export interface FileRow extends RowDataPacket {
  readonly id: number;
  readonly title: string | null;
  readonly extension: string | null;
  readonly size: number | null;
  readonly pathname: string | null;
  readonly addedBy: string | null;
  readonly addedDate: string | null;
}

/** 操作记录行（zt_action）。 */
export interface ActionRow extends RowDataPacket {
  readonly id: number;
  readonly actor: string | null;
  readonly action: string | null;
  readonly date: string | null;
  readonly comment: string | null;
  readonly files: string | null;
}

export interface StoryRow extends RowDataPacket {
  readonly id: number;
  readonly type: string | null;
  readonly title: string | null;
  readonly status: string | null;
  readonly stage: string | null;
  readonly pri: number | null;
  readonly estimate: number | null;
  readonly product: number | null;
  readonly module: number | null;
  readonly project: number | null;
  readonly parent: number | null;
  readonly openedBy: string | null;
  readonly openedDate: string | null;
  readonly assignedTo: string | null;
}

export interface StorySpecRow extends RowDataPacket {
  readonly version: number;
  readonly title: string | null;
  readonly spec: string | null;
  readonly verify: string | null;
  readonly files: string | null;
}

export interface TaskRow extends RowDataPacket {
  readonly id: number;
  readonly name: string | null;
  readonly status: string | null;
  readonly pri: number | null;
  readonly estimate: number | null;
  readonly consumed: number | null;
  readonly left: number | null;
  readonly desc: string | null;
  readonly project: number | null;
  readonly execution: number | null;
  readonly module: number | null;
  readonly story: number | null;
  readonly openedBy: string | null;
  readonly openedDate: string | null;
  readonly assignedTo: string | null;
  readonly finishedBy: string | null;
  readonly finishedDate: string | null;
  readonly deadline: string | null;
  readonly deleted: string | null;
}

export interface BugRow extends RowDataPacket {
  readonly id: number;
  readonly title: string | null;
  readonly status: string | null;
  readonly pri: number | null;
  readonly severity: number | null;
  readonly type: string | null;
  readonly product: number | null;
  readonly module: number | null;
  readonly project: number | null;
  readonly execution: number | null;
  readonly story: number | null;
  readonly task: number | null;
  readonly steps: string | null;
  readonly openedBy: string | null;
  readonly openedDate: string | null;
  readonly assignedTo: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedDate: string | null;
  readonly resolution: string | null;
  readonly confirmed: number | null;
  readonly deleted: string | null;
}

export interface NameRow extends RowDataPacket {
  readonly name: string | null;
}

/** 需求类附件的 objectType 全集；历史数据里三种都可能出现，取并集避免漏。 */
const STORY_OBJECT_TYPES = ["story", "requirement", "epic"] as const;

/**
 * 需求的「所属项目」在不同禅道版本里落点不同：新版把需求挂到项目上是通过
 * `zt_projectstory` 关联表，`zt_story` 里根本没有 project 列（老版本才有）。
 * 走哪一边由 `features` 决定（探测结果 / 用户配置 / 默认层，见 domain/discovery.ts），
 * 而不是在代码里赌一个版本。
 */
const storyProjectExpr = (db: DbHandle, features: DbFeatures = DEFAULT_DB_FEATURES): string => {
  if (features.projectSource === "none") return "NULL AS project";
  if (features.projectSource === "story") return "project";
  return `(SELECT ps.project FROM ${db.table("projectstory")} ps
              WHERE ps.story = ${db.table("story")}.id
              ORDER BY ps.project DESC LIMIT 1) AS project`;
};

export async function findStory(
  db: DbHandle,
  id: number,
  features: DbFeatures = DEFAULT_DB_FEATURES,
): Promise<StoryRow | undefined> {
  return db.one<StoryRow>(
    `SELECT id, type, title, status, stage, pri, estimate, product, module, ${storyProjectExpr(db, features)}, parent,
            openedBy, openedDate, assignedTo
       FROM ${db.table("story")}
      WHERE id = ? AND deleted = '0'`,
    [id],
  );
}

/** 正文取最新版本；历史版本对「我要看需求」这个用途没有价值。 */
export async function findLatestSpec(db: DbHandle, storyId: number): Promise<StorySpecRow | undefined> {
  return db.one<StorySpecRow>(
    `SELECT version, title, spec, verify, files
       FROM ${db.table("storyspec")}
      WHERE story = ?
      ORDER BY version DESC
      LIMIT 1`,
    [storyId],
  );
}

export async function findTask(db: DbHandle, id: number): Promise<TaskRow | undefined> {
  return db.one<TaskRow>(
    `SELECT id, name, status, pri, estimate, consumed, \`left\`, \`desc\`, project, execution,
            module, story, openedBy, openedDate, assignedTo, finishedBy, finishedDate, deadline, deleted
       FROM ${db.table("task")}
      WHERE id = ? AND deleted = '0'`,
    [id],
  );
}

export async function findBug(db: DbHandle, id: number): Promise<BugRow | undefined> {
  return db.one<BugRow>(
    `SELECT id, title, status, pri, severity, type, product, module, project, execution, story, task,
            steps, openedBy, openedDate, assignedTo, resolvedBy, resolvedDate, resolution, confirmed, deleted
       FROM ${db.table("bug")}
      WHERE id = ? AND deleted = '0'`,
    [id],
  );
}

export async function findFiles(
  db: DbHandle,
  objectType: "story" | "task" | "bug",
  objectId: number,
): Promise<FileRow[]> {
  if (objectType === "story") {
    const placeholders = STORY_OBJECT_TYPES.map(() => "?").join(", ");
    return db.query<FileRow>(
      `SELECT id, title, extension, size, pathname, addedBy, addedDate
         FROM ${db.table("file")}
        WHERE objectType IN (${placeholders}) AND objectID = ? AND deleted = '0'
        ORDER BY id`,
      [...STORY_OBJECT_TYPES, String(objectId)],
    );
  }
  return db.query<FileRow>(
    `SELECT id, title, extension, size, pathname, addedBy, addedDate
       FROM ${db.table("file")}
      WHERE objectType = ? AND objectID = ? AND deleted = '0'
      ORDER BY id`,
    [objectType, String(objectId)],
  );
}

export async function findActions(
  db: DbHandle,
  objectType: "story" | "task" | "bug",
  objectId: number,
): Promise<ActionRow[]> {
  // zt_action 里需求类对象统一记在 objectType='story' 下，与 zt_file 的分法不同。
  const types = objectType === "story" ? STORY_OBJECT_TYPES : ([objectType] as const);
  const placeholders = types.map(() => "?").join(", ");
  return db.query<ActionRow>(
    `SELECT id, actor, action, date, comment, files
       FROM ${db.table("action")}
      WHERE objectType IN (${placeholders}) AND objectID = ?
      ORDER BY id`,
    [...types, String(objectId)],
  );
}

export async function findName(
  db: DbHandle,
  table: "product" | "module" | "project",
  id: number | null,
): Promise<string | undefined> {
  if (!id) return undefined;
  const row = await db.one<NameRow>(`SELECT name FROM ${db.table(table)} WHERE id = ?`, [id]);
  return row?.name ?? undefined;
}

/** 需求标题（任务/缺陷里展示关联需求时用）。 */
export async function findStoryTitle(db: DbHandle, id: number): Promise<string | undefined> {
  const row = await db.one<NameRow>(`SELECT title AS name FROM ${db.table("story")} WHERE id = ?`, [id]);
  return row?.name ?? undefined;
}

/** 关键词搜索：三类对象各查一次，按 id 排序后合并。 */
export async function searchStories(
  db: DbHandle,
  like: string,
  limit: number,
  features: DbFeatures = DEFAULT_DB_FEATURES,
): Promise<StoryRow[]> {
  // 老版本禅道没有 zt_story.keywords；探不到就只按标题匹配，好过整个搜索报 SQL 错。
  const run = async (usable: DbFeatures): Promise<StoryRow[]> => {
    const where = usable.hasKeywords ? "(title LIKE ? OR keywords LIKE ?)" : "title LIKE ?";
    const params = usable.hasKeywords ? [like, like, limit] : [like, limit];
    return db.query<StoryRow>(
      `SELECT id, type, title, status, stage, pri, estimate, product, module, ${storyProjectExpr(db, usable)}, parent,
              openedBy, openedDate, assignedTo
         FROM ${db.table("story")}
        WHERE deleted = '0' AND ${where}
        ORDER BY id DESC
        LIMIT ?`,
      params,
    );
  };
  return withKeywordFallback(run, features);
}

export async function searchTasks(db: DbHandle, like: string, limit: number): Promise<TaskRow[]> {
  return db.query<TaskRow>(
    `SELECT id, name, status, pri, estimate, consumed, \`left\`, \`desc\`, project, execution,
            module, story, openedBy, openedDate, assignedTo, finishedBy, finishedDate, deadline, deleted
       FROM ${db.table("task")}
      WHERE deleted = '0' AND name LIKE ?
      ORDER BY id DESC
      LIMIT ?`,
    [like, limit],
  );
}

export async function searchBugs(
  db: DbHandle,
  like: string,
  limit: number,
  features: DbFeatures = DEFAULT_DB_FEATURES,
): Promise<BugRow[]> {
  const run = async (usable: DbFeatures): Promise<BugRow[]> => {
    const where = usable.hasKeywords ? "(title LIKE ? OR keywords LIKE ?)" : "title LIKE ?";
    const params = usable.hasKeywords ? [like, like, limit] : [like, limit];
    return db.query<BugRow>(
      `SELECT id, title, status, pri, severity, type, product, module, project, execution, story, task,
              steps, openedBy, openedDate, assignedTo, resolvedBy, resolvedDate, resolution, confirmed, deleted
         FROM ${db.table("bug")}
        WHERE deleted = '0' AND ${where}
        ORDER BY id DESC
        LIMIT ?`,
      params,
    );
  };
  return withKeywordFallback(run, features);
}

/**
 * 搜索的兜底：结构还没探过时，默认假设「有 keywords 列」；老库直接撞
 * `Unknown column 'xxx.keywords'`。换一套禅道往往先搜索、后体检，
 * 所以撞上就退成只匹配标题重来一次，别让第一次搜索就报 SQL 错。
 *
 * 只在 `confirmed === false` 时退：结构和用户覆盖都已经认定了，再偷偷改
 * 等于把「配错了」伪装成「配好了」。
 */
async function withKeywordFallback<T>(
  run: (features: DbFeatures) => Promise<T>,
  features: DbFeatures,
): Promise<T> {
  try {
    return await run(features);
  } catch (error) {
    if (features.hasKeywords && !features.confirmed && isMissingKeywordsColumn(error)) {
      return await run({ ...features, hasKeywords: false });
    }
    throw error;
  }
}

/** 认「缺 keywords 列」这一种错：别的 ER_BAD_FIELD_ERROR（比如少了 project 列）不能混进来。 */
function isMissingKeywordsColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return (code === "ER_BAD_FIELD_ERROR" || /Unknown column/i.test(message)) && /keywords/i.test(message);
}

/** 探活：一条极轻的查询，只为确认「连得上、账号有 SELECT 权限」。 */
export async function ping(db: DbHandle): Promise<void> {
  await db.one(`SELECT 1 AS ok FROM ${db.table("story")} LIMIT 1`);
}
