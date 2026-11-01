/**
 * 每个会话在某个仓库里的「现场记录」。
 *
 * 三样东西：
 *   - ticket：这个会话在处理哪张禅道单子（提交时写进 message 第一行）；
 *   - baseline：会话开工那一刻仓库是什么样（HEAD + 当时已经脏了的文件），
 *     提交时靠它把「开工前就脏的」和「本次动过的」分开；
 *   - files：上一次成功提交后，把 baseline 前移用的落脚点。
 *
 * 落盘位置是 `<repo>/.git/life-saver/<sessionKey>.json`——放 `.git` 里而不是工作区里，
 * 免得它自己变成未跟踪文件被下次提交带上；也不与其它会话共用一个文件（并行会话
 * 各写各的，不存在互相覆盖）。
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntityKind } from "life-saver-core/domain/model.js";

/** 会话与禅道单子的绑定。 */
export interface TicketBinding {
  readonly kind: EntityKind;
  readonly id: number;
  readonly title: string;
  readonly url?: string;
  /** 记录时间（ISO 字符串），排障时看是哪一次绑定的。 */
  readonly at: string;
}

/** 开工那一刻的仓库状态。 */
export interface RepoBaseline {
  /** 记录基线时的 HEAD。 */
  readonly head: string;
  /** 当时已经脏了的路径（仓库相对路径，正斜杠）。 */
  readonly dirty: readonly string[];
  readonly at: string;
}

/** 一个会话在一个仓库里的全部记录。 */
export interface SessionState {
  readonly ticket?: TicketBinding;
  readonly baseline?: RepoBaseline;
}

/** 会话 key：只留安全字符，空则退回 `default`（拿不到会话 id 时）。 */
export function sessionKeyOf(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (text === "") return "default";
  return text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function statePath(gitDir: string, key: string): string {
  return join(gitDir, "life-saver", `${key}.json`);
}

/** 读该会话的记录；文件不存在或坏了都当作空记录（坏文件不该挡住提交）。 */
export async function readState(gitDir: string, key: string): Promise<SessionState> {
  try {
    const text = await readFile(statePath(gitDir, key), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as { ticket?: unknown; baseline?: unknown };
    return {
      ...(isTicket(record.ticket) ? { ticket: record.ticket } : {}),
      ...(isBaseline(record.baseline) ? { baseline: record.baseline } : {}),
    };
  } catch {
    return {};
  }
}

/** 合并写回：只覆盖传进来的字段。 */
export async function writeState(gitDir: string, key: string, patch: SessionState): Promise<void> {
  const current = await readState(gitDir, key);
  const ticket = patch.ticket ?? current.ticket;
  const baseline = patch.baseline ?? current.baseline;
  const next: SessionState = {
    ...(ticket === undefined ? {} : { ticket }),
    ...(baseline === undefined ? {} : { baseline }),
  };
  const target = statePath(gitDir, key);
  await mkdir(join(gitDir, "life-saver"), { recursive: true });
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** 删掉该会话的记录（会话结束时可选清理；不删也不影响正确性）。 */
export async function clearState(gitDir: string, key: string): Promise<void> {
  await rm(statePath(gitDir, key), { force: true });
}

/**
 * 这个仓库里还有哪些会话留下过开工记录（不含自己）。
 *
 * 用途只有一个：判断「是不是有别的会话正在同一个工作区里干活」。有的话，默认的
 * 「开工后新出现的改动」就可能把对方正在改的文件也算进来——得如实提示，而不是
 * 假装隔离得很干净（git 本身记不住哪个文件是谁改的）。
 */
export async function otherSessions(gitDir: string, key: string): Promise<string[]> {
  try {
    const entries = await readdir(join(gitDir, "life-saver"));
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((name) => name !== key)
      .sort();
  } catch {
    return [];
  }
}

function isTicket(value: unknown): value is TicketBinding {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "story" || record.kind === "task" || record.kind === "bug") &&
    typeof record.id === "number" &&
    typeof record.title === "string" &&
    (record.url === undefined || typeof record.url === "string") &&
    typeof record.at === "string"
  );
}

function isBaseline(value: unknown): value is RepoBaseline {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.head === "string" &&
    Array.isArray(record.dirty) &&
    record.dirty.every((item) => typeof item === "string") &&
    typeof record.at === "string"
  );
}
