/**
 * DB 线的写入：在一个事务里把禅道会改的表全都改掉。
 *
 * 依据是禅道 16.2 的 `module/task/model.php` 与 `module/bug/model.php`，逐句对齐过：
 *
 *   任务（8 个动作）
 *     zt_task           状态/工时/指派人/完成人/关闭人…（每个动作改的子集不同）
 *     zt_effort         记工时（recordworkhour/start/finish 有，pause/close/cancel/activate 没有）
 *     zt_action         动作流水（started/finished/paused/activated/closed/canceled/recordestimate/commented）
 *     zt_history        每个变更字段一行，否则详情页「历史」面板是空的
 *     zt_notify         给写后 assignedTo 那个人发通知（recordworkhour/paused 实测不发）
 *     zt_kanbancell + zt_kanbanlane   重排泳道卡片并更新 lastEditedTime
 *   任务（close 额外）
 *     closedReason 按旧状态定（done→'done'，cancel→'cancel'）
 *
 *   BUG（4 个动作）
 *     confirm  只改 confirmed、lastEditedBy/Date、assignedDate，action=bugconfirmed，实测**不发通知**
 *     resolve  status=resolved + confirmed=1 + resolution/resolvedBy/resolvedDate + 指回 openedBy
 *     close    status=closed + assignedTo='closed' + closedBy/closedDate
 *     comment  只插 action=commented
 *
 * 父任务汇总（syncParentTask）与需求阶段（syncStoryStage）在 `followups.ts`：
 * 两者都由 `write.ts` 在写事务里调用，**不是**这里没复刻的东西。
 * 它们算错会污染别的对象，所以只在真正有父任务/子任务时才动手。
 */

import type { RowDataPacket } from "mysql2/promise";

import {
  CLOSED_REASON_LABEL as CLOSED_REASON_LABEL_SHARED,
  CONFIRMED_LABEL as CONFIRMED_LABEL_SHARED,
  RESOLUTION_LABEL as RESOLUTION_LABEL_SHARED,
  STATUS_LABEL as STATUS_LABEL_SHARED,
} from "../../domain/labels.js";
import { ChannelError } from "../types.js";
import type { WriteOutcome, WriteRequest, WriteSnapshot } from "../write.js";
import type { FollowupEnv, FollowupHooks } from "./followups.js";
import { dbValue, decimalText, linkBugToBuild, syncParentTask, syncStoryStage } from "./followups.js";
import type { DbHandle, DbTransaction } from "./pool.js";
import { rebuildSearchIndex, shouldRebuildIndex } from "./search.js";

/** DB 线写操作需要的外部信息。 */
export interface DbWriteContext {
  readonly db: DbHandle;
  /** 当前登录账号（写进 actor / account 字段）。 */
  readonly account: string;
  /** 站点地址，用于拼通知里的链接。 */
  readonly baseUrl: string;
}

interface TaskRow extends RowDataPacket {
  id: number;
  project: number;
  parent: number;
  execution: number;
  story: number;
  name: string;
  status: string;
  consumed: string | number;
  left: string | number;
  assignedTo: string;
  openedBy: string;
  finishedBy: string;
  finishedDate: string | null;
  realStarted: string | null;
  closedBy: string;
  closedDate: string | null;
  closedReason: string;
  canceledBy: string;
  canceledDate: string | null;
  activatedDate: string | null;
  vision: string;
  deleted: number;
}

/** SUM() 的结果行。 */
interface TotalRow extends RowDataPacket {
  total: string | number | null;
}

interface BugRow extends RowDataPacket {
  id: number;
  project: number;
  product: number;
  execution: number;
  title: string;
  status: string;
  confirmed: number;
  resolution: string;
  resolvedBy: string;
  resolvedDate: string | null;
  resolvedBuild: string;
  duplicateBug: number;
  testtask: number;
  assignedTo: string;
  openedBy: string;
  closedBy: string;
  closedDate: string | null;
  vision: string;
  deleted: number;
}

interface UserRow extends RowDataPacket {
  account: string;
  realname: string;
}

/** 参与「变了什么」比对、并且要写进 zt_history 的字段。 */
const TASK_TRACKED = [
  "status",
  "consumed",
  "left",
  "assignedTo",
  "finishedBy",
  "finishedDate",
  "closedBy",
  "closedDate",
  "closedReason",
  "canceledBy",
  "canceledDate",
  "realStarted",
  "activatedDate",
] as const;

const BUG_TRACKED = [
  "status",
  "confirmed",
  "resolution",
  "resolvedBy",
  "resolvedDate",
  "resolvedBuild",
  "duplicateBug",
  "testtask",
  "assignedTo",
  "closedBy",
  "closedDate",
] as const;

/** 状态码 → 中文（写 zt_history 的 oldValue/newValue）。
 *
 * 文案统一收在 `domain/labels.ts`——那边的取值来自 `zt_history` 里禅道自己写的
 * 显示名，不是凭印象翻的。
 */
const STATUS_LABEL = STATUS_LABEL_SHARED;

/** BUG 解决方案 → 中文。同上，取自库内真实文案。 */
const RESOLUTION_LABEL = RESOLUTION_LABEL_SHARED;

/** 确认状态 / 关闭原因 → 中文。 */
const CONFIRMED_LABEL = CONFIRMED_LABEL_SHARED;
const CLOSED_REASON_LABEL = CLOSED_REASON_LABEL_SHARED;

/** 动作名 → 通知文案里的动词。取自 module/action/lang/zh-cn.php。 */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  started: "开始了",
  finished: "完成了",
  paused: "暂停了",
  activated: "激活了",
  closed: "关闭了",
  canceled: "取消了",
  resolved: "解决了",
  commented: "评论了",
  recordestimate: "记录工时",
  bugconfirmed: "确认了",
};

