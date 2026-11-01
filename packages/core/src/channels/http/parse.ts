/**
 * 禅道详情页 → 领域模型需要的原料。
 *
 * 这一层是**纯函数**：给 HTML 字符串，吐标题/字段表/正文/备注/附件/内联图片。
 * 不发请求、不碰磁盘，方便拿真实页面离线冻成 fixture 做回归。
 *
 * 两种页面形态都要吃：
 *   1. `zin=1` 的 JSON —— 禅道把页面拆成 [{name:"title"|"main", data:"<html>"}]，
 *      拿到的是片段，结构最干净，优先走它；
 *   2. 整页 HTML —— JSON 拿不到时退回，用 `#mainContent` / `.detail-view` 收窄。
 */

import { parse, type HTMLElement } from "node-html-parser";

import type { HttpSkin } from "../../domain/discovery.js";
import { collectFileIds, htmlToText } from "../../domain/html.js";
import type { Attachment, InlineImage, Note } from "../../domain/model.js";
import { normalizeNotes } from "../types.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"]);

/** zin=1 返回的一行。 */
interface ZinItem {
  readonly name?: string;
  readonly data?: string;
}

/** 一张页面拆出来的原料。 */
export interface ParsedPage {
  readonly title: string;
  /** 字段表格：标签 → 值（标签已去掉尾部冒号）。 */
  readonly fields: Readonly<Record<string, string>>;
  /**
   * 字段的**机器码**：标签 → 禅道内部的枚举值。
   *
   * 页面上显示的是中文（`进行中`、`已解决`），但写操作的护栏要拿它跟库里的
   * `doing` / `resolved` 比；靠中文反查既不全也容易随版本漂移。真实页面把机器码
   * 放在语义 class 里（`<span class="status-doing">进行中</span>`），这里只从
   * `.datalist-item-content` 内部取——页面里还内联了一大段 `.label.status-doing{}`
   * 的样式表，全局搜 class 会先命中 CSS。
   */
  readonly states: Readonly<Record<string, string>>;
  /** 正文里各个 `.detail` 块：标题 + 纯文本（内联图片留 `@@file:<id>@@`）。 */
  readonly sections: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  readonly notes: readonly Note[];
  readonly attachments: readonly Attachment[];
  readonly images: readonly InlineImage[];
  /**
   * 这一页最终命中的是**哪一套皮肤**（正文块的 DOM 结构）。
   *
   * 为什么要把这个报出去：三套选择器是按新旧顺序硬试的，试错不会报错——
   * 页面换皮肤时最可能的结果不是「读不到」而是「读到一个空/错的正文」。
   * 把「这次是靠哪套选择器读到的」记下来，`zentao_status` 就能告诉用户
   * 这套部署的真实皮肤，换机器/升级后也能立刻看出漂移。
   */
  readonly skin?: HttpSkin;
  /** 原 HTML 长度：正文全空时用来判断「页面是不是根本没返回内容」。 */
  readonly htmlLength: number;
}

/** zin=1 的响应体 → 片段；不是数组或没有 main 时返回 undefined，调用方退回整页解析。 */
export function parseZinPayload(body: string): { title: string; mainHtml: string } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  let title = "";
  let mainHtml = "";
  for (const item of data as ZinItem[]) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name : "";
    const value = typeof item.data === "string" ? item.data : "";
    if (name === "title") title = value;
    else if (name === "main") mainHtml = value;
  }
  return mainHtml ? { title, mainHtml } : undefined;
}

/** 整页 HTML → 收窄到内容根；找不到就退回整个文档。 */
function rootOf(html: string): HTMLElement {
  const doc = parse(html);
  return (
    doc.querySelector("[zui-key='body']") ??
    doc.querySelector("#mainContent") ??
    doc.querySelector(".detail-view") ??
    doc
  );
}

function text(element: HTMLElement | null | undefined): string {
  return element?.text?.replace(/\s+/g, " ").trim() ?? "";
}

function stripColon(label: string): string {
  return label.replace(/[：:]\s*$/, "").trim();
}

/**
 * 字段格子的文本。模块/产品这类格子是面包屑（`ol.breadcrumb` → 若干个 `li`），
 * 直接取文本会连成一串（「【G 端】物业管理物业管理区域」），所以只留最后一段——
 * 最具体的那级，和数据库里的 module 名对得上。
 */
