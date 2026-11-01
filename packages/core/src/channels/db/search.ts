/**
 * 搜索索引的复刻（`zt_searchindex` + `zt_searchdict`）。
 *
 * HTTP 线里索引是禅道自己刷的：`action::create()` 末尾会调 `saveIndex()`。
 * DB 线必须自己写，否则「改了备注但搜索搜不到」——这是与 HTTP 线的可见差异。
 *
 * 依据（tag zentaopms_16.2）：
 *   module/action/model.php::saveIndex()   决定「这次动作要不要重建」
 *   module/search/model.php::saveIndex()    决定「重建出来长什么样」
 *   lib/spliter/spliter.class.php::utf8Split()  决定「中文怎么变成码点串」
 *
 * 这里的 `utf8Split()` 是那份 PHP 的逐句移植。它输出的不是给人看的文本，而是一串
 * 以空格分隔的「5 位 Unicode 码点」：禅道的搜索就是把中文压成码点再匹配，所以少一位、
 * 多一位都会让搜索结果对不上。
 */

import type { RowDataPacket } from "mysql2/promise";

import type { DbTransaction } from "./pool.js";

/** `module/action/model.php` 里那份白名单：动作名在其中就一定会重建索引。 */
const BUILD_ACTIONS = new Set([
  "created",
  "opened",
  "changed",
  "edited",
  "deleted",
  "undeleted",
  "erased",
]);

/** `module/search/config.php` 里每种对象取哪些列做 title / content。 */
const INDEX_FIELDS: Readonly<
  Record<string, { readonly title: string; readonly content: readonly string[]; readonly contentTable: string }>
> = {
  task: { title: "name", content: ["desc"], contentTable: "task" },
  bug: { title: "title", content: ["steps", "keywords", "resolvedBuild"], contentTable: "bug" },
  story: { title: "title", content: ["spec"], contentTable: "story" },
  effort: { title: "work", content: [], contentTable: "effort" },
};
/** PHP `strip_tags()` 的近似：去掉标签本身，保留文本。 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** `isLetter()`：PHP 里 `a-z A-Z 0-9` 与 `._/->:<?&` 这些字符能连成一个 word。 */
function isLetterByte(byte: number): boolean {
  if (byte >= 48 && byte <= 57) return true; // 0-9
  if (byte >= 65 && byte <= 90) return true; // A-Z
  if (byte >= 97 && byte <= 122) return true; // a-z
  return (
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x2f || // /
    byte === 0x2d || // -
    byte === 0x3e || // >
    byte === 0x3a || // :
    byte === 0x3c || // <
    byte === 0x3f || // ?
    byte === 0x26 // &
  );
}

/** UTF-8 字节序列 → 码点。`$c` 的第 1 字节决定还会有几个后续字节。 */
function unicodeOf(bytes: ArrayLike<number>, start: number, length: number): number {
  const b0 = bytes[start] ?? 0;
  if (length <= 1) return b0;
  if (length === 2) return (b0 - 192) * 64 + ((bytes[start + 1] ?? 0) - 128);
  if (length === 3) {
    return (b0 - 224) * 4096 + ((bytes[start + 1] ?? 0) - 128) * 64 + ((bytes[start + 2] ?? 0) - 128);
  }
  if (length === 4) {
    return (
      (b0 - 240) * 262144 +
      ((bytes[start + 1] ?? 0) - 128) * 4096 +
      ((bytes[start + 2] ?? 0) - 128) * 64 +
      ((bytes[start + 3] ?? 0) - 128)
    );
  }
  if (length === 5) {
    return (
      (b0 - 248) * 16777216 +
      ((bytes[start + 1] ?? 0) - 128) * 262144 +
      ((bytes[start + 2] ?? 0) - 128) * 4096 +
      ((bytes[start + 3] ?? 0) - 128) * 64 +
      ((bytes[start + 4] ?? 0) - 128)
    );
  }
  return (
    (b0 - 252) * 1073741824 +
    ((bytes[start + 1] ?? 0) - 128) * 16777216 +
    ((bytes[start + 2] ?? 0) - 128) * 262144 +
    ((bytes[start + 3] ?? 0) - 128) * 4096 +
    ((bytes[start + 4] ?? 0) - 128) * 64 +
    ((bytes[start + 5] ?? 0) - 128)
  );
}

