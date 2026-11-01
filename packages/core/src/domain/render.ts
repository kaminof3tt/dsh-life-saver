/**
 * 领域模型 → Markdown。
 *
 * 渲染层只认识 domain/model.ts 里的类型，不认识 mysql2、不认识 fetch。
 * 通道若拿不到某个字段，就把字段名放进 `missing`，这里统一渲染成「—（不可用）」
 * 而不是伪装成空值——模型据此知道"这条信息不存在"还是"这条信息没取到"。
 */

import type { Attachment, Entity, EntityEnvelope, Note } from "./model.js";
import { cell, replaceFilePlaceholders } from "./html.js";

/** `missing` 里的字段名与中文标签的对应，只用于渲染提示。 */
const FIELD_LABELS: Record<string, string> = {
  'http.base_url': 'HTTP 地址',
  'story.estimate': '预计工时',
  'story.stage': '阶段',
  'story.productName': '产品名',
  'story.moduleName': '模块名',
  'task.estimate': '预计工时',
  'task.consumed': '已消耗',
  'task.left': '剩余',
  'task.projectName': '项目名',
  'bug.productName': '产品名',
  'bug.moduleName': '模块名',
  'bug.projectName': '项目名',
};

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)}${units[i]}`;
}

/** 一行值：undefined/null/空串 → 空（调用方决定是否整行省略）。 */
function value(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * 字段表；只输出有值的行。
 *
 * **0 要保留**：剩余工时 0 就是「做完了」、已消耗 0 与「字段缺失」是两回事，
 * 这些行曾经被当成空值整行删掉，于是「这个任务还剩几小时」在渲染结果里直接消失。
 */
function fieldTable(rows: ReadonlyArray<readonly [string, unknown]>): string {
  const lines = ["| 字段 | 值 |", "|---|---|"];
  for (const [label, raw] of rows) {
    const text = value(raw);
    if (text === "") continue;
    lines.push(`| ${cell(label)} | ${cell(text)} |`);
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function missingNote(env: EntityEnvelope): string {
  const names = (env.missing ?? []).map((dotted) => FIELD_LABELS[dotted] ?? dotted);
  if (names.length === 0) return "";
  return `\n> 该通道无法提供：${names.join("、")}\n`;
}

function noteLines(notes: readonly Note[]): string {
  if (notes.length === 0) return "_无_";
  const out: string[] = [];
  for (const note of notes) {
    const head = [note.date, note.action ? `\`${note.action}\`` : "", note.who ? `· ${note.who}` : ""]
      .filter(Boolean)
      .join(" ");
    out.push(head ? `- ${head}` : "-");
    if (note.comment.trim()) {
      for (const line of note.comment.trim().split("\n")) {
        out.push(line.trim() ? `  > ${line}` : "  >");
      }
    }
  }
  return out.join("\n");
}

/** 类型列：文件名带后缀就用后缀；页面内嵌图本来就没有文件名，靠 isImage 兜底。 */
function attachmentType(att: Attachment): string {
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(att.filename)?.[0].slice(1).toLowerCase();
  if (ext && !/^file-\d+$/.test(att.filename)) return ext;
  return att.isImage ? "图片" : "—";
}

