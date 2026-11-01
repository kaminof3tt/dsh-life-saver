/**
 * 写操作之后的「联动」：父任务汇总、需求阶段、build 回填。
 *
 * HTTP 线这些是禅道自己做的（`updateParentStatus()` / `story->setStage()` /
 * `linkBugToBuild()`），DB 线必须自己补，否则两条线的结果不一致：
 * 一个 312 行有父任务、1776 行挂着需求的库，只改子任务不动父任务，
 * 团队在禅道上看到的就是「工时汇总不对」「需求阶段不动」。
 *
 * 依据（tag zentaopms_16.2）：
 *   module/task/model.php::computeWorkingHours() / computeBeginAndEnd() / updateParentStatus()
 *   module/story/model.php::setStage()
 *   module/bug/model.php::linkBugToBuild()
 *   module/common/model.php::createChanges()   决定哪些字段进「历史」
 *
 * 一处与源码不同、但按本库实测数据对齐的地方：16.2 的 updateParentStatus 会把父任务的
 * `parent` 写成 `'-1'` 当标记，本库（biz12.7）里 175 个父任务的 parent 全是 `0`、
 * 没有任何一行是 `-1`。所以这里**不写那个标记**，与库内现状保持一致。
 */

import type { RowDataPacket } from "mysql2/promise";

import { STATUS_LABEL } from "../../domain/labels.js";
import type { DbTransaction } from "./pool.js";

/**
 * 空的日期字段要写 NULL，不能写空串。
 *
 * 本库 `zt_task` 的 `finishedDate/closedDate/realStarted` 空值全部是 NULL（2213 行里零值 0 行），
 * 而 MySQL 在非严格模式下会把空串存成 `0000-00-00 00:00:00`，那会让「清空完成时间」变成一次
 * 假的字段变更（历史面板多出一行 `finishedDate`）。
 */
export function dbValue(column: string, value: unknown): unknown {
  if (value !== "") return value;
  const dateLike = column.endsWith("Date") || column === "deadline" || column === "estStarted" || column === "realStarted";
  return dateLike ? null : value;
}

/** 一条「历史」变更（字段 → 旧值/新值）。 */
export interface FollowupChange {
  readonly field: string;
  readonly old: unknown;
  readonly next: unknown;
}

/** 由 `write.ts` 注入的低层能力（避免这个文件反过来 import 写实现）。 */
export interface FollowupHooks {
  /** 插一条动作流水（含 actionrecent），返回 action id。 */
  createAction(params: {
    readonly objectType: string;
    readonly objectID: number;
    readonly action: string;
    readonly comment?: string;
    readonly extra?: string;
    readonly product: string;
    readonly project: number;
    readonly execution: number;
    readonly vision: string;
  }): Promise<number>;
  /** 每个变更字段写一行 zt_history。 */
  logHistory(actionId: number, changes: readonly FollowupChange[]): Promise<void>;
  /** 按「需求 → 产品 / 否则执行所属项目 → 产品」算 action.product（与主对象同一套规则）。 */
  resolveProduct(row: { readonly story: number; readonly project: number; readonly execution: number }): Promise<string>;
}

export interface FollowupEnv {
  readonly tx: DbTransaction;
  readonly now: string;
  readonly account: string;
  readonly warnings: string[];
  readonly hooks: FollowupHooks;
}

interface TaskLiteRow extends RowDataPacket {
  id: number;
  parent: number;
  story: number;
  project: number;
  execution: number;
  status: string;
  assignedTo: string;
  openedBy: string;
  estimate: string | number;
  consumed: string | number;
  left: string | number;
  estStarted: string | null;
  realStarted: string | null;
  deadline: string | null;
  finishedBy: string;
  finishedDate: string | null;
  closedBy: string;
  closedDate: string | null;
  closedReason: string;
  canceledBy: string;
  canceledDate: string | null;
}

interface StoryRow extends RowDataPacket {
  id: number;
  product: number;
  branch: number;
  plan: string;
  status: string;
  stage: string;
  stagedBy: string;
}

