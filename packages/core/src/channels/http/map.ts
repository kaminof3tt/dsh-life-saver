/**
 * 详情页字段表 → 领域模型。
 *
 * 禅道页面的标签是中文、随版本和语言微调（「由谁创建」vs「创建者」vs「创建人」），
 * 所以这里不硬编码某一个标签，而是给每个字段一张别名表，按「去掉冒号/空格后
 * 完全相等」优先、包含次之的顺序匹配。匹配不到就留 undefined，由上游报 missing。
 */

import type { Bug, Story, Task } from "../../domain/model.js";
import type { ParsedPage } from "./parse.js";

/** 一张「领域字段 → 页面标签候选」的表。 */
type AliasTable<T extends string> = Readonly<Record<T, readonly string[]>>;

const STORY_ALIASES: AliasTable<
  | "status"
  | "stage"
  | "pri"
  | "estimate"
  | "productName"
  | "projectName"
  | "moduleName"
  | "openedBy"
  | "openedDate"
  | "assignedTo"
  | "parent"
> = {
  status: ["状态", "当前状态", "Status"],
  stage: ["所处阶段", "阶段", "Stage"],
  pri: ["优先级", "Priority", "P"],
  estimate: ["预计工时", "预计", "Estimate"],
  productName: ["所属产品", "产品", "Product"],
  projectName: ["所属项目", "项目", "所属项目集", "Project"],
  moduleName: ["所属模块", "模块", "Module"],
  openedBy: ["由谁创建", "创建者", "创建人", "提建人", "OpenedBy"],
  openedDate: ["创建日期", "创建时间", "OpenedDate"],
  assignedTo: ["当前指派", "指派给", "指派", "AssignedTo"],
  parent: ["父需求", "父级需求", "Parent"],
};

const TASK_ALIASES: AliasTable<
  | "status"
  | "pri"
  | "estimate"
  | "consumed"
  | "left"
  | "projectName"
  | "moduleName"
  | "assignedTo"
  | "openedBy"
  | "openedDate"
  | "finishedBy"
  | "finishedDate"
  | "deadline"
  | "storyId"
> = {
  status: ["状态", "当前状态", "Status"],
  pri: ["优先级", "Priority"],
  estimate: ["预计工时", "最初预计", "预计"],
  consumed: ["已消耗", "已消耗工时", "消耗"],
  left: ["剩余", "剩余工时"],
  projectName: ["所属项目", "项目"],
  moduleName: ["所属模块", "模块"],
  assignedTo: ["当前指派", "指派给", "指派"],
  openedBy: ["由谁创建", "创建者", "创建人"],
  openedDate: ["创建日期", "创建时间"],
  finishedBy: ["由谁完成", "完成者"],
  finishedDate: ["完成日期", "完成时间"],
  deadline: ["截止日期", "截止"],
  storyId: ["相关需求", "关联需求", "所属需求"],
};

const BUG_ALIASES: AliasTable<
  | "status"
  | "pri"
  | "severity"
  | "type"
  | "productName"
  | "moduleName"
  | "projectName"
  | "assignedTo"
  | "openedBy"
  | "openedDate"
  | "resolvedBy"
  | "resolvedDate"
  | "resolution"
  | "confirmed"
  | "storyId"
  | "taskId"
> = {
  status: ["状态", "当前状态", "Bug状态"],
  pri: ["优先级", "Priority"],
  severity: ["严重程度", "严重级别", "Severity"],
  type: ["Bug类型", "类型", "Type"],
  productName: ["所属产品", "产品"],
  moduleName: ["所属模块", "模块"],
  projectName: ["所属项目", "项目"],
  assignedTo: ["当前指派", "指派给", "指派"],
  openedBy: ["由谁创建", "创建者", "创建人"],
  openedDate: ["创建日期", "创建时间"],
  resolvedBy: ["由谁解决", "解决者", "解决人"],
  resolvedDate: ["解决日期", "解决时间"],
  resolution: ["解决方案", "Resolution"],
  confirmed: ["是否确认", "确认"],
  storyId: ["相关需求", "关联需求"],
  taskId: ["相关任务", "关联任务"],
};

/** 在字段表里按别名找值：先精确相等，再互相包含，最后不区分大小写。 */
function lookup(fields: Readonly<Record<string, string>>, aliases: readonly string[]): string | undefined {
  const entries = Object.entries(fields);
  for (const alias of aliases) {
    for (const [label, value] of entries) {
      if (label === alias && value) return value;
    }
  }
  for (const alias of aliases) {
    for (const [label, value] of entries) {
      if (value && (label.includes(alias) || alias.includes(label))) return value;
    }
  }
  const lower = aliases.map((alias) => alias.toLowerCase());
  for (const [label, value] of entries) {
    if (value && lower.includes(label.toLowerCase())) return value;
  }
  return undefined;
}

function numberOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /-?\d+(?:\.\d+)?/.exec(raw.replace(/,/g, ""));
  if (!match) return undefined;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

