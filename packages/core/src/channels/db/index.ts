/**
 * DB + SFTP 通道：只读库取字段与备注，SFTP 取附件实体。
 *
 * 这是默认通道，理由很实际——它不需要禅道账号的页面权限，也不会在审计日志里
 * 留下「某人打开了所有需求」的痕迹；代价是字段口径依赖库版本，所以任何一条
 * 查询失败都要能被上层看见，而不是悄悄退回空值。
 *
 * 单条记录只查一次附件表：先按对象取 file 行，用它同时算出「附件清单」和
 * 「正文里内联图片的元信息」，再决定要不要把字节落到磁盘上。
 */

import type { LifeSaverConfig } from "../../config.js";
import { type DbFeatures, type DiscoveryReport } from "../../domain/discovery.js";
import type { Attachment, Entity, EntityEnvelope } from "../../domain/model.js";
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
import {
  findActions,
  findBug,
  findFiles,
  findLatestSpec,
  findName,
  findStory,
  findStoryTitle,
  findTask,
  ping,
  searchBugs,
  searchStories,
  searchTasks,
} from "./queries.js";
import { isImageFile, toAttachment, toBug, toStory, toTask } from "./map.js";
import { asDbError, openDb, type DbHandle } from "./pool.js";
import { probeSchema, type SchemaProbeResult } from "./schema.js";
import { openSftp, type SftpReader } from "./sftp.js";
import { collectWorklog } from "./stats.js";
import { writeViaDb } from "./write.js";
import type { WorklogQuery, WorklogReport } from "../stats.js";
import type { WriteOutcome, WriteRequest } from "../write.js";

export interface DbChannelOptions {
  readonly db: LifeSaverConfig["db"];
  readonly sftp: LifeSaverConfig["sftp"];
  readonly password: string;
  readonly sftpPassword: string;
  /** 生成实体链接；baseUrl 没配时返回 undefined。 */
  readonly urlFor?: (kind: "story" | "task" | "bug", id: number) => string | undefined;
  /** 写操作的执行者账号（写进 zt_action.actor 与 zt_effort.account）。 */
  readonly account?: string;
  /** 站点根地址，用于拼通知里的链接。 */
  readonly baseUrl?: string;
  /**
   * 当前生效的库结构特征（覆盖层 > 探索层 > 默认层）。
   * 由 service 解析后注入：通道只管用，不判断「该信配置还是信探测」。
   */
  readonly features?: () => DbFeatures;
}

const CAPS: ChannelCaps = {
  read: true,
  search: true,
  attachments: true,
  notes: true,
  estimates: true,
  // DB 线既能写也能统计；统计是它独有的能力（HTTP 页面没有按人按区间的口径）。
  write: true,
  stats: true,
};

