/**
 * HTTP 线的写入：走禅道自己的表单，让禅道去改库。
 *
 * 这是写操作的首选线路，理由很实在：页面上点一下「完成」，禅道会自己写
 * task/effort/action/actionproduct/history/notify/kanban 七张表，还会跑钩子、
 * 算父任务、刷需求阶段。我们在库里复刻一遍总有漏，而走表单是「和同事点的是同一个按钮」。
 *
 * 三个实测出来的坑，必须照做：
 *   1. 必须先 GET 一次表单页把 `uid` 抠出来——禅道新皮肤其实不校验它，但少了它
 *      老版本会静默失败，代价只是一次 GET，不值得省。
 *   2. `consumed` 这个字段在 finish/start 里语义是「新的总消耗」，不是「本次消耗」。
 *      页面上的 JS 自己算「旧 + 本次」，我们不传就等于把本次工时记成 0（实测过）。
 *   3. 返回值不一定是 JSON：finish 走 ajax 表单回 JSON，recordworkhour/comment
 *      回的是 `js::locate(...)` / `js::reload(...)` 这种 JS 文本。两种都得认。
 */

import type { HttpSkin } from "../../domain/discovery.js";
import type { Entity } from "../../domain/model.js";
import { ChannelError } from "../types.js";
import type { WriteAction, WriteOutcome, WriteRequest, WriteSnapshot } from "../write.js";
import { toBugFromPage, toTaskFromPage } from "./map.js";
import { assertParsed, fetchParsedPage, viewPath } from "./page.js";
import { joinUrl, type HttpSession } from "./session.js";

/** 一次写操作需要的上下文：会话、基础地址、以及「读回当前状态」的能力。 */
export interface HttpWriteContext {
  readonly session: HttpSession;
  readonly baseUrl: string;
  /** 取一张详情页并解析成实体（用于写前/写后快照）。 */
  readonly readEntity: (kind: "task" | "bug", id: number, signal?: AbortSignal) => Promise<Entity>;
}

/** 动作 → 表单页的 `m`/`f`。 */
const TASK_FORM: Readonly<Record<string, { m: string; f: string }>> = {
  start: { m: "task", f: "start" },
  recordworkhour: { m: "task", f: "recordworkhour" },
  finish: { m: "task", f: "finish" },
  pause: { m: "task", f: "pause" },
  activate: { m: "task", f: "activate" },
  close: { m: "task", f: "close" },
  cancel: { m: "task", f: "cancel" },
};

const BUG_FORM: Readonly<Record<string, { m: string; f: string }>> = {
  confirm: { m: "bug", f: "confirm" },
  resolve: { m: "bug", f: "resolve" },
  close: { m: "bug", f: "close" },
};

/** 动作写成功后，禅道在 action 表里留下的动作名（对账用）。 */
const ACTION_NAME: Readonly<Record<string, string>> = {
  start: "started",
  recordworkhour: "recordestimate",
  finish: "finished",
  pause: "paused",
  activate: "activated",
  close: "closed",
  cancel: "canceled",
  confirm: "bugconfirmed",
  resolve: "resolved",
  comment: "commented",
};

function formPath(kind: "task" | "bug", action: string, id: number): string {
  if (kind === "task") {
    if (action === "comment") return `/index.php?m=action&f=comment&objectType=task&objectID=${id}`;
    const form = TASK_FORM[action];
    if (!form) throw new ChannelError("http", "write-rejected", `任务不支持动作：${action}`);
    return `/index.php?m=${form.m}&f=${form.f}&taskID=${id}`;
  }
  if (action === "comment") return `/index.php?m=action&f=comment&objectType=bug&objectID=${id}`;
  // BUG 的工时日志走 biz 版独立的 effort 模块（详情页底部那个「日志」按钮）。
  if (action === "recordworkhour") return `/index.php?m=effort&f=createForObject&type=bug&bugID=${id}`;
  const form = BUG_FORM[action];
  if (!form) throw new ChannelError("http", "write-rejected", `BUG 不支持动作：${action}`);
  return `/index.php?m=${form.m}&f=${form.f}&bugID=${id}`;
}