interface TypeRow extends RowDataPacket {
  type: string;
}

interface ExecRow extends RowDataPacket {
  project: number;
  branch: number | null;
}

interface StoryTaskRow extends RowDataPacket {
  type: string;
  execution: number;
  status: string;
}

interface BranchRow extends RowDataPacket {
  branch: number;
}

interface BuildRow extends RowDataPacket {
  id: number;
  bugs: string | null;
}

/** 参与「父任务变了什么」比对的字段（`createChanges` 会跳过 lastEditedBy/Date 与 assignedDate）。 */
const PARENT_TRACKED = [
  "estimate",
  "consumed",
  "left",
  "estStarted",
  "realStarted",
  "deadline",
  "status",
  "assignedTo",
  "finishedBy",
  "finishedDate",
  "closedBy",
  "closedDate",
  "closedReason",
  "canceledBy",
  "canceledDate",
] as const;

/**
 * decimal 列读回来是字符串（"61.00"），汇总值要按同样的位数写回去才不会误报变更。
 *
 * 同时用于「变了什么」的比对：`consumed` 这类列在库里的形态可以是 `61.00`（字符串）、
 * 也可能是驱动按 `bigNumberStrings: false` 给的 `61`（number）。直接 `String()` 比较
 * 会把这两种形态判成一次变更，于是每次写都多出一条假 history。
 */