/**
 * 哪些动作要发通知。
 *
 * 这是实测出来的，不是猜的：本库 2026-09 之后 task 的 recordworkhour 86 条、
 * paused 5 条，通知数为 0；bugconfirmed 60 条，通知数也是 0。其余动作按禅道配置照发。
 */
const NOTIFY_ACTIONS = new Set(["started", "finished", "closed", "canceled", "activated", "resolved", "commented"]);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function stamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function today(): string {
  return stamp().slice(0, 10);
}

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 空日期在禅道里是 NULL（不是 '0000-00-00'，本库 sql_mode 允许但没必要写）。 */
function dateOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("0000-00-00")) return null;
  return value;
}

function snapshotOfTask(row: TaskRow): WriteSnapshot {
  return {
    status: row.status,
    assignedTo: row.assignedTo,
    consumed: num(row.consumed),
    left: num(row.left),
  };
}

function snapshotOfBug(row: BugRow): WriteSnapshot {
  return {
    status: row.status,
    assignedTo: row.assignedTo,
    consumed: 0,
    left: 0,
    confirmed: row.confirmed,
    resolution: row.resolution,
  };
}

/**
 * 哪些字段在 zt_history 里存「显示名」（oldValue/newValue）。
 *
 * 实测（本库 task/bug 近 3 万行 history）：只有状态、人、解决方案、确认、关闭原因、
 * 优先级/类型/严重程度这几类有中文显示名；而 consumed、left、各种 Date、
 * resolvedBuild、duplicateBug 等的 oldValue/newValue **一律是 NULL**，
 * 详情页「历史」面板是从 diff 字段自己渲染数字的。
 * 所以这里必须返回 null 而不是原值字符串，否则会造出禅道从不产生的显示文本。
 */
const DISPLAY_FIELDS = new Set([
  "status",
  "assignedTo",
  "openedBy",
  "finishedBy",
  "canceledBy",
  "closedBy",
  "resolvedBy",
  "resolution",
  "confirmed",
  "closedReason",
  "pri",
  "type",
  "severity",
]);

/** 把值转成 zt_history 里的显示文本；返回 null 表示该字段本来就没有显示名。 */
function displayValue(
  field: string,
  value: unknown,
  realnames: ReadonlyMap<string, string>,
): string | null {
  if (!DISPLAY_FIELDS.has(field)) return null;
  if (value === null || value === undefined) value = "";
  const text = String(value);
  if (field === "status") return STATUS_LABEL[text] ?? text;
  if (field === "resolution") return RESOLUTION_LABEL[text] ?? text;
  if (field === "confirmed") return CONFIRMED_LABEL[text] ?? text;
  if (field === "closedReason") return CLOSED_REASON_LABEL[text] ?? null;
  if (field === "pri" || field === "type" || field === "severity") return text;
  // 人名字段：空值在禅道里是 NULL，不是空串。
  if (text === "") return null;
  return realnames.get(text) ?? text;
}

/** 一次写操作内累积的上下文。 */
interface TxEnv {
  readonly tx: DbTransaction;
  readonly now: string;
  readonly account: string;
  readonly realnames: Map<string, string>;
  readonly warnings: string[];
}

/**
 * 取账号 → 真实姓名。通知与历史面板都显示中文名，不是账号。
 */
async function loadRealnames(tx: DbTransaction, accounts: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(accounts.filter((item) => item && item !== "closed" && item !== "0"))];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await tx.query<UserRow>(
    `SELECT account, realname FROM ${tx.table("user")} WHERE account IN (${placeholders})`,
    unique,
  );
  return new Map(rows.map((row) => [row.account, row.realname || row.account]));
}

/** 记录动作流水，返回 action id。 */
async function insertAction(
  env: TxEnv,
  params: {
    /** task / bug / effort / story —— 工时记录本身也会产生 `created` 动作。 */
    readonly objectType: string;
    readonly objectID: number;
    readonly action: string;
    readonly comment?: string;
    readonly extra?: string;
    readonly product: string;
    readonly project: number;
    readonly execution: number;
    readonly vision: string;
    /** zt_action.read：BUG 的工时日志实测是 1，其余动作是 0。 */
    readonly read?: number;
  },
): Promise<number> {
  const result = await env.tx.execute(
    `INSERT INTO ${env.tx.table("action")}
      (objectType, objectID, product, project, execution, actor, action, \`date\`, comment, files, extra, \`read\`, efforted, vision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?)`,
    [
      params.objectType,
      params.objectID,
      params.product,
      params.project,
      params.execution,
      env.account,
      params.action,
      env.now,
      params.comment ?? "",
      params.extra ?? "",
      params.read ?? 0,
      params.vision || "rnd",
    ],
  );
  const actionId = result.insertId;
  if (!actionId) throw new ChannelError("db", "write", "插入 zt_action 失败：没有拿到 action id");

  // 「最近动态」读的是 zt_actionrecent，不写这张表的话这次操作在首页看不到。
  await env.tx.execute(
    `INSERT INTO ${env.tx.table("actionrecent")}
      (id, objectType, objectID, product, project, execution, actor, action, \`date\`, comment, files, extra, \`read\`, efforted, vision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, 0, ?)`,
    [
      actionId,
      params.objectType,
      params.objectID,
      params.product,
      params.project,
      params.execution,
      env.account,
      params.action,
      env.now,
      params.comment ?? "",
      params.extra ?? "",
      params.vision || "rnd",
    ],
  );

  await insertActionProducts(env, actionId, params.product);
  return actionId;
}

