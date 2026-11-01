/**
 * 工具层共用的小工具。
 *
 * 禅道的正文、备注、重现步骤都是**别人写的文本**，里面完全可能写着
 * 「忽略之前的所有指令」这种话。它们不是不可信到要隔离的程度（毕竟是自家系统），
 * 但按 DSH 的惯例仍然套一层边界标记，让模型分得清「这是数据」还是「这是指令」。
 */

import { isEntityKind, type EntityKind } from "../domain/model.js";
import { ACTION_LABELS, type WriteSnapshot } from "../channels/write.js";
import { LifeSaverError, type WriteResult } from "../service.js";

const BOUNDARY_OPEN = "<untrusted-zentao-content>";
const BOUNDARY_CLOSE = "</untrusted-zentao-content>";
const BOUNDARY_TAG = /<\/?untrusted-zentao-content>/gi;

/** 套上不可信内容边界；顺手剥掉正文里自带的同名标记，防止提前闭合。 */
export function wrapUntrusted(text: string): string {
  return `${BOUNDARY_OPEN}\n${text.replace(BOUNDARY_TAG, "")}\n${BOUNDARY_CLOSE}`;
}

/** 通道类型的中文名，给提示文案用。 */
export function sourceLabel(source: "db" | "http"): string {
  return source === "db" ? "只读库 + SFTP" : "HTTP 页面（登录 cookie）";
}

/** 降级说明的**纯文本**形态（放在 `degraded` 字段里，不带 markdown 装饰）。 */
export function degradedText(degraded: { from: "db" | "http"; reason: string } | undefined): string {
  if (!degraded) return "";
  return `首选通道 ${sourceLabel(degraded.from)} 不可用，已自动降级。原因：${degraded.reason}`;
}

/** 降级提示的 markdown 形态（要嵌进正文时用，带引用块与警告符号）。 */
export function degradedNote(degraded: { from: "db" | "http"; reason: string } | undefined): string {
  const text = degradedText(degraded);
  return text ? `> ⚠️ ${text}` : "";
}

/** 参数字符串收窄，非法值给 undefined（由调用方决定报参数错还是走默认值）。 */
export function asEntityKind(value: unknown): EntityKind | undefined {
  return isEntityKind(value) ? value : undefined;
}

/** 一次调用允许的搜索条数。 */
export function clampLimit(value: unknown, fallback: number, max = 50): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), max));
}

/** 单个对象读取时的参数归一化。 */
export function asScope(value: unknown): "brief" | "full" {
  return value === "brief" ? "brief" : "full";
}

/** 参数里的数字：空值当没给，给了但不是数字就报参数错。 */
export function asNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new LifeSaverError("bad-args", `参数 ${what} 必须是数字`);
  return numeric;
}

/** 参数里的非空字符串：空白串等同于没给。 */
export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 枚举参数收窄：不在白名单里就报出完整选项。 */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[], what = "action"): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new LifeSaverError("bad-args", `参数 ${what} 只能是：${allowed.join(" / ")}`);
}

/**
 * 丢掉值为 undefined 的键。
 *
 * 工具输出 schema 都写了 `additionalProperties: false`，多带一个 `undefined`
 * 会被宿主当成「键存在但类型不对」。手写 `...(x !== undefined ? { x } : {})` 十几次
 * 既啰嗦又容易漏一个，统一在这里过滤。
 */
export function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** 从任意异常里抠出一句人话。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 写工具的输出形状（zentao_task_op / zentao_bug_op 共用）。 */export interface WriteToolOutput {
  readonly channel: string;
  readonly kind: string;
  readonly id: number;
  readonly action: string;
  readonly actionName: string;
  readonly before: string;
  readonly after: string;
  readonly message: string;
  readonly warnings: string[];
  readonly degraded?: string;
  readonly markdown: string;
}

/**
 * 把一次写操作的结果渲染成工具输出。
 *
 * 两个写工具（任务 / BUG）此前各自抄了一份「写前写后快照 + 消息 + 需要注意 + 降级」
 * 的拼装逻辑，唯一差别是快照里看哪些字段。差异留在 `snapshot` 里，骨架放这里：
 * 少一份重复，就少一个「只改了一边」的机会。
 */
export function renderWriteOutcome(
  noun: string,
  result: WriteResult,
  snapshot: (value: WriteSnapshot) => string,
): WriteToolOutput {
  const outcome = result.outcome;
  const lines = [
    `${noun} #${outcome.id}「${ACTION_LABELS[outcome.action]}」写入成功（通道：${sourceLabel(outcome.channel)}，动作：${outcome.actionName}）`,
    "",
    `- 写前：${snapshot(outcome.before)}`,
    `- 写后：${snapshot(outcome.after)}`,
    "",
    outcome.message,
  ];
  const degraded = degradedNote(result.degraded);
  if (degraded) lines.unshift(degraded, "");
  if (outcome.warnings.length > 0) {
    lines.push("", "需要注意：", ...outcome.warnings.map((item) => `- ${item}`));
  }
  return compact({
    channel: outcome.channel,
    kind: outcome.kind,
    id: outcome.id,
    action: outcome.action,
    actionName: outcome.actionName,
    before: snapshot(outcome.before),
    after: snapshot(outcome.after),
    message: outcome.message,
    warnings: [...outcome.warnings],
    degraded: degraded || undefined,
    markdown: wrapUntrusted(lines.join("\n")),
  });
}