export function decimalText(value: string | number | null | undefined): string {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(2);
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * `computeWorkingHours()`：把子任务的预计/消耗/剩余汇总到父任务。
 *
 * 剩余工时只累加「非已关闭」的子任务——已关闭的剩余工时在禅道里不计入。
 */
export async function computeWorkingHours(env: FollowupEnv, parentID: number): Promise<void> {
  const rows = await env.tx.query<TaskLiteRow>(
    `SELECT id, estimate, consumed, \`left\`, status FROM ${env.tx.table("task")}
      WHERE parent = ? AND status != 'cancel' AND deleted = 0`,
    [parentID],
  );
  if (rows.length === 0) return;

  let estimate = 0;
  let consumed = 0;
  let left = 0;
  for (const row of rows) {
    estimate += Number(row.estimate ?? 0);
    consumed += Number(row.consumed ?? 0);
    if (row.status !== "closed") left += Number(row.left ?? 0);
  }

  await env.tx.execute(
    `UPDATE ${env.tx.table("task")}
        SET estimate = ?, consumed = ?, \`left\` = ?, lastEditedBy = ?, lastEditedDate = ?
      WHERE id = ?`,
    [estimate.toFixed(2), consumed.toFixed(2), left.toFixed(2), env.account, env.now, parentID],
  );
}

/**
 * `computeBeginAndEnd()`：父任务的计划开始取子任务最早值、实际开始取最早值、截止取最晚值。
 *
 * 源码里 `formatTime()` 把空日期变成空串，而「首次赋值」是无条件的，
 * 于是「第一个子任务没有计划开始」会让父任务拿到空串——照抄。
 */
export async function computeBeginAndEnd(env: FollowupEnv, parentID: number): Promise<void> {
  const rows = await env.tx.query<TaskLiteRow>(
    `SELECT estStarted, realStarted, deadline FROM ${env.tx.table("task")}
      WHERE parent = ? AND status != 'cancel' AND deleted = 0`,
    [parentID],
  );
  if (rows.length === 0) return;

  let earliestEst: string | undefined;
  let earliestReal: string | undefined;
  let latestDeadline: string | undefined;

  for (const row of rows) {
    const est = text(row.estStarted);
    const real = text(row.realStarted);
    const due = text(row.deadline);

    if (earliestEst === undefined || (est !== "" && earliestEst > est)) earliestEst = est;
    if (earliestReal === undefined || (real !== "" && earliestReal > real)) earliestReal = real;
    if (latestDeadline === undefined || (due !== "" && latestDeadline < due)) latestDeadline = due;
  }

  await env.tx.execute(
    `UPDATE ${env.tx.table("task")} SET estStarted = ?, realStarted = ?, deadline = ? WHERE id = ?`,
    [dbValue("estStarted", earliestEst ?? ""), dbValue("realStarted", earliestReal ?? ""), dbValue("deadline", latestDeadline ?? ""), parentID],
  );
}

/** 读一份「参与比对」的父任务快照（含 decimal 归一，避免 61 与 61.00 被当成变更）。 */
function snapshot(row: TaskLiteRow | undefined): Record<string, unknown> {
  if (row === undefined) return {};
  return {
    estimate: decimalText(row.estimate),
    consumed: decimalText(row.consumed),
    left: decimalText(row.left),
    estStarted: text(row.estStarted),
    realStarted: text(row.realStarted),
    deadline: text(row.deadline),
    status: text(row.status),
    assignedTo: text(row.assignedTo),
    finishedBy: text(row.finishedBy),
    finishedDate: text(row.finishedDate),
    closedBy: text(row.closedBy),
    closedDate: text(row.closedDate),
    closedReason: text(row.closedReason),
    canceledBy: text(row.canceledBy),
    canceledDate: text(row.canceledDate),
  };
}

function diffSnapshot(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FollowupChange[] {
  const changes: FollowupChange[] = [];
  for (const field of PARENT_TRACKED) {
    if (text(before[field]) !== text(after[field])) {
      changes.push({ field, old: before[field], next: after[field] });
    }
  }
  return changes;
}

/**
 * `updateParentStatus()`：子任务动完之后把父任务的状态算一遍。
 *
 * 汇总规则（与源码逐条一致）：
 *   - 只有一个子任务 → 就用它的状态；
 *   - 有 doing 或 pause → doing；
 *   - 有 (done 或 closedReason=done) 且有 wait → doing；
 *   - 有 wait → wait；有 done → done；有 closed → closed；有 cancel → cancel。
 *
 * 只有**状态真的变了**才写动作流水（本库 175 个父任务共 335 条状态类动作，
 * 且没有一条是「只改了工时」产生的 edited 动作，所以这一版不造 edited）。
 */
export async function syncParentTask(env: FollowupEnv, childID: number): Promise<boolean> {
  const child = await env.tx.one<TaskLiteRow>(
    `SELECT id, parent, story, project, execution, status, assignedTo, openedBy, estimate, consumed, \`left\`,
            estStarted, realStarted, deadline, finishedBy, finishedDate,
            closedBy, closedDate, closedReason, canceledBy, canceledDate
       FROM ${env.tx.table("task")} WHERE id = ?`,
    [childID],
  );
  if (child === undefined) return false;
  const parentID = Number(child.parent ?? 0);
  if (!Number.isFinite(parentID) || parentID <= 0) return false;

  const before = await env.tx.one<TaskLiteRow>(`SELECT * FROM ${env.tx.table("task")} WHERE id = ?`, [parentID]);
  if (before === undefined) return false;
  const beforeSnapshot = snapshot(before);

  // 先确认这个父任务底下真有子任务，再动手改它。
  // 反过来写（先 computeWorkingHours 再判空）会让「有 parent 字段但没有子任务」的
  // 行被盲写一遍：汇总把工时归零、却不产生任何 action / history，
  // 用户看到的是一条没有任何记录可解释的静默改动。
  const children = await env.tx.query<{ status: string; closedReason: string } & RowDataPacket>(
    `SELECT status, closedReason FROM ${env.tx.table("task")} WHERE parent = ? AND deleted = 0`,
    [parentID],
  );
  if (children.length === 0) return false;

  await computeWorkingHours(env, parentID);
  await computeBeginAndEnd(env, parentID);

  const statuses = new Set(children.map((row) => row.status));
  const doneChildren = children.filter((row) => row.status === "done" || row.closedReason === "done");

  let status = "";
  if (children.length === 1) {
    status = children[0]?.status ?? "";
  } else if (statuses.has("doing") || statuses.has("pause")) {
    status = "doing";
  } else if (doneChildren.length > 0 && statuses.has("wait")) {
    status = "doing";
  } else if (statuses.has("wait")) {
    status = "wait";
  } else if (statuses.has("done")) {
    status = "done";
  } else if (statuses.has("closed")) {
    status = "closed";
  } else if (statuses.has("cancel")) {
    status = "cancel";
  }

  const parent = await env.tx.one<TaskLiteRow>(
    `SELECT * FROM ${env.tx.table("task")} WHERE id = ? AND deleted = 0`,
    [parentID],
  );
  if (parent === undefined) return false;

  // 状态没变也要看汇总有没有变（工时/起止时间），否则调用方会误报「什么都没变」。
  const statusChanged = status !== "" && parent.status !== status;

  const sets: Record<string, unknown> = { status };
  if (status === "done") {
    sets["assignedTo"] = parent.openedBy;
    sets["assignedDate"] = env.now;
    sets["finishedBy"] = env.account;
    sets["finishedDate"] = env.now;
  } else if (status === "cancel") {
    sets["assignedTo"] = parent.openedBy;
    sets["assignedDate"] = env.now;
    sets["finishedBy"] = "";
    sets["finishedDate"] = "";
    sets["canceledBy"] = env.account;
    sets["canceledDate"] = env.now;
  } else if (status === "closed") {
    sets["assignedTo"] = "closed";
    sets["assignedDate"] = env.now;
    sets["closedBy"] = env.account;
    sets["closedDate"] = env.now;
    sets["closedReason"] = "done";
  } else {
    // doing / wait：父任务曾被关闭就把指派人接回子任务的指派人。
    if (parent.assignedTo === "closed") {
      sets["assignedTo"] = child.assignedTo;
      sets["assignedDate"] = env.now;
    }
    sets["finishedBy"] = "";
    sets["finishedDate"] = "";
    sets["closedBy"] = "";
    sets["closedDate"] = "";
    sets["closedReason"] = "";
  }
  sets["lastEditedBy"] = env.account;
  sets["lastEditedDate"] = env.now;

  if (statusChanged) {
    const columns = Object.keys(sets);
    // 列名全部反引号包起来：`left` 是 MySQL 保留字，靠反引号统一处理，不用特例。
    const clause = columns.map((column) => `\`${column}\` = ?`).join(", ");
    await env.tx.execute(`UPDATE ${env.tx.table("task")} SET ${clause} WHERE id = ?`, [
      ...columns.map((column) => dbValue(column, sets[column])),
      parentID,
    ]);
  }

  const after = await env.tx.one<TaskLiteRow>(`SELECT * FROM ${env.tx.table("task")} WHERE id = ?`, [parentID]);
  const changes = diffSnapshot(beforeSnapshot, snapshot(after));
  if (changes.length === 0) return false;
  if (!statusChanged) return true;

  // 父任务的动作名：按「旧状态 → 新状态」定，与源码那张映射表一致。
  const oldStatus = text(before.status);
  let action = "";
  if (status === "done" && oldStatus !== "done") action = "finished";
  else if (status === "closed" && oldStatus !== "closed") action = "closed";
  else if (status === "cancel" && oldStatus !== "cancel") action = "canceled";
  else if (status === "doing" && oldStatus === "wait") action = "started";
  else if (status === "doing" && oldStatus === "pause") action = "restarted";
  else if (status === "doing") action = "activated";

  if (action === "") return true;

  // 父任务的动作也落一条流水，但不发通知（本库 335 条父任务状态动作对应通知 0 条）。
  // product/project/execution 与父任务自身一致（实测：task 1872 的父任务动作是 project 215 / execution 216）。
  const product = await env.hooks.resolveProduct({
    story: Number(parent.story ?? 0),
    project: Number(parent.project ?? 0),
    execution: Number(parent.execution ?? 0),
  });

  const actionId = await env.hooks.createAction({
    objectType: "task",
    objectID: parentID,
    action,
    product,
    project: Number(parent.project ?? 0),
    execution: Number(parent.execution ?? 0),
    vision: "rnd",
  });
  await env.hooks.logHistory(actionId, changes);
  return true;
}

/**
 * `story->setStage()`：按需求下的 devel/test 任务重算需求阶段。
 *
 * 本库所有产品都是 `type='normal'`，所以 `hasBranch` 恒为 false，
 * 只会写 `zt_story.stage`（`zt_storystage` 一行都没有）。多分支产品在这里不展开，
 * 遇到时通过 warnings 明确说明。
 */
export async function syncStoryStage(env: FollowupEnv, storyID: number): Promise<boolean> {
  const story = await env.tx.one<StoryRow>(`SELECT * FROM ${env.tx.table("story")} WHERE id = ?`, [storyID]);
  if (story === undefined) return false;

  const product = await env.tx.one<TypeRow>(`SELECT type FROM ${env.tx.table("product")} WHERE id = ?`, [story.product]);
  const executions = await env.tx.query<ExecRow>(
    `SELECT t1.project AS project, t3.branch AS branch
       FROM ${env.tx.table("projectstory")} t1
       LEFT JOIN ${env.tx.table("project")} t2 ON t1.project = t2.id
       LEFT JOIN ${env.tx.table("projectproduct")} t3 ON t1.project = t3.project
      WHERE t1.story = ? AND t2.deleted = 0`,
    [storyID],
  );
  const hasBranch = product !== undefined && product.type !== "normal" && !story.branch;
  if (hasBranch) {
    env.warnings.push(`需求 #${storyID} 属于多分支产品，DB 线没有复刻 zt_storystage 的分支阶段，请在禅道上复核`);
  }

  const stages: string[] = [];

  if (story.status === "closed") {
    await env.tx.execute(`UPDATE ${env.tx.table("story")} SET stage = 'closed' WHERE id = ?`, [storyID]);
    return true;
  }

  if (executions.length === 0) {
    // 没有执行：有计划就 planned，没计划就 wait。源码是两条带条件的 update。
    await env.tx.execute(
      `UPDATE ${env.tx.table("story")} SET stage = 'wait' WHERE id = ? AND (plan = '' OR plan = '0')`,
      [storyID],
    );
    await env.tx.execute(
      `UPDATE ${env.tx.table("story")} SET stage = 'planned' WHERE id = ? AND plan != '' AND plan != '0'`,
      [storyID],
    );
    return true;
  }

  const executionIDs = [...new Set(executions.map((row) => Number(row.project)))];
  const placeholders = executionIDs.map(() => "?").join(", ");
  const tasks = await env.tx.query<StoryTaskRow>(
    `SELECT type, execution, status FROM ${env.tx.table("task")}
      WHERE execution IN (${placeholders}) AND type IN ('devel', 'test') AND story = ?
        AND deleted = 0 AND status != 'cancel' AND closedReason != 'cancel'`,
    [...executionIDs, storyID],
  );

  if (tasks.length === 0) {
    await env.tx.execute(`UPDATE ${env.tx.table("story")} SET stage = 'projected' WHERE id = ?`, [storyID]);
    return true;
  }

  // 按分支统计 devel/test 各状态的条数。分支只用于分组：本库 `zt_project.branch`
  // 恒为 0，所以这里实际只跑一组；分组保留是为了不把「多分支部署」的账算错。
  const branchOf = (execution: number): number => {
    const hit = executions.find((row) => Number(row.project) === execution);
    return Number(hit?.branch ?? 0);
  };
  const stats = new Map<number, { devel: Record<string, number>; test: Record<string, number> }>();
  const count = new Map<number, { devel: number; test: number }>();
  for (const task of tasks) {
    const branch = branchOf(Number(task.execution));
    if (!stats.has(branch)) stats.set(branch, { devel: {}, test: {} });
    const perBranch = stats.get(branch)!;
    const kind = task.type === "test" ? "test" : "devel";
    const state = task.status === "" ? "wait" : task.status === "closed" ? "done" : task.status;
    perBranch[kind][state] = (perBranch[kind][state] ?? 0) + 1;
    const totals = count.get(branch) ?? { devel: 0, test: 0 };
    totals[kind] += 1;
    count.set(branch, totals);
  }

  for (const [branch, perBranch] of stats) {
    const totals = count.get(branch) ?? { devel: 0, test: 0 };
    const devel = perBranch.devel;
    const test = perBranch.test;
    const develDone = devel["done"] ?? 0;
    const develWait = devel["wait"] ?? 0;
    const develDoing = devel["doing"] ?? 0;
    const testWait = test["wait"] ?? 0;
    const testDone = test["done"] ?? 0;
    const testDoing = test["doing"] ?? 0;
    const testPause = test["pause"] ?? 0;

    let stage = "projected";
    // 顺序不能改：后面几条会覆盖前面的结果，源码就是这么叠的。
    if (develDoing > 0 && testWait === totals.test) stage = "developing";
    if (develWait > 0 && develDone > 0 && testWait === totals.test) stage = "developing";
    if (develDone === totals.devel && totals.devel > 0 && testWait === totals.test) stage = "developed";
    if (develDone === totals.devel && totals.devel > 0 && testWait > 0 && testDone > 0) stage = "testing";
    if (testDoing > 0 || testPause > 0) stage = "testing";
    if ((develWait > 0 || develDoing > 0) && testDone === totals.test && totals.test > 0) stage = "testing";
    if (develDone === totals.devel && testDone === totals.test && totals.test > 0) stage = "tested";

    stages.push(stage);
  }

  const releases = await env.tx.query<BranchRow>(
    `SELECT branch FROM ${env.tx.table("release")}
      WHERE CONCAT(',', stories, ',') LIKE ? AND deleted = 0`,
    [`%,${storyID},%`],
  );
  for (const release of releases) stages.push("released");

  if (stages.length === 0) return false;
  const next = stages[0] ?? story.stage;
  if (story.stage === next) return false;
  await env.tx.execute(`UPDATE ${env.tx.table("story")} SET stage = ? WHERE id = ?`, [next, storyID]);
  env.warnings.push(`需求 #${storyID} 的阶段已由 ${story.stage || "空"} 变为 ${STATUS_LABEL[next] ?? next}`);
  return true;
}

/**
 * `linkBugToBuild()`：解决版本不是 trunk 时，把 BUG 记进那版 build 的 bugs 列表。
 *
 * 顺带更新 release.bugs（同一个版本可能已经发过版）。
 */
export async function linkBugToBuild(env: FollowupEnv, bugID: number, resolvedBuild: string): Promise<void> {
  const buildID = Number(resolvedBuild);
  if (!resolvedBuild || resolvedBuild === "trunk" || !Number.isFinite(buildID) || buildID <= 0) return;

  const build = await env.tx.one<BuildRow>(`SELECT id, bugs FROM ${env.tx.table("build")} WHERE id = ?`, [buildID]);
  if (build === undefined) return;

  const merge = (existing: string | null): string => {
    const list = `${existing ?? ""},${bugID}`
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    return [...new Set(list)].join(",");
  };

  await env.tx.execute(`UPDATE ${env.tx.table("build")} SET bugs = ? WHERE id = ?`, [merge(build.bugs), buildID]);

  const releases = await env.tx.query<BuildRow>(
    `SELECT id, bugs FROM ${env.tx.table("release")} WHERE build = ? AND deleted = 0`,
    [buildID],
  );
  for (const release of releases) {
    await env.tx.execute(`UPDATE ${env.tx.table("release")} SET bugs = ? WHERE id = ?`, [
      merge(release.bugs),
      release.id,
    ]);
  }
}