function fieldValue(content: HTMLElement | null): string {
  if (!content) return "";
  const crumbs = content.querySelectorAll("ol.breadcrumb li");
  if (crumbs.length > 0) return text(crumbs[crumbs.length - 1]).trim();
  return text(content);
}

/** `.datalist-item` → 字段表。禅道的详情页把「标题：值」排成两列。 */
function parseFields(root: HTMLElement): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const item of root.querySelectorAll(".datalist-item")) {
    const label = stripColon(text(item.querySelector(".datalist-item-label")));
    const value = fieldValue(item.querySelector(".datalist-item-content"));
    if (label && value) fields[label] = value;
  }
  return fields;
}

/**
 * `.datalist-item` → 状态机器码。
 *
 * 页面把枚举值写成语义 class：`<span class="status-doing">进行中</span>`、
 * `<span class="status-resolved">已解决</span>`。这些后缀与 `zt_task.status` /
 * `zt_bug.status` 的取值完全一致，是护栏唯一可靠的口径——中文名会随语言包变。
 *
 * 只在 `.datalist-item-content` 里找：页面开头内联了 `.label.status-doing{…}` 这类
 * 样式表，全局找 class 会先命中 CSS 而不是数据格子。
 */
function parseStates(root: HTMLElement): Record<string, string> {
  const states: Record<string, string> = {};
  for (const item of root.querySelectorAll(".datalist-item")) {
    const label = stripColon(text(item.querySelector(".datalist-item-label")));
    const content = item.querySelector(".datalist-item-content");
    if (!label || !content) continue;
    for (const node of content.querySelectorAll("*")) {
      const classList = (node.getAttribute("class") ?? "").split(/\s+/);
      const hit = classList.map((token) => /^status-([A-Za-z][A-Za-z0-9_]*)$/.exec(token)).find(Boolean);
      const code = hit?.[1];
      if (code) {
        states[label] = code;
        break;
      }
    }
  }
  return states;
}