/** 按首字节判断这个字符占几个字节；`0` 表示不是合法的 UTF-8 首字节。 */
function charLength(byte: number): number {
  if (byte >= 192 && byte <= 223) return 2;
  if (byte >= 224 && byte <= 239) return 3;
  if (byte >= 240 && byte <= 247) return 4;
  if (byte >= 248 && byte <= 251) return 5;
  if (byte >= 252 && byte <= 253) return 6;
  return 0;
}

/** PHP `is_numeric()` 的近似（`utf8Split` 只拿它判断「是不是纯整数」）。 */
function isNumeric(word: string): boolean {
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(word);
}

/** ASCII 范围内的 `strtolower`（`utf8Split` 只对 ASCII 做小写，别碰多字节）。 */
function asciiLower(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

/**
 * `lib/spliter/spliter.class.php::utf8Split()` 的移植。
 *
 * 返回 `words`（写进 `zt_searchindex.title/content` 的码点串）与 `dict`
 * （过程中遇到的「5 位码点 → 原字符」，要写进 `zt_searchdict`）。
 */
export function utf8Split(input: string): { words: string; dict: Map<number, string> } {
  const dict = new Map<number, string>();
  let words = "";

  const bytes: number[] = [];
  for (const byte of new TextEncoder().encode(input)) bytes.push(asciiLower(byte));

  const length = bytes.length;
  let i = 0;
  while (i <= length) {
    const ord = i < length ? (bytes[i] ?? 0) : 0;

    if (ord <= 191) {
      i += 1;
      if (isLetterByte(ord)) {
        let word = String.fromCharCode(ord);
        while (i <= length) {
          const next = i < length ? (bytes[i] ?? 0) : 0;
          if (!isLetterByte(next)) break;
          word += String.fromCharCode(next);
          i += 1;
        }
        // 纯整数会被包成 |123| 再右补齐到 5 位：这是禅道搜索里「数字能匹配上」的原因。
        if (isNumeric(word) && !word.includes(".")) word = `|${word}|`;
        words += ` ${word.padEnd(5, "_")}`;
      } else if (ord === 32) {
        words += " ";
      }
      continue;
    }

    const width = charLength(ord);
    if (width === 0) {
      // PHP 那边遇到 254/255 会复用上一轮的 offset（其实是 bug，会死循环）。
      // 这里直接跳过一个字节，保证不会卡住。
      i += 1;
      continue;
    }

    const unicode = unicodeOf(bytes, i, width);
    const text = new TextDecoder("utf-8").decode(new Uint8Array(bytes.slice(i, i + width)));
    i += width;

    const code = String(unicode);
    if (code.length === 5) {
      // 10000–65535：中日韩全在这一段，转成码点并记进字典。
      dict.set(unicode, text);
      words += ` ${code}`;
      continue;
    }

    // 不足 5 位（如 —、→、é）保留原字符；只有当它紧跟在数字后面时才补空格分隔。
    const tail = words.slice(-1);
    if (tail >= "0" && tail <= "9") words += " ";
    words += text;
  }

  return { words, dict };
}

interface ActionRow extends RowDataPacket {
  id: number;
  action: string;
  date: string;
  comment: string | null;
}

interface SourceRow extends RowDataPacket {
  title: string | null;
  content: string | null;
}

/**
 * 把「取内容」的 SQL 按对象类型拼出来（列名来自 `module/search/config.php`）。
 *
 * story 是特例：正文在 `zt_storyspec`（按 `story.version` 取那一版），不在 `zt_story` 上。
 */
function sourceQuery(
  objectType: string,
  tableOf: (name: string) => string,
  fields: { readonly title: string; readonly content: readonly string[]; readonly contentTable: string },
): string {
  const pieces = fields.content.map((column) => `COALESCE(t1.\`${column}\`, '')`);
  const plainContent = pieces.length === 0 ? "''" : pieces.join(", ");

  if (objectType === "story") {
    return `SELECT t1.\`${fields.title}\` AS title, COALESCE(ss.spec, '') AS content
       FROM ${tableOf(fields.contentTable)} t1
       LEFT JOIN ${tableOf("storyspec")} ss ON ss.story = t1.id AND ss.version = t1.version
      WHERE t1.id = ? LIMIT 1`;
  }

  return `SELECT t1.\`${fields.title}\` AS title, ${plainContent} AS content
     FROM ${tableOf(fields.contentTable)} t1 WHERE t1.id = ? LIMIT 1`;
}

/**
 * 判断这次动作是否需要重建索引（`action::saveIndex()` 的第一道闸）。
 *
 * 白名单里的动作名一定会重建；其余动作**只有带了 comment 才重建**——所以
 * 「完成一个任务但不写备注」不会动索引，「记一条工时并写了工作内容」会动。
 */
export function shouldRebuildIndex(actionName: string, comment: string): boolean {
  if (BUILD_ACTIONS.has(actionName.toLowerCase())) return true;
  return comment.trim() !== "";
}

/**
 * 重建一个对象的搜索索引。
 *
 * 与禅道一致的三件事：
 *   1. `addedDate` 取**第一条 action** 的时间，`editedDate` 取**最后一条**的时间；
 *   2. `content` = 正文 + 所有 action 的 comment（按 id 升序、每条后面补换行）；
 *   3. 唯一键是 `(objectType, objectID)`，所以走 `REPLACE`——**行 id 会变**。
 */
export async function rebuildSearchIndex(
  tx: DbTransaction,
  objectType: "task" | "bug" | "story" | "effort",
  objectID: number,
  options: { readonly comment?: string; readonly vision?: string } = {},
): Promise<{ rebuilt: boolean; reason?: string }> {
  const fields = INDEX_FIELDS[objectType];
  if (fields === undefined) return { rebuilt: false, reason: `没有为 ${objectType} 配索引字段` };

  const actions = await tx.query<ActionRow>(
    `SELECT id, action, \`date\`, comment FROM ${tx.table("action")}
      WHERE objectType = ? AND objectID = ? ORDER BY id ASC`,
    [objectType, objectID],
  );
  if (actions.length === 0) return { rebuilt: false, reason: "找不到动作记录，索引无法定时间" };

  // effort 属于 task 时禅道明确跳过（task 的工作内容不进搜索），照抄。
  if (objectType === "effort") {
    const owner = await tx.one<{ objectType: string } & RowDataPacket>(
      `SELECT objectType FROM ${tx.table("effort")} WHERE id = ? LIMIT 1`,
      [objectID],
    );
    if (owner?.objectType === "task" || owner === undefined) {
      return { rebuilt: false, reason: "任务下的工时记录不建索引（与禅道一致）" };
    }
  }

  const source = await tx.one<SourceRow>(sourceQuery(objectType, (name) => tx.table(name), fields), [objectID]);
  if (source === undefined) return { rebuilt: false, reason: "找不到对象本身，索引无法重建" };

  // comment 列在禅道里是把所有动作的备注串起来，最后再一起进 content。
  let comment = "";
  for (const action of actions) {
    const text = action.comment ?? "";
    if (text !== "") comment += `${text}\n`;
  }
  if (options.comment !== undefined && options.comment.trim() !== "" && !comment.includes(options.comment)) {
    comment += `${options.comment}\n`;
  }

  const titleSplit = utf8Split(source.title ?? "");
  const contentSplit = utf8Split(stripTags(`${source.content ?? ""}${comment}`));

  const first = actions[0];
  const last = actions[actions.length - 1];
  const addedDate = first?.date ?? last?.date ?? "";
  const editedDate = last?.date ?? addedDate;

  await saveDict(tx, titleSplit.dict);
  await saveDict(tx, contentSplit.dict);

  await tx.execute(
    `REPLACE INTO ${tx.table("searchindex")}
      (objectType, objectID, title, content, addedDate, editedDate, vision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      objectType,
      objectID,
      titleSplit.words,
      contentSplit.words,
      addedDate,
      editedDate,
      options.vision ?? "rnd",
    ],
  );

  return { rebuilt: true };
}

/** `search::saveDict()`：只收 5 位的 Unicode 码点，已经有的跳过。 */
async function saveDict(tx: DbTransaction, dict: Map<number, string>): Promise<void> {
  if (dict.size === 0) return;
  const entries = [...dict.entries()].filter(([key]) => key >= 0 && key <= 65535);
  if (entries.length === 0) return;

  const keys = entries.map(([key]) => String(key));
  const existing = await tx.query<{ key: string; value: string } & RowDataPacket>(
    `SELECT \`key\`, value FROM ${tx.table("searchdict")} WHERE \`key\` IN (${keys.map(() => "?").join(", ")})`,
    keys,
  );
  const known = new Set(existing.map((row) => `${row.key}\u0000${row.value}`));

  for (const [key, value] of entries) {
    if (known.has(`${String(key)}\u0000${value}`)) continue;
    await tx.execute(`INSERT INTO ${tx.table("searchdict")} (\`key\`, value) VALUES (?, ?)`, [String(key), value]);
  }
}