/** `#123` / `123` / `需求#123 标题` 里取 id。 */
function idOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /(\d+)/.exec(raw);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

/** `123.50` 这种工时字符串。 */
function hoursOrUndefined(raw: string | undefined): number | undefined {
  return numberOrUndefined(raw);
}

/** 「是否确认」在页面上只有中文：已确认 / 未确认。 */
function confirmedOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (raw.includes("未确认")) return 0;
  if (raw.includes("已确认")) return 1;
  return undefined;
}

/**
 * 页面上「指派给 / 由谁创建」常把人和时间挤在一个格子里：
 * `张三 于 2026-10-30 17:13:53`。人只留前面的名字，时间单独给 openedDate。
 */
function personOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cut = raw
    .replace(/\s*于\s*\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/\s*\d{4}-\d{2}-\d{2}.*$/, "")
    .trim();
  return cut || undefined;
}

/** 从同一格子里补出 `2026-10-30 17:13:53`。 */
function dateOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?)/.exec(raw)?.[1];
}

/**
 * 日期格子里常跟着状态标签：`2026-10-26延期4天`（`<span class="label danger-pale">`）。
 * 只留日期，标签不要混进字段值。
 */
function dateCell(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return dateOf(raw) ?? raw;
}

export interface MapContext {
  readonly id: number;
  readonly url?: string;
  readonly fallbackTitle: string;
  /**
   * 中文显示名 → 禅道账号。
   *
   * 页面上只有「张三」，没有 `zhangsan`；而写操作的归属校验必须比账号。
   * 这个函数由上层注入（拿一次 `m=company&f=browse&t=json` 的 `userPairs`），
   * 拿不到就返回 undefined，此时 `codes` 里对应字段留空，护栏退回显示名比较。
   */
  readonly resolveAccount?: (realname: string) => string | undefined;
}

/**
 * 状态机器码：优先用页面 `span.status-xxx` 的 class 后缀，没有再退回中文原文。
 *
 * 页面上写「已解决」、库里存 `resolved`，是同一件事的两种写法；护栏要后者。
 */
function statusCode(page: ParsedPage, aliases: readonly string[], fallback: string | undefined): string | undefined {
  const states = page.states;
  if (states) {
    const byLabel = lookup(states, aliases);
    if (byLabel) return byLabel;
  }
  return fallback;
}

/** 人员账号：显示名反查账号，查不到就留空（护栏退回显示名比较）。 */
function accountOf(
  realname: string | undefined,
  resolveAccount: ((realname: string) => string | undefined) | undefined,
): string | undefined {
  if (!realname || !resolveAccount) return undefined;
  const account = resolveAccount(realname);
  return account || undefined;
}

/** 把三个可能为空的机器码收成一个对象；全空就返回 undefined，免得模型看到空壳。 */
function codesOf(codes: { status?: string; assignedTo?: string; openedBy?: string }): {
  status?: string;
  assignedTo?: string;
  openedBy?: string;
} | undefined {
  if (!codes.status && !codes.assignedTo && !codes.openedBy) return undefined;
  return codes;
}

export function toStoryFromPage(page: ParsedPage, context: MapContext): Story {
  const f = page.fields;
  const title = page.title || lookup(f, ["需求名称", "标题", "名称"]) || context.fallbackTitle;
  const openedRaw = lookup(f, STORY_ALIASES.openedBy);
  const openedBy = personOf(openedRaw);
  const assignedTo = personOf(lookup(f, STORY_ALIASES.assignedTo));
  const status = lookup(f, STORY_ALIASES.status);
  return {
    kind: "story",
    id: context.id,
    title,
    url: context.url,
    images: page.images,
    parent: idOrUndefined(lookup(f, STORY_ALIASES.parent)),
    status,
    stage: lookup(f, STORY_ALIASES.stage),
    pri: numberOrUndefined(lookup(f, STORY_ALIASES.pri)),
    estimate: hoursOrUndefined(lookup(f, STORY_ALIASES.estimate)),
    productName: lookup(f, STORY_ALIASES.productName),
    projectName: lookup(f, STORY_ALIASES.projectName),
    moduleName: lookup(f, STORY_ALIASES.moduleName),
    openedBy,
    openedDate: dateCell(lookup(f, STORY_ALIASES.openedDate) ?? openedRaw),
    assignedTo,
    spec: bodyOf(page),
    notes: page.notes,
    attachments: page.attachments,
    codes: codesOf({
      status: statusCode(page, STORY_ALIASES.status, status),
      assignedTo: accountOf(assignedTo, context.resolveAccount),
      openedBy: accountOf(openedBy, context.resolveAccount),
    }),
  };
}

