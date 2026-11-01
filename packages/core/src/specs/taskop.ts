import { ACTION_LABELS, TASK_ACTIONS, type TaskWriteAction } from "../channels/write.js";
import type { ToolSpec } from "./types.js";

/**
 * 每个动作「还缺什么参数」的补充说明。
 *
 * 这不是 `ACTION_LABELS` 的重复：label 是动作的中文名（也用于渲染历史记录），
 * 这里是给模型的「调用前该准备什么」。两者分开写，改中文名不会连带动到语义说明。
 */
const ACTION_HINT: Readonly<Record<TaskWriteAction, string>> = {
  start: "开始任务。需要 left（剩余工时）；consumed 是累计消耗，不填保持原值。",
  recordworkhour: "只记一条工时。需要 consumed（本次工时，>0）与 left（记完还剩多少）。",
  finish: "完成任务。consumed 是这次补记的工时（可为 0）；left 自动归零。",
  pause: "暂停任务（任务必须是进行中）。",
  activate: "把已完成/已取消/已关闭的任务重新激活到进行中，需要 left。",
  close: "关闭任务（只能关已完成或已取消的）。",
  cancel: "取消任务。",
  comment: "只留一条备注，不改任何字段。",
};

/** zentao_task_op：改任务的状态/工时/备注。会真的写。 */
export const TASKOP_SPEC: ToolSpec = {
  name: "zentao_task_op",
  description:
    "对禅道任务执行一次写操作（开始/记工时/完成/暂停/激活/关闭/取消/备注）。会真的写入禅道，没有预览。" +
    "只接受单条操作；改别人名下的任务需要在配置里打开 write.allowOthers。" +
    "完成后工具会回读任务并把写前/写后的关键字段一起返回，便于确认。",
  properties: {
    id: {
      type: "string",
      description: "任务编号，或直接粘浏览器地址栏里的禅道任务链接（工具会自己认编号）。",
      required: true,
    },
    action: {
      type: "string",
      enum: [...TASK_ACTIONS],
      description: TASK_ACTIONS.map((item) => `${item}=${ACTION_LABELS[item]}（${ACTION_HINT[item]}）`).join("；"),
      required: true,
    },
    comment: {
      type: "string",
      description: "备注正文。会写进动作记录的评论；finish/recordworkhour 时也是工时行的说明，close/pause 时是唯一说明。",
    },
    consumed: {
      type: "number",
      description: "工时（小时）。recordworkhour 必填且 >0；start 表示累计消耗；finish 表示这次补记的量（可为 0）。",
    },
    left: {
      type: "number",
      description: "剩余工时。start/activate/recordworkhour 需要；finish 自动归零。",
    },
    date: {
      type: "string",
      description: "工时归属日期 YYYY-MM-DD，默认今天（仅 recordworkhour 使用）。",
    },
    realStarted: {
      type: "string",
      description: "开始时间 YYYY-MM-DD HH:mm:ss。finish 时若原值为空则必填；不填默认当前时间。",
    },
    finishedDate: {
      type: "string",
      description: "完成时间 YYYY-MM-DD HH:mm:ss，默认当前时间。",
    },
    assignedTo: {
      type: "string",
      description: "指派给谁（禅道账号）。不填按禅道默认：finish/close 后指回创建人。",
    },
    expectStatus: {
      type: "string",
      description: "安全断言：写之前任务状态必须等于这个值，否则拒绝执行。",
    },
  },
};
