/**
 * 库里的行 → 领域模型。
 *
 * 这一层只做两件事：把 zentao 的列名翻译成领域字段，把 HTML 正文收敛成纯文本
 * （内联图片留成 `@@file:<id>@@` 占位）。所有「取不到」的字段留 undefined，
 * 由通道在信封里报 missing，渲染层再显示成「不可用」。
 */

import { collectFileIds, htmlToText } from "../../domain/html.js";
import type {
  Attachment,
  Bug,
  InlineImage,
  Note,
  Story,
  Task,
} from "../../domain/model.js";
import type { ActionRow, BugRow, FileRow, StoryRow, StorySpecRow, TaskRow } from "./queries.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"]);

export function isImageFile(file: FileRow): boolean {
  return IMAGE_EXTENSIONS.has((file.extension ?? "").toLowerCase());
}

function fileExtension(file: Pick<FileRow, "extension" | "title">): string {
  if (file.extension) return file.extension;
  const name = file.title ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** 附件的展示名：库里的 title 可能为空，退回 `file-<id>.<ext>`。 */
export function fileName(file: FileRow): string {
  const ext = fileExtension(file);
  const base = (file.title ?? "").trim();
  if (!base) return ext ? `file-${file.id}.${ext}` : `file-${file.id}`;
  return base.includes(".") ? base : ext ? `${base}.${ext}` : base;
}

export function toAttachment(file: FileRow): Attachment {
  return {
    fileId: file.id,
    filename: fileName(file),
    size: file.size ?? undefined,
    addedBy: file.addedBy ?? undefined,
    addedDate: file.addedDate ?? undefined,
    isImage: isImageFile(file),
  };
}

/** 正文里出现、但不在附件列表里的内联图片：补一条只用于展示的记录。 */
export function inlineImagesFrom(bodyHtml: string, files: readonly FileRow[]): InlineImage[] {
  const known = new Map(files.map((file) => [String(file.id), file]));
  const out: InlineImage[] = [];
  for (const id of collectFileIds(bodyHtml)) {
    const file = known.get(id);
    if (!file) continue;
    out.push({ fileId: file.id, filename: fileName(file), size: file.size ?? undefined });
  }
  return out;
}

/** 备注/动作记录 → 领域 Note。comment 里的 HTML 也一并收敛。 */
export function toNotes(actions: readonly ActionRow[]): Note[] {
  return actions.map((action) => ({
    date: action.date ?? undefined,
    who: action.actor ?? undefined,
    action: action.action ?? undefined,
    comment: htmlToText(action.comment ?? ""),
  }));
}

export interface StoryInput {
  readonly row: StoryRow;
  readonly spec: StorySpecRow | undefined;
  readonly files: readonly FileRow[];
  readonly actions: readonly ActionRow[];
  readonly productName?: string;
  readonly projectName?: string;
  readonly moduleName?: string;
  readonly url?: string;
}

export function toStory(input: StoryInput): Story {
  const { row, spec } = input;
  const body = spec?.spec ?? "";
  return {
    kind: "story",
    id: row.id,
    title: spec?.title?.trim() || row.title?.trim() || `需求 #${row.id}`,
    url: input.url,
    images: inlineImagesFrom(body, input.files),
    parent: row.parent ?? undefined,
    status: row.status ?? undefined,
    stage: row.stage ?? undefined,
    pri: row.pri ?? undefined,
    estimate: row.estimate ?? undefined,
    productName: input.productName,
    projectName: input.projectName,
    moduleName: input.moduleName,
    openedBy: row.openedBy ?? undefined,
    openedDate: row.openedDate ?? undefined,
    assignedTo: row.assignedTo ?? undefined,
    spec: htmlToText(body),
    notes: toNotes(input.actions),
    attachments: input.files.map(toAttachment),
  };
}

export interface TaskInput {
  readonly row: TaskRow;
  readonly files: readonly FileRow[];
  readonly actions: readonly ActionRow[];
  readonly projectName?: string;
  readonly moduleName?: string;
  readonly storyTitle?: string;
  readonly url?: string;
}

export function toTask(input: TaskInput): Task {
  const { row } = input;
  const body = row.desc ?? "";
  return {
    kind: "task",
    id: row.id,
    title: row.name?.trim() || `任务 #${row.id}`,
    url: input.url,
    images: inlineImagesFrom(body, input.files),
    status: row.status ?? undefined,
    pri: row.pri ?? undefined,
    estimate: row.estimate ?? undefined,
    consumed: row.consumed ?? undefined,
    left: row.left ?? undefined,
    projectName: input.projectName,
    moduleName: input.moduleName,
    assignedTo: row.assignedTo ?? undefined,
    openedBy: row.openedBy ?? undefined,
    openedDate: row.openedDate ?? undefined,
    finishedBy: row.finishedBy ?? undefined,
    finishedDate: row.finishedDate ?? undefined,
    deadline: row.deadline ?? undefined,
    storyId: row.story ?? undefined,
    storyTitle: input.storyTitle,
    desc: htmlToText(body),
    notes: toNotes(input.actions),
    attachments: input.files.map(toAttachment),
  };
}

export interface BugInput {
  readonly row: BugRow;
  readonly files: readonly FileRow[];
  readonly actions: readonly ActionRow[];
  readonly productName?: string;
  readonly projectName?: string;
  readonly moduleName?: string;
  readonly url?: string;
}

export function toBug(input: BugInput): Bug {
  const { row } = input;
  const body = row.steps ?? "";
  return {
    kind: "bug",
    id: row.id,
    title: row.title?.trim() || `BUG #${row.id}`,
    url: input.url,
    images: inlineImagesFrom(body, input.files),
    status: row.status ?? undefined,
    pri: row.pri ?? undefined,
    severity: row.severity ?? undefined,
    type: row.type ?? undefined,
    productName: input.productName,
    moduleName: input.moduleName,
    projectName: input.projectName,
    assignedTo: row.assignedTo ?? undefined,
    openedBy: row.openedBy ?? undefined,
    openedDate: row.openedDate ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedDate: row.resolvedDate ?? undefined,
    resolution: row.resolution ?? undefined,
    confirmed: row.confirmed ?? undefined,
    storyId: row.story ?? undefined,
    taskId: row.task ?? undefined,
    steps: htmlToText(body),
    notes: toNotes(input.actions),
    attachments: input.files.map(toAttachment),
  };
}