/**
 * 表单里「不参与回填」的字段。
 *
 * `files[]` 是附件上传控件；`team*` 是多人任务模板里的占位值（真实值是 `' + assignedTo + '`
 * 这种 JS 拼串）；`contactList` 是联系人选择器的空壳。它们只由页面 JS 维护，回填没有意义。
 */
const FORM_DEFAULTS_SKIP = new Set([
  "uid",
  "files[]",
  "contactList",
  "team",
  "team[]",
  "teamSource",
  "teamSource[]",
  "teamEstimate",
  "teamEstimate[]",
  "teamConsumed[]",
  "teamLeft[]",
]);

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * 把表单页上「浏览器此刻会提交的字段」抽成一份默认值。
 *
 * 为什么非做不可：禅道的写动作 model 多半直接 `fixer::input('post')` 全量落库，
 * **POST 里没出现的列会被写成数据库默认值**。本库 `sql_mode=''`，于是实测把 BUG 的
 * `pri` 从 1 变成 3、`type` 从「页面展示」变成空、`deadline` 变成空、`assignedTo` 被清空。
 * 浏览器之所以不出事，是因为它把表单里每个控件的当前值都回传了一遍。
 *
 * 所以我们照做：页面默认值打底，再叠加我们真正想改的字段。空值与 JS 拼串占位值一律跳过
 * （空值回传没有意义，占位值回传会把 `' + assignedTo + '` 写进库）。
 */
export function readFormDefaults(html: string): URLSearchParams {
  const out = new URLSearchParams();
  const put = (name: string | undefined, value: string): void => {
    if (!name || FORM_DEFAULTS_SKIP.has(name)) return;
    if (value === "" || value.includes("' +")) return;
    out.set(name, value);
  };

  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname=["']([^"']*)["']/i.exec(tag)?.[1];
    const type = /\btype=["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (type === "file" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") {
      continue;
    }
    put(name, unescapeHtml(/\bvalue=["']([^"']*)["']/i.exec(tag)?.[1] ?? ""));
  }

  for (const match of html.matchAll(/<textarea\b[^>]*\bname=["']([^"']*)["'][^>]*>([\s\S]*?)<\/textarea>/gi)) {
    put(match[1], unescapeHtml(match[2] ?? "").trim());
  }

  // zui 的 picker / priPicker / datePicker / datetimePicker 把「当前值」放在 defaultValue。
  for (const match of html.matchAll(/zui-create-(picker|priPicker|datePicker|datetimePicker)=["']([^"']*)["']/gi)) {
    const raw = unescapeHtml(match[2] ?? "");
    const name = /"name"\s*:\s*"([^"]*)"/.exec(raw)?.[1];
    const value = /"defaultValue"\s*:\s*(?:"([^"]*)"|([-\d.]+))/.exec(raw);
    if (!value) continue;
    put(name, unescapeHtml(value[1] ?? value[2] ?? ""));
  }

  return out;
}

/** 表单默认值打底、显式字段覆盖——就是浏览器提交的顺序。 */
function mergeFormDefaults(defaults: URLSearchParams, body: URLSearchParams): URLSearchParams {
  const merged = new URLSearchParams(defaults);
  for (const [key, value] of body) merged.set(key, value);
  return merged;
}

/** 从表单 HTML 里抠隐藏字段 uid。找不到返回空串（禅道其实不校验，见文件头坑 1）。 */
export function extractUid(html: string): string {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bname=["']uid["']/i.test(tag)) continue;
    const value = /\bvalue=["']([^"']*)["']/i.exec(tag);
    return value?.[1] ?? "";
  }
  return "";
}

