/**
 * 旧会话查找层：同一条禅道单子再开工时，优先回到之前那个会话里继续。
 *
 * 定位规则按用户的话是「只认编号」——不看需求标题有没有改过，只认会话标题里那个
 * `#5967` 这样的编号。理由是禅道单子的标题会改（改了标题就不该另开一个会话），
 * 而编号是终身的。
 *
 * 为什么用宿主的 `sessionController.list()` 而不是自己记账：
 *   我们自己写的会话标题是「BUG #5967 原标题」（见 launcher.sessionTitle），
 *   而 session-title 服务把显式 rename 的标题钉成持久 title 投影——重启、换机器都还在。
 *   `list()` 又是纯读：不 resume、不激活 Agent、不烧 token，正好适合每次开工前扫一遍。
 */

import type { EntityKind } from "life-saver-core/domain/model.js";
import { kindLabel } from "../domain/targets.js";

/** 宿主 `sessionController.list()` 返回的一行（只声明用得上的字段）。 */
export interface SessionSummaryLike {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly updatedAt?: number;
  readonly running?: boolean;
  readonly blank?: boolean;
  readonly projections?: {
    readonly values?: {
      readonly title?: unknown;
    };
  };
}

/** 一行会话的标题：没有就返回 undefined（冷会话偶尔缺投影）。 */
export function titleOf(summary: SessionSummaryLike): string | undefined {
  const title = summary.projections?.values?.title;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;
}

/** 查旧会话的结果。 */
export interface LookupResult {
  /** 同一工作区里认出来的旧会话（有就用它，不再新建）。 */
  readonly found?: {
    readonly sessionId: string;
    readonly title: string;
    readonly updatedAt?: number;
    readonly running?: boolean;
    /** strict = 标题以「BUG #5967」这种规范前缀开头；loose = 只是标题里带了 `#5967`。 */
    readonly matched: "strict" | "loose";
  };
  /** 别的目录里也有同编号会话：不自动复用，但值得提醒人一句。 */
  readonly elsewhere: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly cwd: string;
  }[];
}

/** 归一化路径，用于比较「是不是同一个工作区」。 */
function normalize(path: string): string {
  return path.trim().replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * 在会话列表里找同编号的旧会话。
 *
 * @param summaries - `sessionController.list()` 的全量结果。
 * @param kind - 实体类型，和标题里的前缀对得上才算 strict。
 * @param id - 禅道编号。
 * @param cwd - 目标工作区路径；只有同一目录下的会话才复用。
 * @param excludeSessionId - 发起本次调用的那个会话（避免模型在自己里面让自己继续）。
 */
export function lookupSession(
  summaries: readonly SessionSummaryLike[],
  kind: EntityKind,
  id: number,
  cwd: string,
  excludeSessionId?: string,
): LookupResult {
  const wantedCwd = normalize(cwd);
  const label = kindLabel(kind);
  const strict = new RegExp(`^${escapeRegExp(label)}\\s*#\\s*${id}(?!\\d)`);
  const loose = new RegExp(`#\\s*${id}(?!\\d)`);

  const matched: LookupResult["found"][] = [];
  const elsewhere: { sessionId: string; title: string; cwd: string }[] = [];

  for (const summary of summaries) {
    if (summary.sessionId === excludeSessionId) continue;
    const title = titleOf(summary);
    if (title === undefined) continue;
    const isStrict = strict.test(title);
    if (!isStrict && !loose.test(title)) continue;

    const sessionCwd = summary.cwd;
    if (sessionCwd === undefined || normalize(sessionCwd) !== wantedCwd) {
      if (sessionCwd !== undefined) elsewhere.push({ sessionId: summary.sessionId, title, cwd: sessionCwd });
      continue;
    }
    matched.push({
      sessionId: summary.sessionId,
      title,
      matched: isStrict ? "strict" : "loose",
      ...(summary.updatedAt !== undefined ? { updatedAt: summary.updatedAt } : {}),
      ...(summary.running !== undefined ? { running: summary.running } : {}),
    });
  }

  // 规范前缀优先，其次最近活跃的：同一编号被开过两次时，回到最新那个。
  matched.sort((left, right) => {
    if (left?.matched !== right?.matched) return left?.matched === "strict" ? -1 : 1;
    return (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0);
  });

  const first = matched[0];
  return {
    ...(first !== undefined ? { found: first } : {}),
    elsewhere: elsewhere.sort((left, right) => left.cwd.localeCompare(right.cwd)),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