/** 往上找祖先，看有没有哪个祖先带指定的 `zui-key`。 */
function hasAncestorKey(element: HTMLElement, keys: readonly string[]): boolean {
  let node: HTMLElement | null = element.parentNode as HTMLElement | null;
  while (node) {
    const key = node.getAttribute?.("zui-key");
    if (key && keys.includes(key)) return true;
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

/**
 * 正文块。禅道把每段包成 `.detail` → `.detail-title` + `.detail-content`；
 * 老版本只有裸 `.article`，那就只能按出现顺序收，标题留空。
 */
function parseSections(
  root: HTMLElement,
  preferred?: HttpSkin,
): { sections: Array<{ label: string; text: string }>; skin?: HttpSkin } {
  const out: Array<{ label: string; text: string }> = [];

  // 新皮肤（15+ / biz）：一组 `.detail-section`，
  // 标题在 `.detail-section-title`、正文在 `.detail-section-content`。
  // 「相关需求 / 侧栏」那些旁支块不算正文，直接跳过。
  const detailSection = (): boolean => {
    for (const section of root.querySelectorAll(".detail-section")) {
      if (hasAncestorKey(section, ["related", "side"])) continue;
      const label = stripColon(text(section.querySelector(".detail-section-title")));
      const content = section.querySelector(".detail-section-content") ?? section;
      const bodyText = htmlToText(content.innerHTML);
      if (bodyText) out.push({ label, text: bodyText });
    }
    return out.length > 0;
  };

  // 老皮肤：`.detail` → `.detail-title` + `.detail-content`。
  const detail = (): boolean => {
    for (const block of root.querySelectorAll(".detail")) {
      const label = stripColon(text(block.querySelector(".detail-title")));
      const body = block.querySelector(".detail-content");
      const bodyText = body ? htmlToText(body.innerHTML) : "";
      if (!bodyText) continue;
      out.push({ label, text: bodyText });
    }
    return out.length > 0;
  };

  // 最老的一档：只有裸 `.article`，标题留空。
  const article = (): boolean => {
    for (const item of root.querySelectorAll(".article")) {
      const bodyText = htmlToText(item.innerHTML);
      if (bodyText) out.push({ label: "", text: bodyText });
    }
    return out.length > 0;
  };

  // 默认按「新 → 老」试；用户显式配了 http.skin 就把那档提到最前，
  // 这样某套部署的选择器互相串味时（比如新版页面里也有 `.article`）
  // 能手工钉死，而不是只能忍受误判。
  const order: Array<{ skin: HttpSkin; collect: () => boolean }> = [
    { skin: "detail-section", collect: detailSection },
    { skin: "detail", collect: detail },
    { skin: "article", collect: article },
  ];
  const ordered = preferred
    ? [...order].sort((a, b) => Number(b.skin === preferred) - Number(a.skin === preferred))
    : order;
  for (const strategy of ordered) {
    out.length = 0;
    if (strategy.collect()) return { sections: out, skin: strategy.skin };
  }
  return { sections: out, skin: undefined };
}

/**
 * 从属性值里抠出 `actions` 数组。
 *
 * 这个属性的值**不是严格 JSON**：后面还挂着 `fileActions:function(file){...}` 这种
 * 函数字面量，整体 `JSON.parse` 必挂（报 `Unexpected token 'u'`）。
 * 所以先按方括号配对切出数组本身，再只解析这一段。
 */
function sliceArrayAfter(raw: string, key: string): string | undefined {
  const keyIndex = raw.indexOf(`"${key}"`);
  if (keyIndex < 0) return undefined;
  const start = raw.indexOf("[", keyIndex);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return undefined;
}

function readActions(raw: string): Array<Record<string, unknown>> {
  const direct = ((): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  })();
  const candidate =
    (direct as { actions?: unknown } | undefined)?.actions ??
    ((): unknown => {
      const slice = sliceArrayAfter(raw, "actions");
      if (!slice) return undefined;
      try {
        return JSON.parse(slice);
      } catch {
        return undefined;
      }
    })();
  return Array.isArray(candidate) ? (candidate as Array<Record<string, unknown>>) : [];
}

/** `<strong>赵六</strong>` → `赵六`。 */
function strongName(content: string): string | undefined {
  const match = /<strong>([\s\S]{1,40}?)<\/strong>/i.exec(content);
  return match ? htmlToText(match[1] ?? "").trim() || undefined : undefined;
}

/** `2026-10-30 17:13:53, 由 ...` → `2026-10-30 17:13:53`。 */
function leadingDate(content: string): string | undefined {
  return /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(content)?.[1];
}

/** 历史面板里塞的 JSON：`zui-create-historypanel='{"actions":[{content,comment,...}]}'`。 */
function parseHistoryPanels(root: HTMLElement): Note[] {
  const notes: Note[] = [];
  for (const element of root.querySelectorAll("[zui-create-historypanel]")) {
    const raw = element.getAttribute("zui-create-historypanel");
    if (!raw) continue;
    for (const action of readActions(raw)) {
      const commentRaw = htmlToText(String(action.comment ?? ""));
      const contentRaw = htmlToText(String(action.content ?? ""));
      const who =
        (typeof action.actor === "string" && action.actor.trim()) ||
        strongName(String(action.content ?? "")) ||
        undefined;
      const date =
        (typeof action.date === "string" && action.date.trim()) || leadingDate(String(action.content ?? "")) || undefined;
      // 系统动作只有 content（「2026-10-30 17:13:53, 由 赵六 创建。」），
      // 把时间和人名剥掉，只留动作本身，避免和 date/who 重复。
      let fallback = contentRaw.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*,\s*/, "");
      if (who) fallback = fallback.replace(new RegExp(`^由\\s*${who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "");
      const comment = commentRaw || fallback;
      if (!comment) continue;
      notes.push({
        date,
        who,
        action: typeof action.action === "string" ? action.action : undefined,
        comment,
      });
    }
  }
  return notes;
}

/** 备注的 DOM 兜底：没有历史面板时，页面里还有 `.comment-content` / `.history-panel-action`。 */
function parseCommentBlocks(root: HTMLElement): Note[] {
  const notes: Note[] = [];
  for (const block of root.querySelectorAll(".comment-content, .history-panel-action")) {
    const comment = htmlToText(block.innerHTML);
    if (!comment) continue;
    notes.push({ comment });
  }
  return notes;
}

/** `(12.5 KB)` 这类取自附件链接文本的尺寸。 */
export function parseSizeLabel(label: string): number | undefined {
  const match = /\(([\d.]+)\s*([KMGT]?)B\)/i.exec(label);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? "").toUpperCase();
  const scale = unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : unit === "G" ? 1024 ** 3 : unit === "T" ? 1024 ** 4 : 1;
  return Math.round(value * scale);
}

/** 附件链接文本去掉尾部 `(12.5 KB)`，剩下的就是文件名。 */
function cleanFileName(label: string): string {
  return label.replace(/\s*\([\d.]+\s*[KMGT]?B\)\s*$/i, "").trim();
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** `?m=file&f=download&fileID=42` / `?m=file&f=read&fileID=43` 里的 file id。 */
function fileIdOf(url: string): number | undefined {
  const match = /[?&]fileID=(\d+)/i.exec(url);
  if (!match) return undefined;
  const id = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(id) ? id : undefined;
}

function isFileUrl(url: string): boolean {
  return /fileID=\d+/i.test(url) && /m=file/i.test(url);
}

/** 页面里的附件链接 → 附件清单（只到元信息，字节由通道按需取）。 */
function parseAttachments(root: HTMLElement): Attachment[] {
  const seen = new Set<number>();
  const out: Attachment[] = [];
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!/m=file/i.test(href) || !/f=download/i.test(href)) continue;
    const fileId = fileIdOf(href);
    if (fileId === undefined || seen.has(fileId)) continue;
    seen.add(fileId);
    const label = text(anchor);
    const filename = cleanFileName(label) || `file-${fileId}`;
    out.push({
      fileId,
      filename,
      size: parseSizeLabel(label),
      isImage: IMAGE_EXTENSIONS.has(extensionOf(filename)),
    });
  }
  return out;
}

/**
 * 内联图片。
 *
 * 两条来源要合起来：正文 HTML 里的 `<img src=...fileID=43...>`（`htmlToText` 已经
 * 把它转成 `@@file:43@@` 占位），以及历史面板 JSON 里夹带的 fileID。
 * 同 id 只留一次，顺序按正文出现顺序。
 */
function parseImages(
  root: HTMLElement,
  sections: ReadonlyArray<{ label: string; text: string }>,
  attachments: readonly Attachment[],
): InlineImage[] {
  const order: number[] = [];
  const push = (id: number): void => {
    if (!order.includes(id)) order.push(id);
  };

  for (const section of sections) {
    for (const raw of collectFileIds(section.text)) {
      const id = Number.parseInt(raw, 10);
      if (Number.isFinite(id)) push(id);
    }
  }
  for (const element of root.querySelectorAll("[zui-create-historypanel]")) {
    const raw = element.getAttribute("zui-create-historypanel") ?? "";
    for (const match of raw.matchAll(/fileID=(\d+)/gi)) {
      const id = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(id)) push(id);
    }
  }
  for (const img of root.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src") ?? "";
    if (!isFileUrl(src)) continue;
    const id = fileIdOf(src);
    if (id !== undefined) push(id);
  }

  const known = new Map(attachments.map((file) => [file.fileId, file]));
  return order.map((fileId) => {
    const file = known.get(fileId);
    return {
      fileId,
      filename: file?.filename ?? `file-${fileId}`,
      size: file?.size,
    };
  });
}

/**
 * 页面标题。三种来源按可信度排：
 *   1. zin=1 给的 title 片段（最干净）；
 *   2. 新皮肤的 `.entity-title-text[title]`——整页模式没有 `<title>`，全靠它；
 *   3. 老皮肤的 `<title>禅道 - ...`。
 */
function pageTitle(html: string, zinTitle?: string): string {
  if (zinTitle) {
    const fromZin = htmlToText(zinTitle).replace(/\s+/g, " ").trim();
    if (fromZin) return fromZin;
  }
  const doc = parse(html);
  const entityTitle = doc.querySelector(".entity-title-text");
  const attrTitle = entityTitle?.getAttribute("title")?.trim();
  if (attrTitle) return attrTitle;
  const entityText = text(entityTitle);
  if (entityText) return entityText;
  const titleText = text(doc.querySelector("title"));
  return titleText.replace(/\s*[-–—]\s*禅道.*$/, "").trim();
}

/** 整页 HTML（或 zin 片段 + 标题）→ ParsedPage。 */
export function parsePage(html: string, options?: { zinTitle?: string; skin?: HttpSkin }): ParsedPage {
  const root = rootOf(html);
  const fields = parseFields(root);
  const parsed = parseSections(root, options?.skin);
  const attachments = parseAttachments(root);
  const notes = normalizeNotes([...parseHistoryPanels(root), ...parseCommentBlocks(root)]);
  return {
    title: pageTitle(html, options?.zinTitle),
    fields,
    states: parseStates(root),
    sections: parsed.sections,
    notes,
    attachments,
    images: parseImages(root, parsed.sections, attachments),
    skin: parsed.skin,
    htmlLength: html.length,
  };
}