/**
 * 写 zt_actionproduct。
 *
 * 实测全库 14514 条 action 里有 14513 条的 actionproduct 恰好等于
 * 「action.product 按逗号切开、去掉空串与 0」——唯一的例外是一条 comment 动作（历史遗留）。
 * 禅道自己是在 action 落库之后由 biz 扩展拆的，我们直接改库就得自己补，
 * 否则「按产品筛选动作」这类查询会漏掉插件写进去的动作。
 */
async function insertActionProducts(env: TxEnv, actionId: number, product: string): Promise<void> {
  const products = [
    ...new Set(
      product
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "" && item !== "0")
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item)),
    ),
  ];
  if (products.length === 0) return;
  const tuples = products.map(() => "(?, ?)").join(", ");
  const rows: unknown[] = [];
  for (const item of products) {
    rows.push(actionId, item);
  }
  await env.tx.execute(
    `INSERT INTO ${env.tx.table("actionproduct")} (action, product) VALUES ${tuples}`,
    rows,
  );
}

/** 每个变更字段一行 zt_history。 */
async function insertHistory(
  env: TxEnv,
  actionId: number,
  changes: readonly { field: string; old: unknown; next: unknown }[],
): Promise<void> {
  if (changes.length === 0) return;
  const rows: unknown[] = [];
  const tuples: string[] = [];
  for (const change of changes) {
    tuples.push("(?, ?, ?, ?, ?, ?, '')");
    rows.push(
      actionId,
      change.field,
      change.old === null || change.old === undefined ? "" : String(change.old),
      displayValue(change.field, change.old, env.realnames),
      change.next === null || change.next === undefined ? "" : String(change.next),
      displayValue(change.field, change.next, env.realnames),
    );
  }
  await env.tx.execute(
    `INSERT INTO ${env.tx.table("history")} (action, field, old, oldValue, new, newValue, diff) VALUES ${tuples.join(", ")}`,
    rows,
  );
}

/** 库里是 DECIMAL 的字段：比对前要归一到两位小数字符串，否则 "61.00" 与 61 会被判成变更。 */
const DECIMAL_FIELDS = new Set(["estimate", "consumed", "left"]);

/** 比对前后两版行，得到变更列表。 */
function diffRow<T extends Record<string, unknown>>(
  tracked: readonly string[],
  before: T,
  after: T,
): { field: string; old: unknown; next: unknown }[] {
  const out: { field: string; old: unknown; next: unknown }[] = [];
  for (const field of tracked) {
    const old = before[field];
    const next = after[field];
    const same = DECIMAL_FIELDS.has(field)
      ? decimalText(old as string | number | null | undefined) === decimalText(next as string | number | null | undefined)
      : (old === null || old === undefined ? "" : String(old)) === (next === null || next === undefined ? "" : String(next));
    if (!same) out.push({ field, old, next });
  }
  return out;
}

/**
 * 按 write 之后的 assignedTo 决定通知发给谁。
 *
 * 禅道 `message::saveNotice()` 的规则：收件人 = 写后对象的 assignedTo；
 * 等于 'closed'、为空、或者就是操作者自己时，不写通知。
 */
async function insertNotify(
  env: TxEnv,
  params: {
    readonly actionId: number;
    readonly action: string;
    readonly objectType: "task" | "bug";
    readonly objectID: number;
    readonly title: string;
    readonly assignedTo: string;
    readonly baseUrl: string;
    readonly useDataApp: boolean;
  },
): Promise<void> {
  if (!NOTIFY_ACTIONS.has(params.action)) return;
  const to = params.assignedTo;
  if (!to || to === "closed") return;
  if (to === env.account) return;

  const label = ACTION_LABEL[params.action] ?? params.action;
  const typeLabel = params.objectType === "task" ? "任务" : "Bug";
  const who = env.realnames.get(env.account) ?? env.account;
  const base = params.baseUrl.replace(/\/+$/, "");
  const appAttr = params.useDataApp ? "  data-app='my'" : "  ";
  const data =
    `${who}${label}${typeLabel} ` +
    `<a href='${base}/index.php?m=${params.objectType}&f=view&id=${params.objectID}'${appAttr}>` +
    `[#${params.objectID}::${params.title}]</a>\n`;

  await env.tx.execute(
    `INSERT INTO ${env.tx.table("notify")}
      (objectType, objectID, action, toList, ccList, subject, data, createdBy, createdDate, sendTime, status, failReason)
     VALUES ('message', 0, ?, ?, NULL, NULL, ?, ?, ?, NULL, 'wait', '')`,
    [params.actionId, `,${to},`, data, env.account, env.now],
  );
}

/** 插一条工时（对应 task 的 addTaskEstimate()）。 */
async function insertEffort(
  env: TxEnv,
  params: {
    readonly objectType: "task" | "bug";
    readonly objectID: number;
    readonly product: string;
    readonly project: number;
    readonly execution: number;
    readonly date: string;
    readonly consumed: number;
    readonly left: number;
    readonly work: string;
    readonly vision: string;
  },
): Promise<number> {
  const result = await env.tx.execute(
    `INSERT INTO ${env.tx.table("effort")}
      (objectType, objectID, product, project, execution, account, work, \`date\`, \`left\`, consumed,
       begin, end, extra, \`order\`, vision, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', NULL, 0, ?, 0)`,
    [
      params.objectType,
      params.objectID,
      params.product,
      params.project,
      params.execution,
      env.account,
      params.work,
      params.date,
      params.left,
      params.consumed,
      params.vision || "rnd",
    ],
  );
  return result.insertId;
}