/** 写操作返回的判定结果。 */
interface WriteReply {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * 把禅道失败回包里的 message 摊平成一句话。
 *
 * 实测禅道有两种失败形态：
 *   {"result":false,"message":"登录已超时..."}                    ← 字符串
 *   {"result":"fail","message":{"finishedDate":["实际完成不能小于实际开始"]}}  ← 字段 → 错误数组
 * 第二种以前被当成成功（因为只判了 result === "success"），必须显式处理。
 */
function flattenMessage(message: unknown): string {
  if (message === undefined || message === null) return "";
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((item) => flattenMessage(item)).filter(Boolean).join("；");
  if (typeof message === "object") {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(message as Record<string, unknown>)) {
      const text = flattenMessage(value);
      if (text) parts.push(`${field}: ${text}`);
    }
    return parts.join("；");
  }
  return String(message);
}

/**
 * 判定一次写提交的结果。
 *
 * 禅道可能回四种东西：JSON 成功、JSON 业务失败、JSON 会话过期、JS 跳转文本。
 * 这里把它们统一成 {ok, message}；会话过期要抛出去（让上层重登重试），不算业务失败。
 *
 * 判定原则是**只认明确的成功**：JSON 里 result 不是 "success"/true，一律算失败。
 * 这一点踩过坑——`{"result":"fail","message":{...}}` 曾被当成成功，写入其实没生效。
 */
