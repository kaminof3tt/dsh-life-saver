/** zentao_search 的执行与渲染。命中只给编号/标题/状态/指派人。 */

import type { ChannelName, EntityKind } from "../domain/model.js";
import { LifeSaverError, type LifeSaverService } from "../service.js";
import { asEntityKind, clampLimit, compact, degradedText, sourceLabel, wrapUntrusted } from "../tools/shared.js";
import type { ToolRunContext } from "./context.js";

export interface SearchToolOutput {
  query: string;
  source: ChannelName;
  degraded?: string;
  hits: { kind: EntityKind; id: number; title: string; status?: string; assignedTo?: string }[];
}

export async function runSearchTool(
  service: LifeSaverService,
  rawArgs: unknown,
  ctx: ToolRunContext,
): Promise<SearchToolOutput> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new LifeSaverError("bad-args", "参数 query 不能为空");
  const kind = asEntityKind(args.kind);
  if (args.kind !== undefined && kind === undefined) {
    throw new LifeSaverError("bad-args", "参数 kind 只能是 story / task / bug");
  }
  const limit = clampLimit(args.limit, 10);

  const outcome = await service.search(query, kind, limit, ctx.signal);

  return compact({
    query,
    source: outcome.source,
    degraded: degradedText(outcome.degraded) || undefined,
    hits: outcome.hits.slice(0, limit).map((hit) =>
      compact({
        kind: hit.kind,
        id: hit.id,
        title: hit.title,
        status: hit.status || undefined,
        assignedTo: hit.assignedTo || undefined,
      }),
    ),
  });
}

export function renderSearchOutput(value: SearchToolOutput): string {
  const head = value.degraded ? `> ⚠️ ${value.degraded}\n\n` : "";
  const hits = value.hits ?? [];
  if (hits.length === 0) {
    return `${head}没有命中「${value.query ?? ""}」。换个关键词，或用 zentao_read 直接读已知编号。`;
  }
  const rows = hits.map((hit) => {
    const meta = [hit.status, hit.assignedTo].filter(Boolean).join(" · ");
    return `- ${hit.kind} #${hit.id} ${hit.title ?? ""}${meta ? `（${meta}）` : ""}`;
  });
  const text = [
    head,
    `在 ${sourceLabel(value.source)} 通道命中 ${hits.length} 条（关键词「${value.query ?? ""}」）：`,
    ...rows,
    "",
    "取正文：调用 zentao_read，kind 与 id 取上面的值。",
  ].join("\n");
  return wrapUntrusted(text);
}