/**
 * 工时记录自己也会产生一条动作：`zt_action(objectType='effort', action='created')`。
 *
 * 实测全库 2262 条这种动作：product=',0,'、project/execution 都是 0、read=0、
 * comment/extra 都是空串，且**没有**对应的 zt_actionproduct 行（',0,' 会被过滤掉）。
 * 不写这条流水，详情页的「动态」里就看不到「记了工时」这一步。
 */
async function insertEffortAction(env: TxEnv, effortID: number, vision: string): Promise<number> {
  return insertAction(env, {
    objectType: "effort",
    objectID: effortID,
    action: "created",
    product: ",0,",
    project: 0,
    execution: 0,
    vision,
  });
}
/** kanban 配置里的「列类型 → 状态」映射（module/kanban/config.php）。 */
const COLUMN_STATUS: Readonly<Record<"task" | "bug", Readonly<Record<string, string>>>> = {
  task: {
    wait: "wait",
    developing: "doing",
    developed: "done",
    pause: "pause",
    canceled: "cancel",
    closed: "closed",
  },
  bug: {
    unconfirmed: "active",
    confirmed: "active",
    fixing: "active",
    fixed: "resolved",
    testing: "resolved",
    tested: "resolved",
    closed: "closed",
  },
};

interface CellRow extends RowDataPacket {
  id: number;
  lane: number;
  columnId: number;
  columnType: string;
  cards: string | null;
}

/**
 * 重排看板卡片（复刻 kanban::refreshCards 的关键部分）。
 *
 * 只处理「列类型在映射表里」的列；`develop` 这类不在映射里的列**原样不动**——
 * 禅道自己也是 `if($colType == 'develop') continue;` 跳过它们。
 * 同状态对应多列（BUG 的 fixed/testing/tested）时，优先留在原列，避免每次写都乱跳。
 */
async function refreshKanban(
  env: TxEnv,
  params: {
    readonly laneType: "task" | "bug";
    readonly execution: number;
    readonly id: number;
    readonly status: string;
  },
): Promise<boolean> {
  if (!params.execution) return false;
  const lanes = await env.tx.query<{ id: number } & RowDataPacket>(
    `SELECT id FROM ${env.tx.table("kanbanlane")} WHERE execution = ? AND type = ? AND deleted = 0`,
    [params.execution, params.laneType],
  );
  if (lanes.length === 0) return false;

  const laneIds = lanes.map((lane) => lane.id);
  const placeholders = laneIds.map(() => "?").join(", ");
  const cells = await env.tx.query<CellRow>(
    `SELECT c.id, c.lane, c.column AS columnId, col.type AS columnType, c.cards
       FROM ${env.tx.table("kanbancell")} c
       JOIN ${env.tx.table("kanbancolumn")} col ON col.id = c.column
      WHERE c.lane IN (${placeholders})`,
    laneIds,
  );
  if (cells.length === 0) return false;

  const mapping = COLUMN_STATUS[params.laneType];
  const token = `,${params.id},`;
  const currentCell = cells.find((cell) => (cell.cards ?? "").includes(token));
  const candidates = cells.filter((cell) => mapping[cell.columnType] === params.status);
  if (candidates.length === 0) {
    env.warnings.push(`看板里没有对应「${params.status}」的列，泳道卡片未调整`);
    return false;
  }
  const target = currentCell && candidates.includes(currentCell) ? currentCell : candidates[0];
  if (!target) return false;

  for (const cell of cells) {
    const cards = cell.cards ?? "";
    const has = cards.includes(token);
    if (cell.id === target.id) {
      if (has) continue;
      const merged = `${cards}${token}`.replace(/^,+/, ",").replace(/,+/g, ",");
      await env.tx.execute(
        `UPDATE ${env.tx.table("kanbancell")} SET cards = ? WHERE id = ?`,
        [merged, cell.id],
      );
      continue;
    }
    if (!has) continue;
    const removed = cards.split(token).join(",").replace(/,+/g, ",");
    await env.tx.execute(
      `UPDATE ${env.tx.table("kanbancell")} SET cards = ? WHERE id = ?`,
      [removed, cell.id],
    );
  }

  await env.tx.execute(
    `UPDATE ${env.tx.table("kanbanlane")} SET lastEditedTime = ? WHERE id IN (${placeholders})`,
    [env.now, ...laneIds],
  );
  return true;
}

/**
 * 任务动作产生的 product 字段（`action.product` 与 `zt_effort.product`）。
 *
 * 对齐 `action::getRelatedFields()`：任务有 story 就取 story 的 product，
 * 否则取「所属执行对应的产品列表」。实测 project 146/147 的 projectproduct
 * 都是同一组产品，所以两种取法结果一致。
 */
async function productForTask(
  tx: DbTransaction,
  row: { readonly story: number; readonly project: number; readonly execution: number },
): Promise<string> {
  if (row.story) {
    const story = await tx.one<{ product: number } & RowDataPacket>(
      `SELECT product FROM ${tx.table("story")} WHERE id = ?`,
      [row.story],
    );
    if (story?.product) return `,${story.product},`;
  }
  const byExecution = await tx.query<{ product: number } & RowDataPacket>(
    `SELECT product FROM ${tx.table("projectproduct")} WHERE project = ?`,
    [row.execution || row.project],
  );
  const list = byExecution.map((item) => item.product).filter((item) => Boolean(item));
  if (list.length > 0) return `,${[...new Set(list)].sort((a, b) => a - b).join(",")},`;
  return ",0,";
}

/** 把 write.ts 的低层能力包成 followups 需要的形状。 */
function makeFollowupHooks(env: TxEnv, tx: DbTransaction): FollowupHooks {
  return {
    createAction: (params) => insertAction(env, params),
    logHistory: (actionId, changes) => insertHistory(env, actionId, changes),
    resolveProduct: (row) => productForTask(tx, row),
  };
}

