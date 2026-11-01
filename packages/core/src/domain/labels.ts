/**
 * 禅道枚举值的中文文案，以及反查表。
 *
 * 为什么要有这一层：同一件事在两条通道上写法不同——库里是 `doing`，页面上是
 * 「进行中」。展示要中文（用户看禅道就是这么看的），但**任何比较都必须用机器码**，
 * 否则「状态白名单」「归属校验」会被语言的表面差异挡住。
 *
 * 这里的中文取自 `zt_history` 的 `newValue`（禅道自己写进历史面板的显示名），
 * 不是凭印象翻的：`fixed` 是「已解决」不是「已修复」，`willnotfix` 是「不予解决」
 * 不是「不予修复」，这类差别会直接体现成历史记录里的文案不一致。
 */

/** 任务/BUG 状态 → 中文。取自 zt_history.field='status' 的 newValue 分布。 */
export const STATUS_LABEL: Readonly<Record<string, string>> = {
  wait: "未开始",
  doing: "进行中",
  done: "已完成",
  pause: "已暂停",
  cancel: "已取消",
  closed: "已关闭",
  active: "激活",
  resolved: "已解决",
  reviewing: "评审中",
  changing: "变更中",
  draft: "草稿",
  normal: "正常",
};

/**
 * 中文 → 状态机器码。
 *
 * 除了主文案，还收了历史里出现过的旧版说法（`结束` 是老版本对 closed 的叫法，
 * 出现 11 次）——老页面上可能还在用。
 */
const STATUS_ALIASES: Readonly<Record<string, string>> = {
  结束: "closed",
  已关闭: "closed",
  关闭: "closed",
  已解决: "resolved",
  解决: "resolved",
  已完成: "done",
  完成: "done",
  激活: "active",
  评审中: "reviewing",
  进行中: "doing",
  已取消: "cancel",
  取消: "cancel",
  已暂停: "pause",
  暂停: "pause",
  变更中: "changing",
  正常: "normal",
  草稿: "draft",
  未开始: "wait",
};

/** BUG 解决方案 → 中文。取自 zt_history.field='resolution' 的 newValue 分布。 */
export const RESOLUTION_LABEL: Readonly<Record<string, string>> = {
  fixed: "已解决",
  external: "外部原因",
  willnotfix: "不予解决",
  notrepro: "无法重现",
  bydesign: "设计如此",
  duplicate: "重复Bug",
  tostory: "转为研发需求",
  postponed: "延期处理",
  productized: "产品线调整",
};

/** BUG 关闭原因 → 中文。 */
export const CLOSED_REASON_LABEL: Readonly<Record<string, string>> = {
  done: "已完成",
  cancel: "已取消",
};

/** 确认状态 → 中文。 */
export const CONFIRMED_LABEL: Readonly<Record<string, string>> = {
  "1": "已确认",
  "0": "未确认",
};

/**
 * 任意写法 → 状态机器码。
 *
 * 已经是机器码就原样返回（幂等），是中文就查表，查不到返回 undefined——
 * 调用方据此判断「这个值我没法比」，而不是拿一个猜的值去放行。
 */
export function statusCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (STATUS_LABEL[trimmed]) return trimmed;
  return STATUS_ALIASES[trimmed];
}

/** 任意写法 → 解决方案机器码（页面只有中文，没有 class 可偷）。 */
export function resolutionCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (RESOLUTION_LABEL[trimmed]) return trimmed;
  for (const [code, label] of Object.entries(RESOLUTION_LABEL)) {
    if (label === trimmed) return code;
  }
  return undefined;
}
