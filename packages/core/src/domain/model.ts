/**
 * 领域模型：禅道实体的**只读投影**。
 *
 * 这些类型是「通道无关」的：HTTP 通道从 HTML 里抽字段，DB 通道从 MySQL 抽字段，
 * 两条路必须产出同一个形状，渲染层才能只写一遍。
 *
 * 字段命名遵循禅道的概念（story/task/bug），不做「更优雅」的重命名——
 * 用户看到的就是禅道上的字，少一层翻译就少一层出错的机会。
 */

/** 一次内联图片的定位：哪个 file id、什么类型、多大。字节由通道按需取。 */
export interface InlineImage {
  readonly fileId: number;
  /** 文件表里记录的名字，用来推断 MIME 与在 markdown 里做 alt。 */
  readonly filename: string;
  /** 来自 `zt_file.size`，未知时缺省。 */
  readonly size?: number;
}

/** 任意禅道实体共有的外壳。 */
export interface EntityBase {
  readonly id: number;
  readonly title: string;
  readonly url?: string;
  /** 正文里的内联图片（按出现顺序，已去重）。 */
  readonly images: readonly InlineImage[];
  /**
   * 关键字段的**机器码**：状态枚举与账号。
   *
   * 展示用的 `status` / `assignedTo` 是给人和模型看的（HTTP 线是中文 `进行中`、
   * `张三`），但写操作的护栏必须拿禅道内部值比较（`doing`、`zhangsan`）。
   * 两条通道口径在这里对齐：DB 线本来就是机器码，可以不填；HTTP 线从页面的
   * `status-*` class 与用户表反查填进来。
   */
  readonly codes?: EntityCodes;
}

/** 机器码：只有需要跨通道比较的字段才放这里。 */
export interface EntityCodes {
  readonly status?: string;
  readonly assignedTo?: string;
  readonly openedBy?: string;
}

/** 备注/动作记录。DB 通道来自 zt_action，HTTP 通道来自详情页的备注块。 */
export interface Note {
  readonly date?: string;
  readonly who?: string;
  readonly action?: string;
  readonly comment: string;
}

/** 附件（zt_file 一行）。 */
export interface Attachment {
  readonly fileId: number;
  readonly filename: string;
  readonly size?: number;
  readonly addedBy?: string;
  readonly addedDate?: string;
  /** 是否为图片，决定能否作为 ContentBlock 回传。 */
  readonly isImage: boolean;
  /** 已下载的本地绝对路径；只有 requested 下载时才有。 */
  readonly localPath?: string;
}

/** 需求。 */
export interface Story extends EntityBase {
  readonly kind: 'story';
  /** 父需求 id（子需求场景）。 */
  readonly parent?: number;
  readonly status?: string;
  readonly stage?: string;
  readonly pri?: number;
  readonly estimate?: number;
  readonly productName?: string;
  readonly projectName?: string;
  readonly moduleName?: string;
  readonly openedBy?: string;
  readonly openedDate?: string;
  readonly assignedTo?: string;
  readonly spec: string;
  readonly notes: readonly Note[];
  readonly attachments: readonly Attachment[];
}

/** 任务。 */
export interface Task extends EntityBase {
  readonly kind: 'task';
  readonly status?: string;
  readonly pri?: number;
  readonly estimate?: number;
  readonly consumed?: number;
  readonly left?: number;
  readonly projectName?: string;
  readonly moduleName?: string;
  readonly assignedTo?: string;
  readonly openedBy?: string;
  readonly openedDate?: string;
  readonly finishedBy?: string;
  readonly finishedDate?: string;
  readonly deadline?: string;
  readonly storyId?: number;
  readonly storyTitle?: string;
  readonly desc: string;
  readonly notes: readonly Note[];
  readonly attachments: readonly Attachment[];
}

/** Bug。 */
export interface Bug extends EntityBase {
  readonly kind: 'bug';
  readonly status?: string;
  readonly pri?: number;
  readonly severity?: number;
  readonly type?: string;
  readonly productName?: string;
  readonly moduleName?: string;
  readonly projectName?: string;
  readonly assignedTo?: string;
  readonly openedBy?: string;
  readonly openedDate?: string;
  readonly resolvedBy?: string;
  readonly resolvedDate?: string;
  readonly resolution?: string;
  /** 是否确认：1 已确认、0 未确认。禅道页面上是「是否确认：已确认」。 */
  readonly confirmed?: number;
  readonly storyId?: number;
  readonly taskId?: number;
  readonly steps: string;
  readonly notes: readonly Note[];
  readonly attachments: readonly Attachment[];
}

export type Entity = Story | Task | Bug;

/**
 * 一条从哪里读来的通道标识。
 *
 * 它会出现在工具输出的 `source` 字段里，让模型（和人）知道自己看到的字段
 * 是「网页上抓的」还是「库里查的」——两者字段完整度不同。
 */
export type ChannelName = 'http' | 'db';

/** 通道选择策略：auto 先 db 失败降级 http。 */
export type ChannelMode = 'auto' | ChannelName;

/** 归一化的实体信封：通道必须报告自己是谁、以及是否做了降级。 */
export interface EntityEnvelope<T extends Entity = Entity> {
  readonly entity: T;
  readonly source: ChannelName;
  /**
   * 该通道无法提供的字段（例如 HTTP 通道拿不到 estimate），
   * 用于在输出里明确「未知」而不是伪装成空值。
   */
  readonly missing?: readonly string[];
}

/** 实体种类的判别式表。 */
export const ENTITY_KINDS = ['story', 'task', 'bug'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value);
}