export function judgeWriteReply(body: string): WriteReply {
  const text = body.trim();

  if (text.startsWith("{")) {
    let payload: { result?: unknown; message?: unknown; load?: string; reason?: string } | undefined;
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      payload = undefined;
    }
    if (payload) {
      if (payload.load === "login") {
        throw new ChannelError("http", "login", "禅道会话已过期（返回 load=login）");
      }
      const detail = flattenMessage(payload.message) || payload.reason || "";
      const result = payload.result;
      if (result === "success" || result === true) {
        return { ok: true, message: detail || "保存成功" };
      }
      if (result === undefined) {
        // 有的入口只回 {load:"..."} 之类，没有 result 时按失败算更安全。
        return { ok: false, message: detail || "禅道没有返回结果标记" };
      }
      return { ok: false, message: detail || `禅道返回 ${JSON.stringify(result)}` };
    }
  }

  if (/登录已超时|请重新登入/.test(text)) {
    throw new ChannelError("http", "login", "禅道会话已过期（页面提示重新登入）");
  }
  if (/js::(locate|reload|closeModal)/.test(text)) {
    return { ok: true, message: "保存成功" };
  }
  const errorMatch = /js::(?:error|alert)\(\s*['"]([\s\S]{0,200}?)['"]\s*\)/.exec(text);
  if (errorMatch) return { ok: false, message: errorMatch[1] ?? "禅道报错" };

  // 老入口（没有 zin=1）直接 echo 一行 JS，外面裹一层 HTML 外壳：
  //   <html><meta charset='utf-8'/><style>body{background:white}</style>
  //   <script>if(parent !== window) parent.location.reload(); else location.reload();</script>
  // 这类回包曾被当成「无法识别」而报错——但写入其实成功了（实测 comment 就是这样）。
  const scripted = classifyScriptReply(text);
  if (scripted) return scripted;

  return { ok: false, message: `无法识别禅道返回（前 200 字）：${text.slice(0, 200)}` };
}

/**
 * 认「页面回一行 JS」这种回包。
 *
 * 禅道的 `js::locate()` / `js::reload()` / `js::closeModal()` 会输出「HTML 外壳 + script」，
 * `js::alert()` / `js::error()` 也是同一形态。区别只在脚本里干什么：
 * 跳转/刷新/关弹窗 = 成功；`alert('...')` = 失败，文案就在引号里。
 */
function classifyScriptReply(text: string): WriteReply | undefined {
  if (!/<script[\s>]/i.test(text)) return undefined;
  const script = text
    .replace(/[\s\S]*?<script[^>]*>/i, "")
    .replace(/<\/script>[\s\S]*/i, "")
    .trim();
  if (!script) return undefined;

  const alertMatch = /alert\(\s*(['"])([\s\S]{0,300}?)\1\s*\)/.exec(script);
  if (alertMatch) {
    const message = alertMatch[2] ?? "";
    // 空 alert 只是「提示一下」，不当失败；有字的才是业务报错。
    if (!message.trim()) return { ok: true, message: "保存成功" };
    return { ok: false, message };
  }
  if (/location\.(reload|replace|href)|\.modal\(|closeModal|parent\.location/.test(script)) {
    return { ok: true, message: "保存成功" };
  }
  return undefined;
}

/** 数字格式化：禅道页面接受 "1.5" 这种，别传 "1.50000001"。 */
function hours(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 当前时间，格式与禅道一致（北京时间由服务器决定，这里只给本地格式）。 */
function nowStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(
    now.getMinutes(),
  )}:${pad(now.getSeconds())}`;
}

function today(): string {
  return nowStamp().slice(0, 10);
}

/**
 * 备注类动作的写后断言：条数没涨就是没写进去。
 *
 * 这条不是洁癖——`comment` 曾经真的「禅道回 success、插件报无法识别、实际写进去了」，
 * 反过来也会发生（平铺字段那次就是回了 success 但什么都没写）。
 * 光看回包不可靠，得看对象本体的备注条数。
 */
function assertCommentLanded(request: WriteRequest, kind: string, before: number, after: number): void {
  if (request.action !== "comment") return;
  if (after > before) return;
  throw new ChannelError(
    "http",
    "write-rejected",
    `禅道回了成功，但${kind === "bug" ? " BUG" : "任务"} #${request.id} 的备注条数没有增加（${before} → ${after}），这条备注没有真的写进去`,
  );
}

/**
 * 只有「本来就该改状态」的动作才适合用「状态没变」告警。
 * confirm / comment / recordworkhour 本来就不动状态，报这句话只会误导。
 */
function needsStatusChange(action: WriteAction): boolean {
  return action === "start" || action === "finish" || action === "pause" || action === "activate" || action === "close" || action === "cancel" || action === "resolve";
}

/** 从实体里取快照。 */
function snapshotOf(entity: Entity): WriteSnapshot {
  const account = entity.codes?.assignedTo;
  if (entity.kind === "bug") {
    return {
      status: entity.status ?? "",
      assignedTo: entity.assignedTo ?? "",
      ...(account === undefined ? {} : { assignedToAccount: account }),
      consumed: 0,
      left: 0,
      confirmed: entity.confirmed ?? 0,
      resolution: entity.resolution ?? "",
    };
  }
  const task = entity as { status?: string; assignedTo?: string; consumed?: number; left?: number };
  return {
    status: task.status ?? "",
    assignedTo: task.assignedTo ?? "",
    ...(account === undefined ? {} : { assignedToAccount: account }),
    consumed: task.consumed ?? 0,
    left: task.left ?? 0,
  };
}

/**
 * 提交一次表单并判定结果。失败时抛 ChannelError，成功返回禅道的原话。
 */
async function submit(context: HttpWriteContext, path: string, body: URLSearchParams): Promise<string> {
  let page;
  try {
    page = await context.session.post(joinUrl(context.baseUrl, path), {
      body,
      referer: path,
    });
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("http", "write", `提交失败：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const reply = judgeWriteReply(page.html);
  if (!reply.ok) {
    throw new ChannelError("http", "write-rejected", `禅道拒绝了这次写入：${reply.message}`);
  }
  return reply.message;
}

/** 一次表单页 GET 的收获：隐藏 uid，以及「浏览器此刻会一起提交」的默认值。 */
interface FormPage {
  readonly uid: string;
  readonly defaults: URLSearchParams;
}

/**
 * 取表单页，抠 uid 与表单默认值。
 *
 * 顺带做一件事：确认这个动作的表单确实存在（页面里没有对应 form 就是禅道不允许，
 * 例如对已完成的任务再点完成）。这样错误在 GET 阶段就暴露，不会带着半截参数去 POST。
 */
async function openForm(context: HttpWriteContext, path: string): Promise<FormPage> {
  const page = await context.session.get(joinUrl(context.baseUrl, path));
  const html = page.html;
  if (/登录已超时|请重新登入|name=["']password["']/.test(html) && !/name=["']uid["']/.test(html)) {
    throw new ChannelError("http", "login", "禅道会话已过期，请重试");
  }
  return { uid: extractUid(html), defaults: readFormDefaults(html) };
}

/**
 * 数一个 BUG 详情页上有多少条「日志」（工时）记录。
 *
 * 判据是历史面板里那句话——`2026-10-30 13:56:06, 由 **张三** 记录工时，消耗 **0.5** 小时。`
 * 每条日志必定且只产生一句（`recordestimate` action 一条对一个 effort 行）。
 *
 * 为什么必须数：BUG 的工时表单（`m=effort&f=createForObject`）用**平铺式**字段提交时
 * 会返回 `{"result":"success","message":"保存成功"}` 却什么也没写进去（实测踩过），
 * 所以「回包说成功」不能当证据，必须断言记录条数真的变了。
 *
 * 注意：**不能**去数 `m=effort&f=edit&effortID=` 那种链接——biz 版详情页上根本不存在，
 * 用它会得到恒 0 的假结果（曾经因此把一次真实写入误报成「没写进去」）。
 */
export function countEffortEntries(html: string): number {
  return (html.match(/记录工时，消耗/g) ?? []).length;
}

/** 取一张 BUG 详情页的 HTML（工时日志的写后断言要用）。 */
async function loadBugPage(context: HttpWriteContext, id: number, signal?: AbortSignal): Promise<string> {
  const page = await context.session.get(
    joinUrl(context.baseUrl, `/index.php?m=bug&f=view&bugID=${id}`),
    signal,
  );
  return page.html;
}

/**
 * 给 start / activate 补上「指派给」。
 *
 * 这两个动作在禅道页面上都带一个「指派给」下拉框，不带这个字段提交时它会被写成空串
 * （实测：一次 activate 把 2042 的指派人从「张三」清成了空）。所以必须显式回填：
 * 优先用调用方给的账号，其次沿用写前快照里的账号码。
 */
function setAssignee(body: URLSearchParams, requested: string | undefined, before: WriteSnapshot): void {
  const account = requested ?? before.assignedToAccount;
  if (account !== undefined && account !== "" && account !== "closed") body.set("assignedTo", account);
}

/** 任务动作需要的「新总消耗」：旧 consumed + 本次。 */
function totalConsumed(before: WriteSnapshot, extra: number | undefined): number {
  return Math.round((before.consumed + (extra ?? 0)) * 100) / 100;
}

/**
 * 拼一个任务动作的表单字段（纯函数，不含 uid、不发请求）。
 *
 * 单独抽出来是为了能离线断言每个动作到底提交了哪些字段——HTTP 线没法做沙箱，
 * 一次真机 POST 就是一次真实写入，所以「字段拼错」这种错必须在这层就被测出来。
 */
export function buildTaskBody(
  before: WriteSnapshot,
  request: WriteRequest,
  warnings: string[] = [],
): URLSearchParams {
  const body = new URLSearchParams();

  switch (request.action) {
    case "start": {
      // start 的 consumed 也是「新的累计消耗」（与库通道、工具描述一致），不是「本次」。
      if (before.status === "doing") {
        throw new ChannelError("http", "write-rejected", `任务 #${request.id} 已经是进行中`);
      }
      const target = Math.round((request.consumed ?? before.consumed) * 100) / 100;
      if (target < before.consumed) {
        throw new ChannelError("http", "write-rejected", "本次消耗工时不能小于已消耗工时");
      }
      body.set("consumed", hours(target));
      body.set("left", hours(request.left ?? before.left ?? 0));
      // realStarted 只在调用方显式给了才写：表单页的默认值里带着原始开始时间，
      // 而 mergeFormDefaults 会把它回填进去。硬填 nowStamp() 会把「上周就开始的任务」
      // 的开始时间改成此刻——库通道那边的写法是 request.realStarted || before.realStarted || now。
      if (request.realStarted) body.set("realStarted", request.realStarted);
      setAssignee(body, request.assignedTo, before);
      body.set("status", "doing");
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "recordworkhour": {
      // 与库通道对齐：只有进行中/未开始/暂停的任务能记工时。
      if (before.status !== "doing" && before.status !== "wait" && before.status !== "pause") {
        throw new ChannelError("http", "write-rejected", `任务 #${request.id} 当前状态是 ${before.status}，不能记工时`);
      }
      if ((request.consumed ?? 0) <= 0) {
        throw new ChannelError("http", "write-rejected", "本次工时必须大于 0");
      }
      // 批量表单：字段名带数组下标，不带上标禅道读不到行（实测）。
      const date = request.date ?? today();
      body.set("id[1]", "");
      body.set("date[1]", date);
      body.set("work[1]", request.comment ?? "");
      body.set("consumed[1]", hours(request.consumed ?? 0));
      body.set("left[1]", hours(request.left ?? before.left ?? 0));
      break;
    }
    case "finish": {
      const extra = Math.round((request.consumed ?? 0) * 100) / 100;
      if (extra < 0) throw new ChannelError("http", "write-rejected", "本次消耗工时不能是负数");
      body.set("currentConsumed", hours(extra));
      body.set("consumed", hours(totalConsumed(before, extra)));
      if (request.realStarted) body.set("realStarted", request.realStarted);
      body.set("finishedDate", request.finishedDate ?? nowStamp());
      body.set("status", "done");
      body.set("left", "0");
      if (request.assignedTo) body.set("assignedTo", request.assignedTo);
      if (request.comment) body.set("comment", request.comment);
      if (extra === 0) warnings.push("本次工时填的是 0，禅道不会为这次完成生成工时记录");
      break;
    }
    case "pause": {
      // 与库通道对齐：只有进行中的任务能暂停。状态读空（皮肤没认出来）时不拦——
      // 那种情况该由 assertParsed 报出来，在这里拦会给出一个错的理由。
      if (before.status && before.status !== "doing") {
        throw new ChannelError("http", "write-rejected", `任务 #${request.id} 不是进行中，不能暂停`);
      }
      body.set("status", "pause");
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "activate": {
      body.set("left", hours(request.left ?? 0));
      body.set("status", "doing");
      setAssignee(body, request.assignedTo, before);
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "close": {
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "cancel": {
      body.set("status", "cancel");
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "comment": {
      if (!request.comment?.trim()) {
        throw new ChannelError("http", "write-rejected", "备注内容不能为空");
      }
      body.set("comment", request.comment);
      break;
    }
    default:
      throw new ChannelError("http", "write-rejected", `任务不支持动作：${request.action}`);
  }

  return body;
}

/** 执行一次任务写操作。 */
async function writeTask(context: HttpWriteContext, request: WriteRequest): Promise<WriteOutcome> {
  const beforeEntity = await context.readEntity("task", request.id, request.signal);
  const before = snapshotOf(beforeEntity);
  const notesBefore = beforeEntity.notes.length;
  const path = formPath("task", request.action, request.id);
  const warnings: string[] = [];
  let body = buildTaskBody(before, request, warnings);
  // recordworkhour 的页面里没有隐藏 uid（批量表单），其余动作要先取 uid。
  // 顺手把表单默认值打底：禅道 model 会全量落库，缺字段的列会被写成默认值。
  if (request.action !== "recordworkhour" && request.action !== "comment") {
    const form = await openForm(context, path);
    body = mergeFormDefaults(form.defaults, body);
    body.set("uid", form.uid);
  }

  const message = await submit(context, path, body);

  const afterEntity = await context.readEntity("task", request.id, request.signal);
  const after = snapshotOf(afterEntity);
  assertCommentLanded(request, "task", notesBefore, afterEntity.notes.length);
  if (needsStatusChange(request.action) && before.status === after.status) {
    warnings.push(`状态没有变化（写前写后都是 ${after.status}），请在禅道上确认这次操作是否真的生效`);
  }

  return {
    channel: "http",
    kind: "task",
    id: request.id,
    action: request.action,
    actionName: ACTION_NAME[request.action] ?? request.action,
    before,
    after,
    message,
    warnings,
  };
}

/** 执行一次 BUG 写操作。 */
/**
 * 拼一个 BUG 动作的表单字段（纯函数，不含 uid、不发请求）。
 *
 * 与 `buildTaskBody` 同理：HTTP 线没法沙箱验证，字段拼错就等于一次错写，
 * 所以这一层要能被离线断言。
 */
export function buildBugBody(request: WriteRequest, before?: WriteSnapshot): URLSearchParams {
  const body = new URLSearchParams();

  switch (request.action) {
    case "confirm": {
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "resolve": {
      const resolution = request.resolution?.trim();
      if (!resolution) throw new ChannelError("http", "write-rejected", "解决 BUG 必须给 resolution");
      body.set("resolution", resolution);
      body.set("resolvedBuild", request.resolvedBuild ?? "trunk");
      if (resolution === "duplicate") {
        if (!request.duplicateBug) {
          throw new ChannelError("http", "write-rejected", "resolution=duplicate 时必须给 duplicateBug");
        }
        body.set("duplicateBug", String(request.duplicateBug));
      }
      // 解决页带「是否顺手建一个版本」的勾选；我们不建，显式传空。
      body.set("buildName", request.resolvedBuild ?? "trunk");
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "close": {
      if (request.comment) body.set("comment", request.comment);
      break;
    }
    case "comment": {
      if (!request.comment?.trim()) {
        throw new ChannelError("http", "write-rejected", "备注内容不能为空");
      }
      body.set("comment", request.comment);
      break;
    }
    case "recordworkhour": {
      // BUG 的「日志」：biz 版 effort 模块的批量表单。
      // 字段名带数组下标（dates/work/consumed），且页面没有 uid 可抠，不做 openForm。
      // 与库通道对齐：已关闭的 BUG 不能补记工时（这条以前只有库线有）。
      if (before?.status === "closed") {
        throw new ChannelError("http", "write-rejected", `BUG #${request.id} 已关闭，不能记工时`);
      }
      if (!request.comment?.trim()) {
        throw new ChannelError("http", "write-rejected", "日志内容不能为空（对应禅道的『工作内容』必填项）");
      }
      const consumed = Math.round((request.consumed ?? 0) * 100) / 100;
      if (consumed <= 0) throw new ChannelError("http", "write-rejected", "本次工时必须大于 0");
      body.set("id[1]", "");
      body.set("objectType[1]", "bug");
      body.set("objectID[1]", String(request.id));
      body.set("dates[1]", request.date ?? today());
      body.set("work[1]", request.comment);
      body.set("consumed[1]", hours(consumed));
      break;
    }
    default:
      throw new ChannelError("http", "write-rejected", `BUG 不支持动作：${request.action}`);
  }

  return body;
}

async function writeBug(context: HttpWriteContext, request: WriteRequest): Promise<WriteOutcome> {
  const beforeEntity = await context.readEntity("bug", request.id, request.signal);
  const before = snapshotOf(beforeEntity);
  const notesBefore = beforeEntity.notes.length;
  const path = formPath("bug", request.action, request.id);
  let body = buildBugBody(request, before);
  const warnings: string[] = [];
  // BUG 的 recordworkhour 与 comment 都不走 uid；其余动作要先从表单页抠出来。
  // 表单默认值必须一起回填：confirm 这类 model 会把 POST 里没有的列写成库默认值，
  // 实测丢过 type/pri/deadline/assignedTo。
  if (request.action !== "comment" && request.action !== "recordworkhour") {
    const form = await openForm(context, path);
    body = mergeFormDefaults(form.defaults, body);
    body.set("uid", form.uid);
  }

  // 工时日志要做写后断言：先数一遍现有条数，写完再数一遍。
  let effortsBefore = 0;
  if (request.action === "recordworkhour") {
    effortsBefore = countEffortEntries(await loadBugPage(context, request.id, request.signal));
  }

  const message = await submit(context, path, body);

  if (request.action === "recordworkhour") {
    const effortsAfter = countEffortEntries(await loadBugPage(context, request.id, request.signal));
    if (effortsAfter <= effortsBefore) {
      throw new ChannelError(
        "http",
        "write-rejected",
        `禅道回了「${message}」，但 BUG #${request.id} 的日志条数没有增加（${effortsBefore} → ${effortsAfter}），这次工时没有真的写进去`,
      );
    }
  }

  const afterEntity = await context.readEntity("bug", request.id, request.signal);
  const after = snapshotOf(afterEntity);
  assertCommentLanded(request, "bug", notesBefore, afterEntity.notes.length);
  if (needsStatusChange(request.action) && before.status === after.status) {
    warnings.push(`状态没有变化（写前写后都是 ${after.status}），请在禅道上确认这次操作是否真的生效`);
  }

  return {
    channel: "http",
    kind: "bug",
    id: request.id,
    action: request.action,
    actionName: ACTION_NAME[request.action] ?? request.action,
    before,
    after,
    message,
    warnings,
  };
}

/**
 * HTTP 线的写入口。根据 kind 分派，其余交给两个 write* 函数。
 */
export async function writeViaHttp(context: HttpWriteContext, request: WriteRequest): Promise<WriteOutcome> {
  try {
    if (request.kind === "task") return await writeTask(context, request);
    return await writeBug(context, request);
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError(
      "http",
      "write",
      `写入 ${request.kind}#${request.id} 的「${request.action}」失败：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/** 供通道复用的读页实现（与读路径同一套解析，保证快照口径一致）。 */
export async function readEntityViaHttp(
  options: {
    readonly baseUrl: string;
    readonly urlFor?: (kind: "story" | "task" | "bug", id: number) => string | undefined;
    /** 页面皮肤的期望值（`http.skin` 配了才有）——写路径必须和读路径同一档。 */
    readonly skin?: () => HttpSkin | undefined;
    /**
     * 显示名 → 账号。写前/写后快照要跟读路径**同一口径**，否则 before 是中文、
     * 护栏比机器码就又对不上；调用方负责先预热再传进来。
     */
    readonly resolveAccount?: (realname: string) => string | undefined;
  },
  session: HttpSession,
  kind: "task" | "bug",
  id: number,
  signal?: AbortSignal,
): Promise<Entity> {
  const page = await fetchParsedPage(
    session,
    { baseUrl: options.baseUrl, skin: options.skin?.() },
    viewPath(kind, id),
    signal,
  );
  // 写前快照拿空页面是最坏的失败方式：状态读成 ""，护栏和「变了什么」全失准，
  // 最后还会输出「状态没有变化（写前写后都是 ）」。宁可在这里报出来。
  assertParsed(page, kind, id);

  return kind === "task"
    ? toTaskFromPage(page, {
        id,
        url: options.urlFor?.(kind, id),
        fallbackTitle: `${kind} #${id}`,
        resolveAccount: options.resolveAccount,
      })
    : toBugFromPage(page, {
        id,
        url: options.urlFor?.(kind, id),
        fallbackTitle: `${kind} #${id}`,
        resolveAccount: options.resolveAccount,
      });
}
