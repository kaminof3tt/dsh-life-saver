/**
 * 工时统计的契约。
 *
 * 唯一的按人来源是 zt_effort（biz 版把工时记在这张表；开源版是 zt_taskestimate）。
 * 一个很容易踩的坑：**不能用 zt_task.consumed 汇总**——库里大量历史任务的
 * consumed 有值但 effort 没有明细行，用 consumed 会算出「有工时但查不到做了什么事」。
 * 所以这里以 effort 为准，另外用 zt_action 补「有动作但没有工时」的漏项。
 */

import type { EntityKind } from "../domain/model.js";

/** 一条工时明细。 */
export interface WorklogEntry {
  readonly kind: EntityKind;
  readonly id: number;
  readonly title: string;
  /** 归属的项目/任务名（任务所属执行），给周报分类用。 */
  readonly projectName?: string;
  readonly date: string;
  readonly consumed: number;
  readonly left?: number;
  /** 这条工时干了什么（zt_effort.work）。 */
  readonly work?: string;
  readonly account: string;
  /** 该对象在当前区间内是否已经完成/关闭（周报里区分「已交付」与「进行中」）。 */
  readonly status?: string;
}

/** 按对象聚合后的一行。 */
export interface WorklogGroup {
  readonly kind: EntityKind;
  readonly id: number;
  readonly title: string;
  readonly projectName?: string;
  readonly status?: string;
  readonly consumed: number;
  readonly firstDate: string;
  readonly lastDate: string;
  /** 多条 work 摘要合并（去重、按出现顺序）。 */
  readonly notes: readonly string[];
}

/** 有动作、但区间内没有工时记录的对象（提醒用户「这些事没记工时」）。 */
export interface MissingWorklog {
  readonly kind: EntityKind;
  readonly id: number;
  readonly title: string;
  readonly actions: readonly string[];
  readonly lastDate: string;
}

export interface WorklogQuery {
  /** 不填则用配置里的禅道账号。 */
  readonly account: string;
  /** 含头含尾，YYYY-MM-DD。 */
  readonly from: string;
  readonly to: string;
  /** 只看某类对象；不填三类都算。 */
  readonly kind?: EntityKind;
  readonly signal?: AbortSignal;
}

export interface WorklogReport {
  readonly account: string;
  readonly from: string;
  readonly to: string;
  /** 总工时（小时，保留两位）。 */
  readonly total: number;
  /** 明细，按日期升序。 */
  readonly entries: readonly WorklogEntry[];
  /** 按对象聚合（工具层默认展示这个）。 */
  readonly groups: readonly WorklogGroup[];
  /** 逐日汇总，给「每天干了多少」用。 */
  readonly daily: readonly { readonly date: string; readonly consumed: number; readonly count: number }[];
  /** 有动作无工时，最多 20 条。 */
  readonly missing: readonly MissingWorklog[];
  readonly warnings: readonly string[];
}
