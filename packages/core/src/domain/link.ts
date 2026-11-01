/**
 * 从「用户贴过来的东西」里认出禅道对象。
 *
 * 用户很少说「bug 5967」，更常见的是直接把浏览器地址栏里的链接甩过来：
 *   http://zentao.example.com/index.php?m=bug&f=view&bugID=5967
 *   http://zentao.example.com/zentao/task-view-1875.html
 *   http://zentao.example.com/index.php?m=story&f=view&storyID=1313#app=qa
 *   #bug=5967、bugID=5967、纯编号 5967
 * 与其指望模型自己把编号抠出来，不如工具自己认——抠错了比不认更糟。
 */

import type { EntityKind } from "./model.js";

/** 认出来的结果：能确定的字段才出现。 */
export interface ZentaoRef {
  readonly kind?: EntityKind;
  readonly id?: number;
}

/** 禅道页面里出现过的类型词，映射到本插件的三件套。 */
const KIND_WORDS: Record<string, EntityKind> = {
  bug: "bug",
  bugs: "bug",
  task: "task",
  tasks: "task",
  story: "story",
  stories: "story",
  requirement: "story",
  requirements: "story",
  storyview: "story",
};

/** `m=<type>` 里 type 的取值。 */
function kindOfWord(word: string | undefined): EntityKind | undefined {
  if (word === undefined) return undefined;
  return KIND_WORDS[word.trim().toLowerCase()];
}

/** 认一个正整数编号：只认纯数字，别把 2026 年 10 月这种日期段当编号。 */
function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 解析一段用户输入（链接、参数串、或纯编号）。
 * 什么都认不出来时返回空对象，由调用方给出「说清楚编号」的提示。
 */
export function parseZentaoRef(input: unknown): ZentaoRef {
  if (typeof input === "number") {
    return Number.isInteger(input) && input > 0 ? { id: input } : {};
  }
  if (typeof input !== "string") return {};
  const text = input.trim();
  if (text.length === 0) return {};

  // 纯编号
  const bare = positiveInteger(text);
  if (bare !== undefined) return { id: bare };

  // 1) 查询串：?m=bug&f=view&bugID=5967 / ?m=task&f=view&taskID=1875
  const queryKind = kindOfWord(matchOne(text, /(?:^|[?&])m=([A-Za-z]+)/));
  const byTypeId =
    positiveInteger(matchOne(text, /(?:^|[?&#])bugID=(\d+)/i)) ??
    positiveInteger(matchOne(text, /(?:^|[?&#])taskID=(\d+)/i)) ??
    positiveInteger(matchOne(text, /(?:^|[?&#])storyID=(\d+)/i)) ??
    positiveInteger(matchOne(text, /(?:^|[?&#])requirementID=(\d+)/i));
  if (byTypeId !== undefined) {
    const typeFromParam = matchOne(text, /(?:^|[?&#])(bugID|taskID|storyID|requirementID)=/i);
    return { kind: queryKind ?? kindOfWord(typeFromParam?.replace(/ID$/i, "")), id: byTypeId };
  }

  // 1b) 通用 id=：biz 版详情页是 ?m=story&f=view&id=1389（不带 storyID 前缀）
  const byGenericId = positiveInteger(matchOne(text, /(?:^|[?&#])id=(\d+)/i));
  if (byGenericId !== undefined) {
    return queryKind === undefined ? { id: byGenericId } : { kind: queryKind, id: byGenericId };
  }

  // 2) 路径式：/zentao/bug-view-5967.html、/story-view-1313.json
  const pathStyle = text.match(/\/(bug|task|story)-view-(\d+)(?:[-\w]*)?\.(?:html?|json|xml)(?:[?#]|$)/i);
  if (pathStyle) {
    const id = positiveInteger(pathStyle[2]);
    if (id !== undefined) return { kind: kindOfWord(pathStyle[1]), id };
  }

  // 3) 锚点式：?m=my&f=work&... #bug=5967（老版本禅道的 hash 路由）
  const hashStyle = text.match(/#(bug|task|story)=(\d+)/i);
  if (hashStyle) {
    const id = positiveInteger(hashStyle[2]);
    if (id !== undefined) return { kind: kindOfWord(hashStyle[1]), id };
  }

  // 4) 兜底：有 m=bug 却没编号时，仍然只把类型带出去（调用方能给更准的提示）
  return queryKind === undefined ? {} : { kind: queryKind };
}

function matchOne(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[1];
}
