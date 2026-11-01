/**
 * 写操作的通道契约。
 *
 * 和读一样，这里只描述「要做什么」，不描述「怎么做」：
 * 上层拿到一个动作名 + 一堆可选参数，至于是走禅道页面还是直接改库，
 * 由通道自己决定。两条线的语义已经逐句对齐过禅道源码
 * （module/task/model.php、module/bug/model.php），所以同一份请求
 * 在两条线上应该产生等价的库内结果。
 *
 * 一个刻意的取舍：**没有 dry-run**。用户明确要求默认真写，
 * 防误触靠 service 层的六道护栏（先读后写、状态白名单、归属校验、
 * expectStatus 断言、写后自校验、单条不批量），而不是靠「先预览一遍」。
 */

import type { ChannelName } from "../domain/model.js";

/** 支持写的实体类型。需求（story）暂不支持。 */
export type WriteKind = "task" | "bug";

/**
 * 任务动作。与禅道 control 层的 action 名一一对应：
 * start→Started（left=0 时是 Finished）、finish→Finished、pause→Paused、
 * close→Closed、cancel→Canceled、activate→Activated、
 * recordworkhour→RecordEstimate、comment→Commented。
 */
export type TaskWriteAction =
  | "start"
  | "recordworkhour"
  | "finish"
  | "pause"
  | "activate"
  | "close"
  | "cancel"
  | "comment";

/**
 * BUG 动作：confirm→bugConfirmed、resolve→Resolved、close→Closed、comment→Commented、
 * recordworkhour→RecordEstimate。
 *
 * recordworkhour 在 BUG 上走的是 biz 版独立的「日志」模块（`?m=effort&f=createForObject`），
 * 不是 task 那套 `?m=task&f=recordworkhour`；库内只写 zt_effort + action + actionrecent + history，
 * 不动 zt_bug 的业务字段（zt_bug 根本没有 consumed 列）。
 */
export type BugWriteAction = "confirm" | "resolve" | "close" | "comment" | "recordworkhour";

export type WriteAction = TaskWriteAction | BugWriteAction;

export const TASK_ACTIONS: readonly TaskWriteAction[] = [
  "start",
  "recordworkhour",
  "finish",
  "pause",
  "activate",
  "close",
  "cancel",
  "comment",
];

export const BUG_ACTIONS: readonly BugWriteAction[] = [
  "confirm",
  "resolve",
  "close",
  "comment",
  "recordworkhour",
];

/** 禅道 zt_bug.resolution 的取值（来自 module/bug/lang/zh-cn.php + 库内实测）。 */
export const RESOLUTIONS = [
  "fixed",
  "external",
  "willnotfix",
  "notrepro",
  "bydesign",
  "duplicate",
  "tostory",
  "postponed",
  "productized",
] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

/** 一次写请求。字段按动作取用，用不上的留空即可。 */
export interface WriteRequest {
  readonly kind: WriteKind;
  readonly id: number;
  readonly action: WriteAction;
  /** 备注/评论正文；写进 action.comment，也是工时行 work 的默认值。 */
  readonly comment?: string;
  /** start/recordworkhour 本次消耗工时（小时）；finish 下表示「收尾时再补记的工时」。 */
  readonly consumed?: number;
  /** 剩余工时。start/activate 必填（禅道 task.activate.left 是必填项）。 */
  readonly left?: number;
  /** 记工时的日期（YYYY-MM-DD），默认今天；BUG 的「日志」用它当 dates 字段。 */
  readonly date?: string;
  /** 开始时间（YYYY-MM-DD HH:mm:ss）；不填用原值或当前时间。 */
  readonly realStarted?: string;
  /** 完成时间；不填用当前时间。 */
  readonly finishedDate?: string;
  /** 指派给；不填按禅道默认（见各动作注释）。 */
  readonly assignedTo?: string;
  /** bug resolve 的解决方案，见 RESOLUTIONS。 */
  readonly resolution?: string;
  /** bug resolve 的解决版本；resolution=fixed 时必填。 */
  readonly resolvedBuild?: string;
  /** bug resolve 的重复 BUG 编号；resolution=duplicate 时必填。 */
  readonly duplicateBug?: number;
  /** 调用方断言「写之前实体应该是这个状态」，不匹配就拒绝执行。 */
  readonly expectStatus?: string;
  readonly signal?: AbortSignal;
}

/** 写前/写后的关键字段快照，给工具层做「变了什么」的展示。 */
export interface WriteSnapshot {
  readonly status: string;
  readonly assignedTo: string;
  /**
   * `assignedTo` 的账号码（HTTP 线 `assignedTo` 是中文名，这里才是 `zhangsan` 那种）。
   *
   * `start` / `activate` 必须显式回填它：禅道的这两个表单里「指派给」是个下拉框，
   * 我们不带这个字段提交时它会被写成空串——实测踩过（一次 activate 把指派人清空了）。
   */
  readonly assignedToAccount?: string;
  readonly consumed: number;
  readonly left: number;
  /** 仅 BUG 有。 */
  readonly confirmed?: number;
  /** 仅 BUG 有。 */
  readonly resolution?: string;
}

/** 写结果。after 是**回读后**的真实值，不是我们以为写进去的值。 */
export interface WriteOutcome {
  readonly channel: ChannelName;
  readonly kind: WriteKind;
  readonly id: number;
  readonly action: WriteAction;
  /** 禅道那一侧产生的动作名（Started/Finished/Resolved…），用于对账。 */
  readonly actionName: string;
  readonly before: WriteSnapshot;
  readonly after: WriteSnapshot;
  /** 人话总结，工具层直接展示。 */
  readonly message: string;
  /** 不影响成功、但用户应该知道的事（例如「没有通知到任何人」「看板泳道没刷新」）。 */
  readonly warnings: readonly string[];
}

/** 动作名 → 中文，给提示文案用。 */
export const ACTION_LABELS: Readonly<Record<WriteAction, string>> = {
  start: "开始",
  recordworkhour: "记录工时",
  finish: "完成",
  pause: "暂停",
  activate: "激活",
  close: "关闭",
  cancel: "取消",
  confirm: "确认",
  resolve: "解决",
  comment: "备注",
};
