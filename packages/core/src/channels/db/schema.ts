/**
 * 库结构探测：只问两件事——`zt_story` 有没有 `keywords` / `project` 列，
 * `zt_projectstory` 这张关联表在不在。
 *
 * 只查 `information_schema`，不碰业务表：探测本身不能变成一次全表扫描，
 * 也不能因为探测把只读账号的权限边界踩出去。两条查询就是全部预算。
 *
 * 探测失败不抛：上层读路径必须照常走，只是退回默认层，并在 status 里标
 * 「结构未确认」——**静默地用错 SQL** 比报一条错危险得多。
 */

import type { RowDataPacket } from "mysql2/promise";
import { DEFAULT_DB_FEATURES, type DbFeatures, type ProjectSource } from "../../domain/discovery.js";
import type { DbHandle } from "./pool.js";

export interface SchemaProbeResult {
  readonly features: DbFeatures;
  /** 探到的事实，给人看。 */
  readonly notes: readonly string[];
  /** 探测没做成的原因；不阻断读。 */
  readonly warnings: readonly string[];
}

interface NameRow extends RowDataPacket {
  readonly name: string | null;
}

export async function probeSchema(
  db: DbHandle,
  signal?: AbortSignal,
): Promise<SchemaProbeResult> {
  const storyTable = db.table("story");
  const relationTable = db.table("projectstory");
  const notes: string[] = [];
  const warnings: string[] = [];

  let columns: Set<string> | undefined;
  try {
    const rows = await db.query<NameRow>(
      `SELECT COLUMN_NAME AS name
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [storyTable],
      signal,
    );
    columns = new Set(rows.map((row) => (row.name ?? "").toLowerCase()).filter(Boolean));
  } catch (error) {
    if (isAbort(error)) throw error;
    warnings.push(
      `读 information_schema 失败（${message(error)}）：结构按默认值处理，搜索与「所属项目」可能不匹配这套库`,
    );
  }

  // 一列都没查到，多半不是「这张表恰好没这两列」，而是表根本不在
  // ——最常见的原因是 db.prefix 指错了，这时候报「结构未确认」比硬查更诚实。
  if (columns && columns.size === 0) {
    warnings.push(`库里找不到 ${storyTable}：请确认 db.prefix / db.database 指向的是禅道库`);
    columns = undefined;
  }

  let hasRelationTable: boolean | undefined;
  try {
    const rows = await db.query<NameRow>(
      `SELECT TABLE_NAME AS name
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [relationTable],
      signal,
    );
    hasRelationTable = rows.length > 0;
  } catch (error) {
    if (isAbort(error)) throw error;
    warnings.push(`查 ${relationTable} 是否存在失败（${message(error)}）：需求所属项目按关联表处理`);
  }

  const storyHasProject = columns?.has("project");
  const projectSource: ProjectSource =
    hasRelationTable === true
      ? "relation"
      : storyHasProject === true
        ? "story"
        : hasRelationTable === false && storyHasProject === false
          ? "none"
          : DEFAULT_DB_FEATURES.projectSource;

  const hasKeywords = columns?.has("keywords") ?? DEFAULT_DB_FEATURES.hasKeywords;
  const confirmed = columns !== undefined;

  if (columns) {
    notes.push(
      hasKeywords
        ? "搜索：标题 + keywords 两列都匹配"
        : "搜索：库里没有 keywords 列，只匹配标题（老版本禅道）",
    );
    notes.push(
      projectSource === "relation"
        ? "需求所属项目：取 zt_projectstory 关联表"
        : projectSource === "story"
          ? "需求所属项目：取 zt_story.project（老库）"
          : "需求所属项目：两处都没有，留空",
    );
  }

  return { features: { hasKeywords, projectSource, confirmed }, notes, warnings };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("取消"));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