function attachmentTable(attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return "_无附件_";
  const lines = ["| id | 文件名 | 类型 | 大小 | 上传人 | 时间 | 本地路径 |", "|---|---|---|---|---|---|---|"];
  for (const att of attachments) {
    lines.push(
      `| ${att.fileId} | ${cell(att.filename)} | ${cell(attachmentType(att))} | ${cell(formatSize(att.size))} | ${cell(att.addedBy ?? "")} | ${cell(att.addedDate ?? "")} | ${att.localPath ? `\`${att.localPath}\`` : "—（未下载）"} |`,
    );
  }
  return lines.join("\n");
}

/** 已落盘的图片，插到正文占位符位置。 */
function imageBlock(attachments: readonly Attachment[], skip: ReadonlySet<number> = new Set()): string {
  const imgs = attachments.filter((a) => a.isImage && a.localPath && !skip.has(a.fileId));
  if (imgs.length === 0) return "";
  return imgs.map((a) => `![${a.filename}#${a.fileId}](${a.localPath})`).join("\n\n");
}

/** 正文里 @@file:NN@@ 引用过的附件 id，这些图在正文处已经渲染。 */
function inlinedFileIds(body: string): Set<number> {
  const ids = new Set<number>();
  for (const match of body.matchAll(/@@file:(\d+)@@/g)) ids.add(Number(match[1]));
  return ids;
}

/** 把正文里的 `@@file:ID@@` 换成 markdown 图片或附件链接。 */
function inlineBody(body: string, attachments: readonly Attachment[]): string {
  const byId = new Map(attachments.map((a) => [String(a.fileId), a]));
  const text = replaceFilePlaceholders(body, (id) => {
    const att = byId.get(id);
    // 附件表里没这条：保留一个可检索的锚点，别让正文凭空少一截。
    if (!att) return `📎 #${id}`;
    // 知道是什么文件但没下载：正文里点明"这里引用了什么"，比删掉更有用。
    if (!att.localPath) return `📎 ${att.filename} (#${att.fileId}，未下载)`;
    return att.isImage
      ? `![${att.filename}#${att.fileId}](${att.localPath})`
      : `[附件 #${att.fileId} ${att.filename}](${att.localPath})`;
  });
  return text.trim() || "_（空）_";
}

function storyTitle(entity: Entity): string {
  return `# 研发需求 #${entity.id}`;
}

function storyFields(entity: Extract<Entity, { kind: "story" }>): string {
  return fieldTable([
    ["标题", entity.title],
    ["状态", entity.status],
    ["阶段", entity.stage],
    ["优先级", entity.pri],
    ["预计工时", entity.estimate],
    ["产品", entity.productName],
    ["模块", entity.moduleName],
    ["项目", entity.projectName],
    ["父需求", entity.parent],
    ["创建者", entity.openedBy],
    ["创建时间", entity.openedDate],
    ["指派给", entity.assignedTo],
    ["链接", entity.url],
  ]);
}

function taskFields(entity: Extract<Entity, { kind: "task" }>): string {
  return fieldTable([
    ["标题", entity.title],
    ["状态", entity.status],
    ["优先级", entity.pri],
    ["预计工时", entity.estimate],
    ["已消耗", entity.consumed],
    ["剩余", entity.left],
    ["项目", entity.projectName],
    ["模块", entity.moduleName],
    ["关联需求", entity.storyId ? `#${entity.storyId} ${entity.storyTitle ?? ""}` : undefined],
    ["创建者", entity.openedBy],
    ["创建时间", entity.openedDate],
    ["指派给", entity.assignedTo],
    ["完成者", entity.finishedBy],
    ["完成时间", entity.finishedDate],
    ["截止", entity.deadline],
    ["链接", entity.url],
  ]);
}

function bugFields(entity: Extract<Entity, { kind: "bug" }>): string {
  return fieldTable([
    ["标题", entity.title],
    ["状态", entity.status],
    ["严重程度", entity.severity],
    ["优先级", entity.pri],
    ["类型", entity.type],
    ["产品", entity.productName],
    ["模块", entity.moduleName],
    ["项目", entity.projectName],
    ["关联需求", entity.storyId ? `#${entity.storyId}` : undefined],
    ["关联任务", entity.taskId ? `#${entity.taskId}` : undefined],
    ["创建者", entity.openedBy],
    ["创建时间", entity.openedDate],
    ["指派给", entity.assignedTo],
    ["是否确认", entity.confirmed === undefined ? undefined : entity.confirmed === 1 ? "已确认" : "未确认"],
    ["解决者", entity.resolvedBy],
    ["解决方案", entity.resolution],
    ["解决时间", entity.resolvedDate],
    ["链接", entity.url],
  ]);
}

/** 正文块自己的小标题：HTTP 通道按页面分块取正文，文本里已带「## 重现步骤」，别再套一层。 */
const BODY_HEADINGS = ["重现步骤", "需求描述", "任务描述", "描述", "需求正文", "详情"];

function stripLeadingHeading(text: string): string {
  const match = /^#{1,3}\s*([^\n]{1,20})\n+/.exec(text);
  if (!match) return text;
  const label = (match[1] ?? "").trim();
  return BODY_HEADINGS.includes(label) ? text.slice(match[0].length) : text;
}

/**
 * 渲染一个实体为完整 markdown。
 *
 * `scope`：full=正文+备注+附件；brief=只到字段与正文，备注/附件只给数量。
 */
export function renderEntity(env: EntityEnvelope, scope: "brief" | "full" = "full"): string {
  const e = env.entity;
  const body = "spec" in e ? e.spec : "desc" in e ? e.desc : e.steps;
  const bodyLabel = e.kind === "story" ? "需求正文" : e.kind === "task" ? "任务描述" : "重现步骤";
  const parts: string[] = [];

  parts.push(e.kind === "story" ? storyTitle(e) : e.kind === "task" ? `# 任务 #${e.id}` : `# BUG #${e.id}`);
  parts.push(`> 数据源：**${env.source === "db" ? "只读库 + SFTP" : "HTTP 页面（登录 cookie）"}**`);
  if (env.missing && env.missing.length > 0) parts.push(missingNote(env).trim());

  const table = e.kind === "story" ? storyFields(e) : e.kind === "task" ? taskFields(e) : bugFields(e);
  if (table) parts.push(table);

  parts.push(`## ${bodyLabel}`);
  parts.push(inlineBody(stripLeadingHeading(body), e.attachments));

  if (scope === "brief") {
    parts.push(`## 备注与附件`);
    parts.push(`本次为 brief 模式：${e.notes.length} 条备注、${e.attachments.length} 个附件未展开。`);
    return parts.join("\n\n");
  }

  parts.push(`## 操作记录 / 备注（${e.notes.length} 条）`);
  parts.push(noteLines(e.notes));

  parts.push(`## 附件（${e.attachments.length} 个）`);
  parts.push(attachmentTable(e.attachments));
  // 正文里已经用 @@file:NN@@ 内联过的图不再重复贴一遍，避免同一张图出现两次。
  const images = imageBlock(e.attachments, inlinedFileIds(body));
  if (images) parts.push(images);

  return parts.join("\n\n");
}

/** 关联对象：只给摘要与标题，正文由上层决定是否递归。 */
export function renderRelatedBanner(title: string, summary: string): string {
  return `## ${title}\n\n${summary}`;
}

/** 关联列表（子任务之类）。 */
export function renderRelatedList(
  title: string,
  items: ReadonlyArray<{ kind: string; id: number; title: string; status?: string; assignedTo?: string }>,
): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) =>
      `- ${item.kind}#${item.id} ${item.title}${item.status ? ` [${item.status}]` : ""}${item.assignedTo ? ` ${item.assignedTo}` : ""}`,
  );
  return `## ${title}\n\n${lines.join("\n")}`;
}
