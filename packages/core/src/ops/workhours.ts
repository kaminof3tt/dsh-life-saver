/**
 * zentao_workhours 的执行与渲染：把区间内的工时事实取出来。
 *
 * 口径（很重要）：
 *   - 唯一按人来源是 zt_effort（biz 版），不能用 zt_task.consumed 汇总——
 *     库里有大量历史任务 consumed 有值但 effort 没有明细。
 *   - 统计只走库通道（页面没有「按人按区间」的聚合口径）。
 */

import type { WorklogReport } from "../channels/stats.js";
import { LifeSaverError, type LifeSaverService } from "../service.js";
import { asEntityKind, clampLimit, wrapUntrusted } from "../tools/shared.js";
import type { ToolRunContext } from "./context.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface WorkhoursToolOutput {
  account: string;
  from: string;
  to: string;
  total: number;
  markdown: string;
}

function asDate(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new LifeSaverError("bad-args", `参数 ${what} 必须是 YYYY-MM-DD`);
  const text = value.trim();
  if (!DATE_RE.test(text)) throw new LifeSaverError("bad-args", `参数 ${what} 必须是 YYYY-MM-DD，收到「${text}」`);
  return text;
}

function kindLabel(kind: string): string {
  return kind === "task" ? "任务" : kind === "bug" ? "BUG" : kind === "story" ? "需求" : kind;
}

/**
 * 先把总账说清楚，再按对象、逐条、逐日，最后才是漏项与口径说明。
 *
 * `groupCount` 是**截断前**的对象数：limit 会把 `report.groups` 切短，合计行不能跟着变少，
 * 否则「涉及 5 个对象」与末尾「共 32 个对象，这里只展示了前 5 个」自相矛盾。
 */
export function renderWorklogReport(report: WorklogReport, detail: boolean, groupCount = report.groups.length): string {
  const lines: string[] = [];
  const scope = report.from === report.to ? report.from : `${report.from} ~ ${report.to}`;
  lines.push(`# ${report.account} 的工时（${scope}）`, "");
  lines.push(`- 合计：**${report.total} 小时**，涉及 ${groupCount} 个对象、${report.entries.length} 条工时记录`);

  if (report.groups.length > 0) {
    lines.push("", "## 做了什么", "");
    for (const group of report.groups) {
      const meta = [group.status, group.consumed ? `${group.consumed} 小时` : undefined].filter(Boolean).join(" · ");
      lines.push(`- ${kindLabel(group.kind)} #${group.id} ${group.title}${meta ? `（${meta}）` : ""}`);
      if (group.projectName) lines.push(`  - 归属：${group.projectName}`);
      if (group.firstDate !== group.lastDate) lines.push(`  - 时间：${group.firstDate} ~ ${group.lastDate}`);
      for (const note of group.notes) lines.push(`  - ${note}`);
    }
  }

  if (detail && report.entries.length > 0) {
    lines.push("", "## 逐条工时", "");
    for (const entry of report.entries) {
      const work = entry.work ? ` ${entry.work}` : "";
      const left = entry.left === undefined ? "" : `，剩 ${entry.left}h`;
      lines.push(`- ${entry.date} ${kindLabel(entry.kind)} #${entry.id}${work} — ${entry.consumed}h${left}`);
    }
  }

  if (report.daily.length > 1) {
    lines.push("", "## 按天", "");
    for (const day of report.daily) lines.push(`- ${day.date}：${day.consumed} 小时（${day.count} 条）`);
  }

  if (report.missing.length > 0) {
    lines.push("", "## 有动作但没记工时", "");
    for (const item of report.missing) {
      lines.push(`- ${kindLabel(item.kind)} #${item.id} ${item.title}（${item.actions.join("/")}，最后 ${item.lastDate}）`);
    }
    lines.push("", "这些对象在区间内有状态动作，但没有对应工时明细——需要补记就用 zentao_task_op 的 recordworkhour。");
  }

  if (report.warnings.length > 0) {
    lines.push("", "## 说明", "", ...report.warnings.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

export async function runWorkhoursTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<WorkhoursToolOutput> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const from = asDate(args.from, "from");
  const to = asDate(args.to, "to");
  if (!from) throw new LifeSaverError("bad-args", "参数 from 不能为空（YYYY-MM-DD）");
  if (!to) throw new LifeSaverError("bad-args", "参数 to 不能为空（YYYY-MM-DD）");
  if (from > to) throw new LifeSaverError("bad-args", `开始日期 ${from} 晚于结束日期 ${to}`);

  const kind = asEntityKind(args.kind);
  if (args.kind !== undefined && kind === undefined) {
    throw new LifeSaverError("bad-args", "参数 kind 只能是 story / task / bug");
  }
  const account =
    typeof args.account === "string" && args.account.trim() !== "" ? args.account.trim() : service.config().http.account;
  if (!account) {
    throw new LifeSaverError("bad-args", "没有指定 account，配置里也没有默认账号；请显式给一个禅道账号");
  }

  const report = await service.stats({ account, from, to, kind, signal: ctx.signal });
  const limit = clampLimit(args.limit, 30);
  const shown: WorklogReport =
    report.groups.length > limit
      ? {
          ...report,
          groups: report.groups.slice(0, limit),
          warnings: [...report.warnings, `共 ${report.groups.length} 个对象，这里只展示了前 ${limit} 个（用 limit 调大）。`],
        }
      : report;

  return {
    account: report.account,
    from: report.from,
    to: report.to,
    total: report.total,
    markdown: renderWorklogReport(shown, args.detail === true, report.groups.length),
  };
}

export function renderWorkhoursOutput(value: WorkhoursToolOutput): string {
  return wrapUntrusted(value.markdown ?? "");
}