/** 载入任务行并加锁（避免并发写同一条）。 */
async function lockTask(tx: DbTransaction, id: number): Promise<TaskRow> {
  const row = await tx.one<TaskRow>(
    `SELECT * FROM ${tx.table("task")} WHERE id = ? AND deleted = '0' FOR UPDATE`,
    [id],
  );
  if (!row) throw new ChannelError("db", "not-found", `任务 #${id} 不存在或已删除`);
  return row;
}

async function lockBug(tx: DbTransaction, id: number): Promise<BugRow> {
  const row = await tx.one<BugRow>(
    `SELECT * FROM ${tx.table("bug")} WHERE id = ? AND deleted = '0' FOR UPDATE`,
    [id],
  );
  if (!row) throw new ChannelError("db", "not-found", `BUG #${id} 不存在或已删除`);
  return row;
}

/** 更新 zt_task 的一小组字段。字段名是白名单，值全走占位符。 */
const TASK_COLUMNS = new Set([
  "status",
  "consumed",
  "left",
  "assignedTo",
  "assignedDate",
  "finishedBy",
  "finishedDate",
  "closedBy",
  "closedDate",
  "closedReason",
  "canceledBy",
  "canceledDate",
  "realStarted",
  "activatedDate",
  "lastEditedBy",
  "lastEditedDate",
]);

const BUG_COLUMNS = new Set([
  "status",
  "confirmed",
  "resolution",
  "resolvedBy",
  "resolvedDate",
  "resolvedBuild",
  "duplicateBug",
  "assignedTo",
  "assignedDate",
  "closedBy",
  "closedDate",
  "lastEditedBy",
  "lastEditedDate",
]);

function assignClause(columns: ReadonlySet<string>, values: Record<string, unknown>): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!columns.has(key)) throw new ChannelError("db", "bad-identifier", `不允许写 zt_task/zt_bug 的字段：${key}`);
    parts.push(`\`${key}\` = ?`);
    params.push(dbValue(key, value));
  }
  if (parts.length === 0) throw new ChannelError("db", "write", "没有要更新的字段");
  return { sql: parts.join(", "), params };
}

