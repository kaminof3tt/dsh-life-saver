/**
 * HTTP 通道：账号密码登录换 cookie，然后按「人看到的页面」取内容。
 *
 * 与 DB 通道的分工很明确——它不碰数据库，也不需要 SFTP：
 *   - 字段来自详情页的 `.datalist-item`；
 *   - 正文来自 `.detail-content` 的富文本；
 *   - 备注来自历史面板里塞的 JSON（`zui-create-historypanel`）；
 *   - 附件与图片走 `m=file&f=download|read&fileID=` 的链接，带 cookie 取字节。
 *
 * 它比 DB 通道「更接近真值」（页面就是同事看到的样子），代价是慢、且受权限约束；
 * 所以 auto 模式下永远是 DB 先上，失败才轮到它。
 */

import type { DiscoveryReport, HttpSkin, LoginFlow } from "../../domain/discovery.js";
import type { Entity, EntityEnvelope } from "../../domain/model.js";
import { saveAttachment } from "../attachments.js";
import {
  ChannelError,
  type Channel,
  type ChannelCaps,
  type ProbeResult,
  type ReadRequest,
  type SearchHit,
  type SearchRequest,
} from "../types.js";
import type { WriteOutcome, WriteRequest } from "../write.js";
import { missingForHttp, toBugFromPage, toStoryFromPage, toTaskFromPage } from "./map.js";
import { assertParsed, fetchParsedPage, viewPath } from "./page.js";
import { parsePage } from "./parse.js";
import { createHttpSession, joinUrl, type HttpSession } from "./session.js";
import { createUserDirectory, type UserDirectory } from "./users.js";
import { readEntityViaHttp, writeViaHttp } from "./write.js";

export interface HttpChannelOptions {
  readonly baseUrl: string;
  readonly account: string;
  readonly password: string;
  readonly timeoutMs: number;
  /** 生成实体链接（未配置 baseUrl 时返回 undefined）。 */
  readonly urlFor?: (kind: "story" | "task" | "bug", id: number) => string | undefined;
  /**
   * 页面皮肤的期望值（`http.skin` 配了才有）。
   *
   * 三套选择器本来是「按新旧顺序硬试」，串味时只能靠人肉判断；这个回调让用户
   * 手工钉死一档，把「先试哪套」变成部署可配项。
   */
  readonly skin?: () => HttpSkin | undefined;
}

const CAPS: ChannelCaps = {
  read: true,
  search: true,
  attachments: true,
  notes: true,
  // 页面上的「预计工时/消耗」在字段表里，能读到；但老页面可能没有这一行。
  estimates: true,
  // 写走禅道自己的表单，副作用（history/通知/看板）由禅道写全，这是首选线路。
  write: true,
  // 统计不给 HTTP 线：页面上的工时报表口径不可控，统一走库。
  stats: false,
};

function filePath(fileId: number, mode: "download" | "read"): string {
  return `/index.php?m=file&f=${mode}&fileID=${fileId}`;
}

/**
 * 从字节头猜扩展名。页面上的正文图片只有 fileID（没有文件名、没有 `t=` 参数），
 * 落盘时总得给个后缀，才方便工具和后面的画图工具认。
 */
export function sniffExtension(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  if (head.subarray(0, 2).toString("latin1") === "BM") return "bmp";
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b) return "zip";
  return "bin";
}

/**
 * 搜到的链接 → 实体。禅道搜索结果里既有 `?m=story&f=view&storyID=12`，
 * 也有伪静态 `/story-view-12.html`，两种都要认。
 */
