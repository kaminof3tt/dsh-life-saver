/**
 * 详情页的取与验：读路径和写路径共用同一套「取页面 + 解析 + 断言非空」。
 *
 * 这两件事以前各写了一份（`index.ts` 的 fetchPage/assertParsed 与 `write.ts` 里
 * 手搭的 readEntityViaHttp），结果写路径漏了 skin 与空解析断言：皮肤一变或登录过期，
 * 写前快照会拿到 `status: ""` 继续跑，最后输出「状态没有变化（写前写后都是 ）」。
 * 快照和正文必须同口径，否则 before/after 的比较毫无意义。
 */

import type { HttpSkin } from "../../domain/discovery.js";
import { ChannelError } from "../types.js";
import { parsePage, parseZinPayload, type ParsedPage } from "./parse.js";
import { joinUrl, type HttpSession } from "./session.js";

const VIEW_PARAMS = {
  story: "storyID",
  task: "taskID",
  bug: "bugID",
} as const;

const VIEW_MODULES = {
  story: "story",
  task: "task",
  bug: "bug",
} as const;

/** 详情页路径。@param kind 实体种类 */
export function viewPath(kind: "story" | "task" | "bug", id: number): string {
  return `/index.php?m=${VIEW_MODULES[kind]}&f=view&${VIEW_PARAMS[kind]}=${id}`;
}

/** 取页面需要的上下文。 */
export interface PageOptions {
  readonly baseUrl: string;
  /** 用户钉死的皮肤档位；不配则按「新 → 老」试。 */
  readonly skin?: HttpSkin;
}

/**
 * 取一张详情页并解析。
 *
 * 先试 `zin=1`：禅道会把它拆成 JSON 数组，正文片段里没有导航噪音，抽取最干净。
 * 拿不到（返回 HTML / 解析失败 / 页面不支持）就退回整页 HTML。
 */
export async function fetchParsedPage(
  session: HttpSession,
  options: PageOptions,
  path: string,
  signal?: AbortSignal,
): Promise<ParsedPage> {
  try {
    const zin = await session.get(joinUrl(options.baseUrl, `${path}&zin=1`), signal);
    const payload = parseZinPayload(zin.html);
    if (payload) return parsePage(payload.mainHtml, { zinTitle: payload.title, skin: options.skin });
  } catch {
    // zin 失败不报错：老版本禅道没有这个接口，整页解析是正常路径。
  }
  const page = await session.get(joinUrl(options.baseUrl, path), signal);
  return parsePage(page.html, { skin: options.skin });
}

/**
 * 页面「解析出来是空的」必须显式失败。
 *
 * 这是最危险的一种静默失败：登录过期 / 皮肤变了 / 命中登录页，parsePage 都会
 * 老老实实返回一堆空数组，上层把它当成「这条单子没正文」照常渲染成功——
 * 模型拿着空正文继续干活，谁也看不出中间丢了一次读取。宁可报错让人来看。
 */
export function assertParsed(page: ParsedPage, kind: string, id: number): void {
  const empty =
    Object.keys(page.fields).length === 0 &&
    page.sections.length === 0 &&
    page.notes.length === 0 &&
    page.attachments.length === 0;
  if (!empty) return;
  throw new ChannelError(
    "http",
    "skin-unknown",
    `读取 ${kind}#${id} 的页面解析不出任何内容（HTML ${page.htmlLength} 字符）：` +
      "可能是登录失效、页面结构变了，或 http.skin 配错；" +
      "已依次试过 .detail-section / .detail / .article 三套选择器，均无命中。",
  );
}
