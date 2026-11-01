import { ACTION_LABELS, BUG_ACTIONS, RESOLUTIONS } from "../channels/write.js";
import { RESOLUTION_LABEL } from "../domain/labels.js";
import type { ToolSpec } from "./types.js";

/**
 * 解决方式的补充说明：**不重复中文名**，只说「还需要额外给什么」。
 *
 * 中文名唯一来源是 `RESOLUTION_LABEL`（渲染历史记录也用它）。这里曾经把两套都写一遍，
 * 结果 9 个里有 5 个对不上——同一件事两个名字，模型和人都得猜。
 */
const RESOLUTION_EXTRA: Readonly<Partial<Record<string, string>>> = {
  fixed: "需要 resolvedBuild 指明解决版本",
  duplicate: "需要 duplicateBug 指明原 BUG 编号",
};

function resolutionText(item: string): string {
  const label = RESOLUTION_LABEL[item] ?? item;
  const extra = RESOLUTION_EXTRA[item];
  return extra ? `${label}（${extra}）` : label;
}

/** zentao_bug_op：确认/解决/关闭 BUG、加备注、记日志工时。会真的写。 */
export const BUGOP_SPEC: ToolSpec = {
  name: "zentao_bug_op",
  description:
    "对禅道 BUG 执行一次写操作（确认/解决/关闭/备注/记日志工时）。会真的写入禅道，没有预览。" +
    "只接受单条操作；改别人名下的 BUG 需要在配置里打开 write.allowOthers。" +
    "recordworkhour 就是 BUG 详情页底部那个「日志」按钮，可多次记、累加。" +
    "完成后会回读 BUG 并把写前/写后的关键字段一起返回，便于确认。",
  properties: {
    id: {
      type: "string",
      description: "BUG 编号，或直接粘浏览器地址栏里的禅道 BUG 链接（工具会自己认编号）。",
      required: true,
    },
    action: {
      type: "string",
      enum: [...BUG_ACTIONS],
      description: BUG_ACTIONS.map((item) => `${item}=${ACTION_LABELS[item]}`).join("；"),
      required: true,
    },
    comment: {
      type: "string",
      description: "备注正文，写进动作记录的评论。",
    },
    resolution: {
      type: "string",
      enum: [...RESOLUTIONS],
      description: `解决方式（仅 resolve）：${RESOLUTIONS.map((item) => `${item}=${resolutionText(item)}`).join("；")}`,
    },
    resolvedBuild: {
      type: "string",
      description: "解决版本（仅 resolve；resolution=fixed 时必须给，不填按 trunk）。",
    },
    consumed: {
      type: "number",
      description: "本次消耗工时（小时，仅 recordworkhour 必填）。同一条 BUG 可以多次记，累计相加。",
    },
    date: {
      type: "string",
      description: "日志日期 YYYY-MM-DD（仅 recordworkhour），不填用今天。",
    },
    duplicateBug: {
      type: "integer",
      description: "重复的 BUG 编号（仅 resolve 且 resolution=duplicate 时必须给）。",
    },
    assignedTo: {
      type: "string",
      description: "指派给谁（禅道账号）。不填按禅道默认：resolve 后指回创建人。",
    },
    expectStatus: {
      type: "string",
      description: "安全断言：写之前 BUG 状态必须等于这个值，否则拒绝执行。",
    },
  },
};