/** 任务的写实现。 */
async function writeTask(ctx: DbWriteContext, request: WriteRequest): Promise<WriteOutcome> {
  return ctx.db.transaction(async (tx) => {
    const before = await lockTask(tx, request.id);
    const product = await productForTask(tx, before);
    const owner = before.openedBy || before.assignedTo;
    const realnames = await loadRealnames(tx, [
      ctx.account,
      before.assignedTo,
      before.openedBy,
      before.finishedBy,
      before.closedBy,
      before.canceledBy,
      request.assignedTo ?? "",
    ]);
    const env: TxEnv = { tx, now: stamp(), account: ctx.account, realnames, warnings: [] };
    // 父任务汇总 / 需求阶段 / build 回填这些「联动」需要的上下文。
    const followupEnv: FollowupEnv = {
      tx,
      now: env.now,
      account: ctx.account,
      warnings: env.warnings,
      hooks: makeFollowupHooks(env, tx),
    };

    // next 是要写进库的目标值；未列出的字段保持原值。
    const next: Record<string, unknown> = { ...before };
    const updates: Record<string, unknown> = {};
    let actionName = "edited";
    let extra = "";
    let effort: { date: string; consumed: number; left: number; work: string } | undefined;
    let effortID = 0;
    let comment = request.comment ?? "";
    let notify = true;
    let needKanban = true;

    const set = (field: string, value: unknown): void => {
      updates[field] = value;
      next[field] = value;
    };

    switch (request.action) {
      case "start": {
        if (before.status === "doing") throw new ChannelError("db", "write-rejected", `任务 #${request.id} 已经是进行中`);
        const targetConsumed = request.consumed === undefined ? num(before.consumed) : round2(request.consumed);
        if (targetConsumed < num(before.consumed)) {
          throw new ChannelError("db", "write-rejected", "本次消耗工时不能小于已消耗工时");
        }
        const targetLeft = request.left === undefined ? num(before.left) : round2(request.left);
        const delta = round2(targetConsumed - num(before.consumed));
        const realStarted = request.realStarted || before.realStarted || env.now;

        actionName = targetLeft === 0 ? "finished" : "started";
        set("consumed", round2(targetConsumed));
        set("left", round2(targetLeft));
        set("realStarted", realStarted);
        if (before.assignedTo !== ctx.account) set("assignedDate", env.now);
        if (targetLeft === 0) {
          set("status", "done");
          set("assignedTo", owner);
          set("finishedBy", ctx.account);
          set("finishedDate", env.now);
        } else {
          set("status", "doing");
        }
        effort = {
          date: (realStarted || env.now).slice(0, 10),
          consumed: delta,
          left: round2(targetLeft),
          work: comment,
        };
        break;
      }

      case "recordworkhour": {
        if (before.status !== "doing" && before.status !== "wait" && before.status !== "pause") {
          throw new ChannelError(
            "db",
            "write-rejected",
            `任务 #${request.id} 当前状态是 ${before.status}，不能记工时`,
          );
        }
        const delta = round2(request.consumed ?? 0);
        if (delta <= 0) throw new ChannelError("db", "write-rejected", "本次工时必须大于 0");
        const targetLeft = request.left === undefined ? num(before.left) : round2(request.left);
        const date = request.date ?? today();

        actionName = "recordestimate";
        extra = String(delta);
        set("consumed", round2(num(before.consumed) + delta));
        set("left", targetLeft);
        if (!before.realStarted || before.realStarted.startsWith("0000-00-00")) set("realStarted", env.now);
        if (targetLeft === 0) {
          set("status", "done");
          set("assignedTo", owner);
          set("assignedDate", env.now);
          set("finishedBy", ctx.account);
          set("finishedDate", env.now);
        } else if (before.status === "wait") {
          set("status", "doing");
          set("assignedTo", ctx.account);
          set("assignedDate", env.now);
          set("realStarted", date);
        } else if (before.status === "pause") {
          set("status", "doing");
          set("assignedTo", ctx.account);
          set("assignedDate", env.now);
        }
        effort = { date, consumed: delta, left: targetLeft, work: comment };
        // 记录工时的通知实测为 0，显式关掉，避免造出禅道本身不会有的通知。
        notify = false;
        needKanban = before.status !== next["status"];
        break;
      }

      case "finish": {
        const delta = round2(request.consumed ?? 0);
        if (delta < 0) throw new ChannelError("db", "write-rejected", "本次消耗工时不能是负数");
        const realStarted = request.realStarted || before.realStarted;
        if (!realStarted || realStarted.startsWith("0000-00-00")) {
          // 禅道把 realStarted 列为必填；库里没值就补当前时间，而不是失败。
          env.warnings.push("任务原本没有开始时间，已按当前时间补上（禅道要求 realStarted 必填）");
        }
        const startedAt = realStarted && !realStarted.startsWith("0000-00-00") ? realStarted : env.now;
        const finishedAt = request.finishedDate || env.now;

        actionName = "finished";
        set("status", "done");
        set("consumed", round2(num(before.consumed) + delta));
        set("left", 0);
        set("realStarted", startedAt);
        set("assignedTo", request.assignedTo || owner);
        set("assignedDate", env.now);
        set("finishedBy", ctx.account);
        set("finishedDate", finishedAt);
        if (delta > 0) {
          effort = { date: finishedAt.slice(0, 10), consumed: delta, left: 0, work: comment };
        } else {
          env.warnings.push("本次工时是 0，禅道也不会为这次完成生成工时记录");
        }
        break;
      }

      case "pause": {
        if (before.status !== "doing") {
          throw new ChannelError("db", "write-rejected", `任务 #${request.id} 不是进行中，不能暂停`);
        }
        actionName = "paused";
        set("status", "pause");
        notify = false;
        break;
      }

      case "activate": {
        const targetLeft = round2(request.left ?? 0);
        if (targetLeft <= 0) {
          env.warnings.push("激活时剩余工时填的是 0，禅道要求 left 必填且通常应大于 0");
        }
        actionName = "activated";
        set("status", "doing");
        set("left", targetLeft);
        set("assignedTo", request.assignedTo || before.finishedBy || before.assignedTo || owner);
        set("assignedDate", env.now);
        set("activatedDate", env.now);
        set("finishedBy", "");
        set("finishedDate", null);
        set("canceledBy", "");
        set("canceledDate", null);
        set("closedBy", "");
        set("closedDate", null);
        set("closedReason", "");
        break;
      }

      case "close": {
        actionName = "closed";
        set("status", "closed");
        set("assignedTo", "closed");
        set("assignedDate", env.now);
        set("closedBy", ctx.account);
        set("closedDate", env.now);
        if (before.status === "done") set("closedReason", "done");
        else if (before.status === "cancel") set("closedReason", "cancel");
        break;
      }

      case "cancel": {
        actionName = "canceled";
        set("status", "cancel");
        set("assignedTo", owner);
        set("assignedDate", env.now);
        set("finishedBy", "");
        set("finishedDate", null);
        set("canceledBy", ctx.account);
        set("canceledDate", env.now);
        break;
      }

      case "comment": {
        if (!comment.trim()) throw new ChannelError("db", "write", "备注内容不能为空");
        actionName = "commented";
        // 备注不改任何业务字段，只插一条动作流水；不需要刷看板。
        needKanban = false;
        notify = true;
        break;
      }

      default:
        throw new ChannelError("db", "write", `任务不支持动作：${request.action}`);
    }

    if (request.action !== "comment") {
      set("lastEditedBy", ctx.account);
      set("lastEditedDate", env.now);
      const clause = assignClause(TASK_COLUMNS, updates);
      await tx.execute(
        `UPDATE ${tx.table("task")} SET ${clause.sql} WHERE id = ?`,
        [...clause.params, request.id],
      );
    }

    if (effort && effort.consumed > 0) {
      effortID = await insertEffort(env, {
        objectType: "task",
        objectID: request.id,
        product,
        project: before.project,
        execution: before.execution,
        date: effort.date,
        consumed: effort.consumed,
        left: effort.left,
        work: effort.work,
        vision: before.vision,
      });
      await insertEffortAction(env, effortID, before.vision);
    }

    const actionId = await insertAction(env, {
      objectType: "task",
      objectID: request.id,
      action: actionName,
      comment,
      extra,
      product,
      project: before.project,
      execution: before.execution,
      vision: before.vision,
    });

    const changes =
      request.action === "comment" ? [] : diffRow(TASK_TRACKED, before as unknown as Record<string, unknown>, next);
    await insertHistory(env, actionId, changes);

    if (notify) {
      await insertNotify(env, {
        actionId,
        action: actionName,
        objectType: "task",
        objectID: request.id,
        title: before.name,
        assignedTo: String(next["assignedTo"] ?? before.assignedTo),
        baseUrl: ctx.baseUrl,
        useDataApp: true,
      });
    }

    if (needKanban) {
      const moved = await refreshKanban(env, {
        laneType: "task",
        execution: before.execution,
        id: request.id,
        status: String(next["status"] ?? before.status),
      });
      if (!moved) env.warnings.push("没找到任务看板泳道，卡片未重排（详情页数据不受影响）");
    }

    if (before.parent > 0) {
      const synced = await syncParentTask(followupEnv, request.id);
      if (!synced) {
        env.warnings.push(`这是子任务（父任务 #${before.parent}），但父任务的汇总与状态都没有变化，未写上级动作`);
      }
    }

    if (before.story > 0) {
      await syncStoryStage(followupEnv, before.story);
    }

    // 搜索索引：HTTP 线由 `action::saveIndex()` 自己刷，DB 线得手动重建。
    if (effortID > 0) await rebuildSearchIndex(tx, "effort", effortID, { vision: before.vision });
    if (shouldRebuildIndex(actionName, comment)) {
      await rebuildSearchIndex(tx, "task", request.id, { comment, vision: before.vision });
    }

    // 回读：以库里的真实值为准，不是「我们以为写进去的值」。
    const after = await tx.one<TaskRow>(`SELECT * FROM ${tx.table("task")} WHERE id = ?`, [request.id]);
    if (!after) throw new ChannelError("db", "write", "写后回读失败");

    return {
      channel: "db" as const,
      kind: "task" as const,
      id: request.id,
      action: request.action,
      actionName,
      before: snapshotOfTask(before),
      after: snapshotOfTask(after),
      message: `已通过数据库通道把任务 #${request.id} 的「${actionName}」写全（task/effort/action/history/notify/kanban）`,
      warnings: env.warnings,
    };
  });
}

