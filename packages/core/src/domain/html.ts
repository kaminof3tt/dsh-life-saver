/**
 * HTML → 纯文本 / Markdown。
 *
 * 禅道的富文本有两个来源：库里的 `zt_storyspec.spec`（HTML 片段）和 HTTP 页面里的
 * 文章块（同样 HTML）。两边都需要同一套规则，所以放在领域层，与通道无关。
 *
 * 设计取舍：
 *   - 不引第三方 HTML → Markdown 库。禅道的 HTML 结构很窄（br/p/li/img/table），
 *     手写规则的输出比通用库更可预测，也不会把样式噪音带进模型上下文。
 *   - 内联图片统一转成占位符 `@@file:<id>@@`，由渲染层决定落到 markdown 的哪个位置。
 *     通道只负责认出 file id，不负责决定排布。
 */

/** 禅道图片的两种内联写法里的 file id。 */
const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_FID = /\{\s*(\d+)\.\w+\s*\}|[?&](?:fileID|file)=(\d+)/;
/** 纯文本里裸露的 `{18269.png}` 占位（富文本被剥标签后残留）。 */
const BARE_IMG = /\{\s*(\d+)\.(\w+)\s*\}/g;
const TAG = /<[^>]+>/g;

const BLOCK_CLOSE = /<\/?(p|div|tr|li|h[1-6]|ul|ol|pre|blockquote|table|section|article)\b[^>]*>/gi;
const BR = /<br\s*\/?>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;

/** 表格单元格：禅道详情页用 <td>/<th> 排字段，转成 markdown 表格需要分隔符。 */
const CELL_CLOSE = /<\/(td|th)>/gi;

function unescapeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** HTML 转纯文本，保留段落换行；内联图片变成 `@@file:<id>@@` 占位。 */
export function htmlToText(input: string): string {
  if (!input) return "";
  let s = input;

  // 先处理图片，避免剥标签后丢失 file id。
  s = s.replace(IMG_TAG, (tag) => {
    const bare = unescapeEntities(tag);
    const hit = IMG_FID.exec(bare);
    if (!hit) return "";
    const id = hit[1] ?? hit[2];
    return id === undefined ? "" : `\n\n@@file:${id}@@\n\n`;
  });

  s = s.replace(BR, "\n");
  s = s.replace(CELL_CLOSE, " | ");
  s = s.replace(LIST_ITEM, "- ");
  s = s.replace(BLOCK_CLOSE, "\n");
  s = s.replace(TAG, "");
  s = unescapeEntities(s);

  // 剥标签后仍可能残留裸占位符 `{18269.png}`。
  s = s.replace(BARE_IMG, (_m, id: string) => `\n\n@@file:${id}@@\n\n`);

  return collapseBlankLines(s);
}

/** 收掉多余空白：行尾空格、三连换行、行首缩进噪音。 */
export function collapseBlankLines(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 把文本里的 `@@file:<id>@@` 占位交给回调替换。
 *
 * 回调返回 null 表示「这个 id 不该出现在这里」（附件不存在、不是图片），
 * 占位符被整个删掉而不是留下半个链接。
 */
export function replaceFilePlaceholders(text: string, resolve: (id: string) => string | null): string {
  return collapseBlankLines(
    text.replace(/@@file:(\d+)@@/g, (_match, id: string) => {
      const replacement = resolve(id);
      return replacement === null ? "" : replacement;
    }),
  );
}

/** 从一段 HTML 里按出现顺序收集 file id（去重）。 */
export function collectFileIds(html: string): string[] {
  const ids = new Set<string>();
  const text = htmlToText(html);
  for (const match of text.matchAll(/@@file:(\d+)@@/g)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** 把 markdown 里的一行表格单元格转义成不至于把表格撞坏的形式。 */
export function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