export function createDbChannel(options: DbChannelOptions): Channel {
  let handle: Promise<DbHandle> | undefined;
  let sftp: Promise<SftpReader> | undefined;
  let schemaProbe: Promise<SchemaProbeResult> | undefined;
  /** 附件下载失败的原因（去重）；下载失败是「尽力而为」的，但用户得能看见为什么。 */
  const sftpFailures = new Set<string>();

  const db = (): Promise<DbHandle> => {
    // 先解释「你没配」，而不是让用户看一条 ECONNREFUSED——默认值连出来的错最容易误导人。
    if (!options.db.host) {
      return Promise.reject(
        new ChannelError("db", "config", "未配置 db.host：请在配置里填只读库地址（插件：设置页；MCP：环境变量 ZENTAO_DB_HOST）"),
      );
    }
    if (!options.db.user) {
      return Promise.reject(
        new ChannelError("db", "config", "未配置 db.user：请在配置里填只读库账号（插件：设置页；MCP：环境变量 ZENTAO_DB_USER）"),
      );
    }
    if (!options.password) {
      return Promise.reject(
        new ChannelError("db", "config", "未配置 ZENTAO_DB_PASSWORD：请填只读库密码（插件：凭据中心；MCP：环境变量 ZENTAO_DB_PASSWORD）"),
      );
    }
    handle ??= openDb({ db: options.db, password: options.password });
    // 打不开就丢掉缓存：用户补好密码后下一次调用要能重试，而不是一直撞同一个失败的 promise。
    handle.catch(() => {
      handle = undefined;
    });
    return handle;
  };

  const sftpReader = (): Promise<SftpReader> => {
    sftp ??= openSftp({
      host: options.sftp.host || options.db.host,
      port: options.sftp.port,
      user: options.sftp.user,
      password: options.sftpPassword,
      privateKeyPath: options.sftp.privateKeyPath || undefined,
      uploadBase: options.sftp.uploadBase,
    });
    return sftp;
  };

  /**
   * 库结构探测：两条 `information_schema` 查询，结果按连接缓存。
   * 通道换了（地址/库名/前缀变了）说明是另一套库，缓存自然作废。
   */
  const schema = (signal?: AbortSignal): Promise<SchemaProbeResult> => {
    schemaProbe ??= (async () => probeSchema(await db(), signal))();
    // 探测失败不钉死：下一次调用重试，而不是一直复读同一条 reject。
    schemaProbe.catch(() => {
      schemaProbe = undefined;
    });
    return schemaProbe;
  };

  /**
   * 当前生效的库结构特征。service 注入的解析结果是唯一来源：
   * 用户在配置里钉死的项优先，其次才是这里的探测结论。
   */
  const features = async (): Promise<DbFeatures> => options.features?.() ?? (await schema()).features;

  /**
   * 附件落盘。限额之外的、下载失败的都不抛错——用户至少能看到完整清单，
   * 只是没有本地路径。整条记录不会因为一个附件挂掉。
   */
  const download = async (
    files: Awaited<ReturnType<typeof findFiles>>,
    request: ReadRequest,
  ): Promise<Attachment[]> => {
    const dir = request.withAttachments ? request.attachmentDir : undefined;
    const budget = Math.max(0, request.maxAttachments);
    let downloaded = 0;
    let reader: SftpReader | undefined;
    const out: Attachment[] = [];

    for (const file of files) {
      // 和 `entity.attachments` 用同一份映射：两处各拼一次的话，同一张图在
      // 「清单里」和「落盘后」会显示成两个名字（一个带扩展名、一个不带）。
      const base: Attachment = toAttachment(file);
      const eligible =
        dir !== undefined &&
        downloaded < budget &&
        (file.size ?? 0) <= request.maxAttachmentBytes &&
        Boolean(file.pathname);
      if (!eligible || !dir) {
        out.push(base);
        continue;
      }
      try {
        reader ??= await sftpReader();
        const bytes = await reader.readFile(file.pathname as string, request.signal);
        out.push({ ...base, localPath: await saveAttachment(dir, file.id, base.filename, bytes) });
        downloaded += 1;
      } catch (error) {
        const reason = (error as Error).message;
        sftpFailures.add(reason);
        console.warn(`[life-saver] 附件 #${file.id} 下载失败：${reason}`);
        out.push(base);
      }
    }
    return out;
  };

  const readStory = async (request: ReadRequest) => {
    const dbh = await db();
    const row = await findStory(dbh, request.id, await features());
    if (!row) throw new ChannelError("db", "not-found", `库里没有需求 #${request.id}（或已删除）`);
    const [spec, files, actions, productName, moduleName] = await Promise.all([
      findLatestSpec(dbh, request.id),
      findFiles(dbh, "story", request.id),
      findActions(dbh, "story", request.id),
      findName(dbh, "product", row.product),
      findName(dbh, "module", row.module),
    ]);
    const entity = toStory({
      row,
      spec,
      files,
      actions,
      productName,
      moduleName,
      url: options.urlFor?.("story", row.id),
    });
    return { ...entity, attachments: await download(files, request) };
  };

  const readTask = async (request: ReadRequest) => {
    const dbh = await db();
    const row = await findTask(dbh, request.id);
    if (!row) throw new ChannelError("db", "not-found", `库里没有任务 #${request.id}（或已删除）`);
    const [files, actions, projectName, moduleName, storyTitle] = await Promise.all([
      findFiles(dbh, "task", request.id),
      findActions(dbh, "task", request.id),
      findName(dbh, "project", row.project),
      findName(dbh, "module", row.module),
      row.story ? findStoryTitle(dbh, row.story) : Promise.resolve(undefined),
    ]);
    const entity = toTask({
      row,
      files,
      actions,
      projectName,
      moduleName,
      storyTitle,
      url: options.urlFor?.("task", row.id),
    });
    return { ...entity, attachments: await download(files, request) };
  };

  const readBug = async (request: ReadRequest) => {
    const dbh = await db();
    const row = await findBug(dbh, request.id);
    if (!row) throw new ChannelError("db", "not-found", `库里没有 BUG #${request.id}（或已删除）`);
    const [files, actions, productName, projectName, moduleName] = await Promise.all([
      findFiles(dbh, "bug", request.id),
      findActions(dbh, "bug", request.id),
      findName(dbh, "product", row.product),
      findName(dbh, "project", row.project),
      findName(dbh, "module", row.module),
    ]);
    const entity = toBug({
      row,
      files,
      actions,
      productName,
      projectName,
      moduleName,
      url: options.urlFor?.("bug", row.id),
    });
    return { ...entity, attachments: await download(files, request) };
  };

  return {
    name: "db",
    caps: CAPS,

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (!options.db.host) return { ok: false, error: "未配置 db.host" };
      if (!options.db.user) return { ok: false, error: "未配置 db.user" };
      if (!options.password) return { ok: false, error: "未配置凭据 ZENTAO_DB_PASSWORD" };
      if (signal?.aborted) return { ok: false, error: "已取消" };
      try {
        const dbh = await db();
        await ping(dbh);
        // 探活顺手把结构探了：一次 status 就能给出「连得上 + 结构像不像禅道」，
        // 而不是等用户真去读一条才撞 SQL 错误。
        await schema(signal);
        const where = `${options.db.host}:${options.db.port}/${options.db.database}`;
        return {
          ok: true,
          detail: options.sftp.uploadBase
            ? where
            : `${where}（附件 SFTP 未配置 uploadBase，只能读文字，下载不了附件实体）`,
        };
      } catch (error) {
        // 探活失败后丢掉池，下次调用重新连，避免一次网络抖动把通道永久钉死。
        const pending = handle;
        handle = undefined;
        schemaProbe = undefined;
        void pending?.then((value) => value.close()).catch(() => undefined);
        return { ok: false, error: asDbError(error, "连接只读库").message };
      }
    },

    async read(request: ReadRequest): Promise<EntityEnvelope> {
      try {
        const entity =
          request.kind === "story"
            ? await readStory(request)
            : request.kind === "task"
              ? await readTask(request)
              : await readBug(request);
        return { entity: entity as Entity, source: "db" };
      } catch (error) {
        throw asDbError(error, `读取 ${request.kind}#${request.id}`);
      }
    },

    /**
     * 直接改库。整条动作在一个事务里完成，写入后立刻回读比对，
     * 任何一步不匹配都会回滚——所以「写了一半」的状态不会留在库里。
     */
    async write(request: WriteRequest): Promise<WriteOutcome> {
      if (!options.account) {
        throw new ChannelError(
          "db",
          "config",
          "未配置 http.account：数据库写需要它作为动作执行人（zt_action.actor）",
        );
      }
      const account = options.account;
      try {
        const dbh = await db();
        return await writeViaDb(
          { db: dbh, account, baseUrl: options.baseUrl ?? "" },
          request,
        );
      } catch (error) {
        throw asDbError(error, `写入 ${request.kind}#${request.id} 的「${request.action}」`);
      }
    },

    /** 工时统计：只有库能按人按区间精确汇总。 */
    async stats(query: WorklogQuery): Promise<WorklogReport> {
      try {
        return await collectWorklog(await db(), query);
      } catch (error) {
        throw asDbError(error, `统计 ${query.account} 的工时`);
      }
    },

    async search(request: SearchRequest): Promise<SearchHit[]> {
      try {
        const dbh = await db();
        const keyword = `%${request.query.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        const limit = Math.max(1, Math.min(request.limit, 50));
        // 搜索的 SQL 形状取决于库结构（有没有 keywords 列），取一次生效特征。
        const featuresNow = await features();
        const hits: SearchHit[] = [];

        if (!request.kind || request.kind === "story") {
          for (const row of await searchStories(dbh, keyword, limit, featuresNow)) {
            hits.push({
              kind: "story",
              id: row.id,
              title: row.title ?? `需求 #${row.id}`,
              status: row.status ?? undefined,
              assignedTo: row.assignedTo ?? undefined,
            });
          }
        }
        if (!request.kind || request.kind === "task") {
          for (const row of await searchTasks(dbh, keyword, limit)) {
            hits.push({
              kind: "task",
              id: row.id,
              title: row.name ?? `任务 #${row.id}`,
              status: row.status ?? undefined,
              assignedTo: row.assignedTo ?? undefined,
            });
          }
        }
        if (!request.kind || request.kind === "bug") {
          for (const row of await searchBugs(dbh, keyword, limit, featuresNow)) {
            hits.push({
              kind: "bug",
              id: row.id,
              title: row.title ?? `BUG #${row.id}`,
              status: row.status ?? undefined,
              assignedTo: row.assignedTo ?? undefined,
            });
          }
        }
        return hits.slice(0, limit);
      } catch (error) {
        throw asDbError(error, `搜索「${request.query}」`);
      }
    },

    /**
     * 结构探测（zentao_status 用）。`refresh` 强制重探，比如换库/换前缀之后点一下。
     * 探测失败只报 warning：status 的价值是把情况说清楚，而不是中断。
     */
    async discover(input?: { refresh?: boolean; signal?: AbortSignal }): Promise<DiscoveryReport> {
      if (input?.refresh) schemaProbe = undefined;
      try {
        const probe = await schema(input?.signal);
        // 附件下载失败也在这里露面：下载是尽力而为，但「为什么没落下来」得能看见。
        return {
          db: probe.features,
          dbNotes: probe.notes,
          warnings: [...probe.warnings, ...sftpFailures],
        };
      } catch (error) {
        return { warnings: [asDbError(error, "探测库结构").message, ...sftpFailures] };
      }
    },

    async dispose(): Promise<void> {
      const pending = [handle, sftp] as const;
      handle = undefined;
      sftp = undefined;
      for (const item of pending) {
        if (!item) continue;
        try {
          const value = await item;
          await value.close();
        } catch {
          // 关不掉也不影响退出；socket 会被进程回收。
        }
      }
    },
  };
}