/**
 * BUG 已有的工时累计（zt_effort 求和）。
 *
 * BUG 的 zt_bug 表没有 consumed 列，禅道在 history 里记的「累计工时」是
 * 由 effort 现算的（实测：第二次记工时 old 是上一次的累计值，不是 0）。
 */
async function sumBugConsumed(tx: DbTransaction, bugID: number): Promise<number> {
  const rows = await tx.query<TotalRow>(
    `SELECT COALESCE(SUM(consumed), 0) AS total FROM ${tx.table("effort")}
      WHERE objectType = 'bug' AND objectID = ? AND deleted = 0`,
    [bugID],
  );
  return num(rows[0]?.total ?? 0);
}

/** BUG 的写实现。 */
async function writeBug(ctx: DbWriteContext, request: WriteRequest): Promise<WriteOutcome> {
  return ctx.db.transaction(async (tx) => {
    const before = await lockBug(tx, request.id);
    const product = `,${before.product},`;
    const realnames = await loadRealnames(tx, [
      ctx.account,
      before.assignedTo,
      before.openedBy,
      before.resolvedBy,
      before.closedBy,
    ]);
    const env: TxEnv = { tx, now: stamp(), account: ctx.account, realnames, warnings: [] };
    // 父任务汇总 / 需求阶段 / build 回填这些「联动」需要的上下文。
    const followupEnv: FollowupEnv = {
      tx,
      now: env.now,
      account: ctx.account,
      warnings: env.warnings,
      hooks: makeFollowupHooks(env, tx),
    };

    const next: Record<string, unknown> = { ...before };
    const updates: Record<string, unknown> = {};
    let actionName = "edited";
    let extra = "";
    let comment = request.comment ?? "";
    let needKanban = true;
    /** 只有 recordworkhour 会插 zt_effort。 */
    let effort: { date: string; consumed: number; left: number; work: string } | undefined;
    let effortID = 0;
    /** zt_action.read：BUG 的工时日志实测是 1，其余 BUG 动作是 0。 */
    let actionRead = 0;

    const set = (field: string, value: unknown): void => {
      updates[field] = value;
      next[field] = value;
    };

    switch (request.action) {
      case "confirm": {
        if (before.confirmed === 1) {
          env.warnings.push("这个 BUG 之前已经确认过了，重复确认不会产生新的业务变化");
        }
        actionName = "bugconfirmed";
        set("confirmed", 1);
        set("assignedDate", env.now);
        needKanban = false;
        break;
      }

      case "resolve": {
        const resolution = request.resolution?.trim();
        if (!resolution) throw new ChannelError("db", "write-rejected", "解决 BUG 必须给 resolution");
        if (resolution === "fixed" && !request.resolvedBuild) {
          // 禅道要求 fixed 必须有解决版本；默认 trunk 是禅道自己的默认值。
          env.warnings.push("resolution=fixed 时禅道要求填写解决版本，已按 trunk 处理");
        }
        if (resolution === "duplicate" && !request.duplicateBug) {
          throw new ChannelError("db", "write-rejected", "resolution=duplicate 时必须给 duplicateBug");
        }
        actionName = "resolved";
        extra = resolution;
        set("status", "resolved");
        set("confirmed", 1);
        set("resolution", resolution);
        set("resolvedBuild", request.resolvedBuild ?? before.resolvedBuild ?? "trunk");
        if (resolution === "duplicate") set("duplicateBug", request.duplicateBug ?? 0);
        set("resolvedBy", ctx.account);
        set("resolvedDate", env.now);
        set("assignedTo", before.openedBy || before.assignedTo);
        set("assignedDate", env.now);
        // 解决版本不是 trunk 时，禅道会把「该版本对应的测试单」填进 bug.testtask
        // （module/bug/model.php：resolvedBuild 有值就查 zt_testtask 最新一条）。
        {
          const build = String(next["resolvedBuild"] ?? before.resolvedBuild ?? "");
          if (build !== "" && build !== "trunk") {
            const testtask = await tx.one<{ id: number } & RowDataPacket>(
              `SELECT id FROM ${tx.table("testtask")} WHERE build = ? ORDER BY id DESC LIMIT 1`,
              [build],
            );
            if (testtask?.id && !Number(before.testtask ?? 0)) set("testtask", testtask.id);
          }
        }
        break;
      }

      case "close": {
        actionName = "closed";
        set("status", "closed");
        set("assignedTo", "closed");
        set("confirmed", 1);
        set("assignedDate", env.now);
        set("closedBy", ctx.account);
        set("closedDate", env.now);
        break;
      }

      case "comment": {
        if (!comment.trim()) throw new ChannelError("db", "write", "备注内容不能为空");
        actionName = "commented";
        needKanban = false;
        break;
      }

      case "recordworkhour": {
        // BUG 的「日志」= biz 版的 effort 模块，与 task 的 recordworkhour 是两套东西：
        // 库内只插 zt_effort（left 恒 0.00）+ action(recordestimate, extra=本次数值, read=1)
        // + actionrecent + history(consumed 累计总额)；zt_bug 没有 consumed 列，不动业务字段。
        if (before.status === "closed") {
          throw new ChannelError("db", "write-rejected", `BUG #${request.id} 已关闭，不能记工时`);
        }
        const delta = round2(request.consumed ?? 0);
        if (delta <= 0) throw new ChannelError("db", "write-rejected", "本次工时必须大于 0");
        const date = request.date ?? today();
        actionName = "recordestimate";
        extra = String(delta);
        actionRead = 1;
        effort = { date, consumed: delta, left: 0, work: comment };
        needKanban = false;
        break;
      }

      default:
        throw new ChannelError("db", "write", `BUG 不支持动作：${request.action}`);
    }

    // 工时日志要记「累计总额」的历史，所以先算出写之前的累计值。
    const previousTotal =
      request.action === "recordworkhour" ? await sumBugConsumed(tx, request.id) : 0;

    if (request.action !== "comment") {
      set("lastEditedBy", ctx.account);
      set("lastEditedDate", env.now);
      const clause = assignClause(BUG_COLUMNS, updates);
      await tx.execute(
        `UPDATE ${tx.table("bug")} SET ${clause.sql} WHERE id = ?`,
        [...clause.params, request.id],
      );
    }

    if (effort) {
      effortID = await insertEffort(env, {
        objectType: "bug",
        objectID: request.id,
        product,
        project: before.project,
        execution: before.execution,
        date: effort.date,
        consumed: effort.consumed,
        left: effort.left,
        work: effort.work,
        vision: before.vision,
      });
      await insertEffortAction(env, effortID, before.vision);
    }

    const actionId = await insertAction(env, {
      objectType: "bug",
      objectID: request.id,
      action: actionName,
      comment,
      extra,
      product,
      project: before.project,
      execution: before.execution,
      vision: before.vision,
      read: actionRead,
    });

    let changes =
      request.action === "comment" ? [] : diffRow(BUG_TRACKED, before as unknown as Record<string, unknown>, next);
    if (request.action === "recordworkhour" && effort) {
      // 实测 bug recordestimate 的 history 恰好一行：consumed 从上一次累计 → 本次后累计，
      // oldValue/newValue 为 NULL（detail 面板自己渲染数字）。
      changes = [
        {
          field: "consumed",
          old: previousTotal === 0 ? "0" : String(round2(previousTotal)),
          next: String(round2(previousTotal + effort.consumed)),
        },
      ];
    }
    await insertHistory(env, actionId, changes);

    await insertNotify(env, {
      actionId,
      action: actionName,
      objectType: "bug",
      objectID: request.id,
      title: before.title,
      assignedTo: String(next["assignedTo"] ?? before.assignedTo),
      baseUrl: ctx.baseUrl,
      useDataApp: false,
    });

    if (needKanban) {
      const moved = await refreshKanban(env, {
        laneType: "bug",
        execution: before.execution,
        id: request.id,
        status: String(next["status"] ?? before.status),
      });
      if (!moved) env.warnings.push("没找到 BUG 看板泳道，卡片未重排（详情页数据不受影响）");
    }

    if (effortID > 0) await rebuildSearchIndex(tx, "effort", effortID, { vision: before.vision });
    if (shouldRebuildIndex(actionName, comment)) {
      await rebuildSearchIndex(tx, "bug", request.id, { comment, vision: before.vision });
    }
    if (request.action === "resolve") {
      // 解决版本不是 trunk 时，把 BUG 记进该版本的 bugs 列表（module/bug/model.php::linkBugToBuild）。
      await linkBugToBuild(followupEnv, request.id, String(next["resolvedBuild"] ?? before.resolvedBuild ?? ""));
    }

    const after = await tx.one<BugRow>(`SELECT * FROM ${tx.table("bug")} WHERE id = ?`, [request.id]);
    if (!after) throw new ChannelError("db", "write", "写后回读失败");

    return {
      channel: "db" as const,
      kind: "bug" as const,
      id: request.id,
      action: request.action,
      actionName,
      before: snapshotOfBug(before),
      after: snapshotOfBug(after),
      message: effort
        ? `已通过数据库通道给 BUG #${request.id} 记了 ${effort.consumed} 小时（effort/action/actionproduct/history）`
        : `已通过数据库通道把 BUG #${request.id} 的「${actionName}」写全（bug/action/history/notify/kanban）`,
      warnings: env.warnings,
    };
  });
}

/** DB 线的写入口。 */
export async function writeViaDb(ctx: DbWriteContext, request: WriteRequest): Promise<WriteOutcome> {
  if (request.kind === "task") return writeTask(ctx, request);
  return writeBug(ctx, request);
}