export function toTaskFromPage(page: ParsedPage, context: MapContext): Task {
  const f = page.fields;
  const title = page.title || lookup(f, ["任务名称", "标题", "名称"]) || context.fallbackTitle;
  const storyRaw = lookup(f, TASK_ALIASES.storyId);
  const openedRaw = lookup(f, TASK_ALIASES.openedBy);
  const openedBy = personOf(openedRaw);
  const assignedTo = personOf(lookup(f, TASK_ALIASES.assignedTo));
  const status = lookup(f, TASK_ALIASES.status);
  return {
    kind: "task",
    id: context.id,
    title,
    url: context.url,
    images: page.images,
    status,
    pri: numberOrUndefined(lookup(f, TASK_ALIASES.pri)),
    estimate: hoursOrUndefined(lookup(f, TASK_ALIASES.estimate)),
    consumed: hoursOrUndefined(lookup(f, TASK_ALIASES.consumed)),
    left: hoursOrUndefined(lookup(f, TASK_ALIASES.left)),
    projectName: lookup(f, TASK_ALIASES.projectName),
    moduleName: lookup(f, TASK_ALIASES.moduleName),
    assignedTo,
    openedBy,
    openedDate: dateCell(lookup(f, TASK_ALIASES.openedDate) ?? openedRaw),
    finishedBy: personOf(lookup(f, TASK_ALIASES.finishedBy)),
    finishedDate: dateCell(lookup(f, TASK_ALIASES.finishedDate) ?? lookup(f, TASK_ALIASES.finishedBy)),
    deadline: dateCell(lookup(f, TASK_ALIASES.deadline)),
    storyId: idOrUndefined(storyRaw),
    storyTitle: storyRaw && !/^\s*#?\d+\s*$/.test(storyRaw) ? storyRaw.replace(/^\s*#?\d+\s*/, "") || undefined : undefined,
    desc: bodyOf(page),
    notes: page.notes,
    attachments: page.attachments,
    codes: codesOf({
      status: statusCode(page, TASK_ALIASES.status, status),
      assignedTo: accountOf(assignedTo, context.resolveAccount),
      openedBy: accountOf(openedBy, context.resolveAccount),
    }),
  };
}

export function toBugFromPage(page: ParsedPage, context: MapContext): Bug {
  const f = page.fields;
  const title = page.title || lookup(f, ["Bug标题", "标题", "名称"]) || context.fallbackTitle;
  const openedRaw = lookup(f, BUG_ALIASES.openedBy);
  const resolvedRaw = lookup(f, BUG_ALIASES.resolvedBy);
  const openedBy = personOf(openedRaw);
  const assignedTo = personOf(lookup(f, BUG_ALIASES.assignedTo));
  const status = lookup(f, BUG_ALIASES.status);
  return {
    kind: "bug",
    id: context.id,
    title,
    url: context.url,
    images: page.images,
    status,
    pri: numberOrUndefined(lookup(f, BUG_ALIASES.pri)),
    severity: numberOrUndefined(lookup(f, BUG_ALIASES.severity)),
    type: lookup(f, BUG_ALIASES.type),
    productName: lookup(f, BUG_ALIASES.productName),
    moduleName: lookup(f, BUG_ALIASES.moduleName),
    projectName: lookup(f, BUG_ALIASES.projectName),
    assignedTo,
    openedBy,
    openedDate: dateCell(lookup(f, BUG_ALIASES.openedDate) ?? openedRaw),
    resolvedBy: personOf(resolvedRaw),
    resolvedDate: dateCell(lookup(f, BUG_ALIASES.resolvedDate) ?? resolvedRaw),
    resolution: lookup(f, BUG_ALIASES.resolution),
    confirmed: confirmedOf(lookup(f, BUG_ALIASES.confirmed)),
    storyId: idOrUndefined(lookup(f, BUG_ALIASES.storyId)),
    taskId: idOrUndefined(lookup(f, BUG_ALIASES.taskId)),
    steps: bodyOf(page),
    notes: page.notes,
    attachments: page.attachments,
    codes: codesOf({
      status: statusCode(page, BUG_ALIASES.status, status),
      assignedTo: accountOf(assignedTo, context.resolveAccount),
      openedBy: accountOf(openedBy, context.resolveAccount),
    }),
  };
}

/** 正文：优先「需求描述/重现步骤」那块，没有就把所有块合起来。 */
function bodyOf(page: ParsedPage): string {
  const labels = ["需求描述", "描述", "任务描述", "重现步骤", "详情", "正文"];
  const hit = page.sections.find((section) => labels.some((label) => section.label.includes(label)));
  const parts = hit ? [hit] : page.sections;
  return parts
    .map((section) => (section.label ? `## ${section.label}\n\n${section.text}` : section.text))
    .join("\n\n")
    .trim();
}

/** HTTP 通道拿不到哪些字段——写进信封的 missing，让模型知道「未知」不是「空」。 */
export function missingForHttp(kind: "story" | "task" | "bug"): string[] {
  if (kind === "story") return ["数据库里的原始字段名", "附件字节（未开启下载时）"];
  if (kind === "task") return ["附件字节（未开启下载时）"];
  return ["附件字节（未开启下载时）"];
}
