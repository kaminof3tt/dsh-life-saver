/**
 * 通道契约。
 *
 * 抽象的是**能力**而不是实现：上层只问 `source.caps` 能不能干某件事，
 * 不去判断"这是 db 还是 http"。这样加第三个通道（比如 REST API）时
 * 上层一行都不用改。
 */

import type { EntityEnvelope, EntityKind, Note } from "../domain/model.js";
import type { DiscoveryReport } from "../domain/discovery.js";
import type { WorklogQuery, WorklogReport } from "./stats.js";
import type { WriteAction, WriteOutcome, WriteRequest } from "./write.js";

/** 通道自报的能力；上层据此决定降级与提示文案。 */
export interface ChannelCaps {
  /** 按 id 取单个实体。 */
  readonly read: boolean;
  /** 关键词搜索。 */
  readonly search: boolean;
  /** 能取到附件实体字节（否则只能列清单）。 */
  readonly attachments: boolean;
  /** 能取到备注/操作记录。 */
  readonly notes: boolean;
  /** 能取到工时等扩展字段。 */
  readonly estimates: boolean;
  /** 能改禅道里的数据（完成任务、解决 BUG 等）。 */
  readonly write: boolean;
  /** 能按人按区间统计工时。 */
  readonly stats: boolean;
}

/** 写动作是否属于该实体类型。 */
export function supportsWrite(kind: "task" | "bug", action: WriteAction): boolean {
  if (action === "comment") return true;
  if (kind === "task") {
    return action === "start" || action === "recordworkhour" || action === "finish" || action === "pause" || action === "activate" || action === "close" || action === "cancel";
  }
  return (
    action === "confirm" || action === "resolve" || action === "close" || action === "recordworkhour"
  );
}

/** 取一条实体的请求。 */
export interface ReadRequest {
  readonly kind: EntityKind;
  readonly id: number;
  /** 是否尝试下载附件实体。 */
  readonly withAttachments: boolean;
  /** 附件落盘目录（绝对路径）；不给则只在内存里拿清单。 */
  readonly attachmentDir?: string;
  readonly maxAttachments: number;
  readonly maxAttachmentBytes: number;
  /** 取消信号，所有 IO 必须转发。 */
  readonly signal?: AbortSignal;
}

/** 搜索结果条目。 */
export interface SearchHit {
  readonly kind: EntityKind;
  readonly id: number;
  readonly title: string;
  readonly status?: string;
  readonly assignedTo?: string;
}

export interface SearchRequest {
  readonly query: string;
  /** 不填则三类都搜。 */
  readonly kind?: EntityKind;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** 通道实现。所有方法失败时抛 `ChannelError`，由 service 决定降级还是上报。 */
export interface Channel {
  readonly name: "db" | "http";
  readonly caps: ChannelCaps;
  /** 探活：能连上、能查询、能在 1~2 秒内给结论。 */
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  read(request: ReadRequest): Promise<EntityEnvelope>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  /** 执行一个写动作。`caps.write` 为 false 的通道不实现这个方法。 */
  write?(request: WriteRequest): Promise<WriteOutcome>;
  /** 按人按区间统计工时。`caps.stats` 为 false 的通道不实现这个方法。 */
  stats?(query: WorklogQuery): Promise<WorklogReport>;
  /**
   * 探测本通道依赖的结构差异（库列/表、页面皮肤、登录算法）。
   * 探测失败只进 `warnings`，不抛——读路径不能因为「探不到」而中断。
   */
  discover?(options?: { readonly refresh?: boolean; readonly signal?: AbortSignal }): Promise<DiscoveryReport>;
  /** 释放连接池/会话。 */
  dispose(): Promise<void>;
}

export interface ProbeResult {
  readonly ok: boolean;
  /** 失败原因（给人看，不含机密）。 */
  readonly error?: string;
  /** 附加信息，例如登录后的用户名、库版本。 */
  readonly detail?: string;
}

/** 通道错误：带上通道名与一个稳定的 code，便于上层拼提示。 */
export class ChannelError extends Error {
  public readonly channel: "db" | "http";
  public readonly code: string;

  public constructor(channel: "db" | "http", code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChannelError";
    this.channel = channel;
    this.code = code;
  }
}

/** 备注归一化的共用小工具：丢掉纯空白与纯占位。 */
export function normalizeNotes(notes: ReadonlyArray<Partial<Note>>): Note[] {
  const out: Note[] = [];
  for (const note of notes) {
    const comment = (note.comment ?? "").trim();
    if (!comment) continue;
    out.push({
      date: note.date?.trim() || undefined,
      who: note.who?.trim() || undefined,
      action: note.action?.trim() || undefined,
      comment,
    });
  }
  return out;
}