export function entityFromHref(href: string): { kind: "story" | "task" | "bug"; id: number } | undefined {
  const queryMatch = /[?&]m=(story|task|bug)\b[^#]*?[?&](?:storyID|taskID|bugID|id)=(\d+)/i.exec(href);
  if (queryMatch) {
    const kind = queryMatch[1]?.toLowerCase() as "story" | "task" | "bug";
    const id = Number.parseInt(queryMatch[2] ?? "", 10);
    if (Number.isFinite(id)) return { kind, id };
  }
  const pathMatch = /(?:^|\/)(story|task|bug)-view-(\d+)/i.exec(href);
  if (pathMatch) {
    const kind = pathMatch[1]?.toLowerCase() as "story" | "task" | "bug";
    const id = Number.parseInt(pathMatch[2] ?? "", 10);
    if (Number.isFinite(id)) return { kind, id };
  }
  return undefined;
}

export function createHttpChannel(options: HttpChannelOptions): Channel {
  let session: HttpSession | undefined;
  let directory: UserDirectory | undefined;
  /**
   * 这次进程里「实际观察到」的事实：皮肤命中哪套、登录吃哪档协议。
   *
   * 只在内存里攒，不发额外请求——探测层要的正是「顺手记下来的真值」，
   * 而不是为了摸底再多打两枪。
   */
  let observed: { skin?: HttpSkin; loginFlow?: LoginFlow } = {};

  const current = (): HttpSession => {
    if (!options.baseUrl) throw new ChannelError("http", "config", "未配置 http.baseUrl");
    if (!options.account) throw new ChannelError("http", "config", "未配置 http.account");
    if (!options.password) throw new ChannelError("http", "config", "未配置凭据 ZENTAO_PASSWORD");
    session ??= createHttpSession({
      baseUrl: options.baseUrl,
      account: options.account,
      password: options.password,
      timeoutMs: options.timeoutMs,
      onLoginFlow: (flow) => {
        observed = { ...observed, loginFlow: flow };
      },
    });
    return session;
  };

  /** 解析结果记一笔：只要命中过皮肤，就说明这套部署是那一档。 */
  const remember = <T extends { skin?: HttpSkin }>(page: T): T => {
    if (page.skin) observed = { ...observed, skin: page.skin };
    return page;
  };

  /**
   * 显示名 ↔ 账号的反查表。
   *
   * 页面上只有中文名，写操作的归属校验要账号，所以每次读实体前先预热一次。
   * 预热失败不报错（反查表是尽力而为），映射层会退回显示名比较。
   */
  const users = (): UserDirectory => {
    directory ??= createUserDirectory({ session: current, baseUrl: options.baseUrl });
    return directory;
  };

  /**
   * 取一张详情页。
   *
   * 先试 `zin=1`：禅道会把它拆成 JSON 数组，正文片段里没有导航噪音，抽取最干净。
   * 拿不到（返回 HTML / 解析失败 / 页面不支持）就退回整页 HTML。
   */
  const fetchPage = async (path: string, signal?: AbortSignal) =>
    remember(await fetchParsedPage(current(), { baseUrl: options.baseUrl, skin: options.skin?.() }, path, signal));

  /**
   * 落盘。两类来源一起处理：
   *   - 附件面板里的文件（`f=download`）；
   *   - 正文里内嵌的图片——它们同样是 `zt_file` 里的实体，只是页面上没有「附件」那一栏，
   *     只有 `f=read` 的链接。落地时靠字节头补扩展名。
   */
  const download = async (
    page: ReturnType<typeof parsePage>,
    request: ReadRequest,
  ): Promise<ReturnType<typeof parsePage>["attachments"]> => {
    const attachments = page.attachments;
    const dir = request.withAttachments ? request.attachmentDir : undefined;
    if (!dir) return attachments;

    const http = current();
    const budget = Math.max(0, request.maxAttachments);
    const maxBytes = request.maxAttachmentBytes;
    const out: Array<(typeof attachments)[number]> = [];
    let used = 0;

    for (const attachment of attachments) {
      if (used >= budget || (attachment.size ?? 0) > maxBytes) {
        out.push(attachment);
        continue;
      }
      try {
        const bytes = await http.bytes(joinUrl(options.baseUrl, filePath(attachment.fileId, "download")), request.signal);
        if (bytes.length > maxBytes) {
          out.push({ ...attachment, size: bytes.length });
          continue;
        }
        out.push({
          ...attachment,
          size: attachment.size ?? bytes.length,
          localPath: await saveAttachment(dir, attachment.fileId, attachment.filename, bytes),
        });
        used += 1;
      } catch {
        // 单个附件失败不影响整条记录：清单照给，只是没有本地路径。
        out.push(attachment);
      }
    }

    const seen = new Set(attachments.map((attachment) => attachment.fileId));
    for (const image of page.images) {
      if (seen.has(image.fileId)) continue;
      seen.add(image.fileId);
      const known = { fileId: image.fileId, filename: image.filename, size: image.size, isImage: true };
      if (used >= budget) {
        out.push(known);
        continue;
      }
      try {
        const bytes = await http.bytes(joinUrl(options.baseUrl, filePath(image.fileId, "read")), request.signal);
        if (bytes.length > maxBytes) {
          out.push({ ...known, size: bytes.length });
          continue;
        }
        const name = `${image.fileId}-image.${sniffExtension(bytes)}`;
        out.push({ ...known, size: bytes.length, localPath: await saveAttachment(dir, image.fileId, name, bytes) });
        used += 1;
      } catch {
        out.push(known);
      }
    }
    return out;
  };

  const readOne = async (request: ReadRequest): Promise<Entity> => {
    const page = await fetchPage(viewPath(request.kind, request.id), request.signal);
    assertParsed(page, request.kind, request.id);
    const attachments = await download(page, request);
    const withFiles = { ...page, attachments };
    // 先预热人员反查表，映射层才能把「张三」换成 `zhangsan`。
    await users().warm();
    const context = {
      id: request.id,
      url: options.urlFor?.(request.kind, request.id),
      fallbackTitle: `${request.kind} #${request.id}`,
      resolveAccount: (realname: string) => users().resolveAccount(realname),
    };
    if (request.kind === "story") return toStoryFromPage(withFiles, context);
    if (request.kind === "task") return toTaskFromPage(withFiles, context);
    return toBugFromPage(withFiles, context);
  };

  return {
    name: "http",
    caps: CAPS,

    /**
     * 报告「已经观察到」的结构事实，不发起任何请求。
     *
     * 皮肤要等真读过一页才准，登录协议要等真登过一次才准——为了看一眼就多打两枪
     * 不值得，所以这里只交底，探测层拿不到就标「未确认」。
     */
    async discover(): Promise<DiscoveryReport> {
      return { ...observed };
    },

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (!options.baseUrl) return { ok: false, error: "未配置 http.baseUrl" };
      if (!options.account) return { ok: false, error: "未配置 http.account" };
      if (!options.password) return { ok: false, error: "未配置凭据 ZENTAO_PASSWORD" };
      if (signal?.aborted) return { ok: false, error: "已取消" };
      try {
        // 探活只验证「能登录 + 能取到一张页面」，不碰具体业务对象。
        const response = await current().get(joinUrl(options.baseUrl, "/index.php?m=my&f=index"), signal);
        const looksLikeLogin = /name=["']?password["']?/i.test(response.html) && /m=user&f=login/i.test(response.html);
        if (looksLikeLogin) return { ok: false, error: "登录后仍被重定向到登录页（账号无权限或密码错误）" };
        return { ok: true, detail: `${options.baseUrl}（账号 ${options.account}）` };
      } catch (error) {
        session = undefined;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async read(request: ReadRequest): Promise<EntityEnvelope> {
      try {
        const entity = await readOne(request);
        // 「附件字节拿不到」只在真的没拿全时才写进 missing——下载成功还留这句会误导模型。
        const allLocal =
          entity.attachments.length > 0 && entity.attachments.every((attachment) => attachment.localPath !== undefined);
        const missing = missingForHttp(request.kind).filter(
          (item) => !(item.startsWith("附件字节") && allLocal),
        );
        return { entity, source: "http", missing };
      } catch (error) {
        if (error instanceof ChannelError) throw error;
        throw new ChannelError("http", "read", `读取 ${request.kind}#${request.id} 失败：${message(error)}`, {
          cause: error,
        });
      }
    },

    async search(request: SearchRequest): Promise<SearchHit[]> {
      const http = current();
      const keyword = request.query.trim();
      if (!keyword) return [];
      const limit = Math.max(1, Math.min(request.limit, 50));
      try {
        const response = await http.get(
          joinUrl(options.baseUrl, `/index.php?m=search&f=index&q=${encodeURIComponent(keyword)}`),
          request.signal,
        );
        const hits: SearchHit[] = [];
        const seen = new Set<string>();
        // 搜索结果就是一堆指向详情页的链接；用领域链接识别，标题取链接文本。
        for (const match of response.html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
          const href = match[1] ?? "";
          const label = (match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          const target = entityFromHref(href);
          if (!target || !label) continue;
          if (request.kind && target.kind !== request.kind) continue;
          const key = `${target.kind}#${target.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ kind: target.kind, id: target.id, title: label.slice(0, 160) });
          if (hits.length >= limit) break;
        }
        return hits;
      } catch (error) {
        if (error instanceof ChannelError) throw error;
        throw new ChannelError("http", "search", `搜索「${keyword}」失败：${message(error)}`, { cause: error });
      }
    },

    async write(request: WriteRequest): Promise<WriteOutcome> {
      const http = current();
      // 写前快照要与读路径同口径（状态机器码 + 账号），先预热反查表。
      await users().warm();
      return writeViaHttp(
        {
          session: http,
          baseUrl: options.baseUrl,
          readEntity: (kind, id, signal) =>
            readEntityViaHttp(
              { baseUrl: options.baseUrl, urlFor: options.urlFor, resolveAccount: (r) => users().resolveAccount(r) },
              http,
              kind,
              id,
              signal,
            ),
        },
        request,
      );
    },

    async dispose(): Promise<void> {
      // 无长连接：cookie 在 session 里，随对象一起被回收。
      session = undefined;
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
