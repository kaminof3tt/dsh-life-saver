/**
 * 取数服务：把「配置 + 机密」翻译成一条可用的通道，并负责降级。
 *
 * 上层（工具、桥接路由）只跟这个类打交道，不知道底下是库还是页面。
 * 两条通道的实例按配置签名缓存：改地址/账号/密码会重建，改 limit 不会。
 */

import {
  channelSignature,
  normalizeBaseUrl,
  resolveMode,
  type ChannelMode,
  type LifeSaverConfig,
  type Secrets,
} from "./config.js";
import { createDbChannel } from "./channels/db/index.js";
import { createHttpChannel } from "./channels/http/index.js";
import {
  ChannelError,
  supportsWrite,
  type Channel,
  type ChannelCaps,
  type ProbeResult,
  type SearchHit,
} from "./channels/types.js";
import type { WriteAction, WriteOutcome, WriteRequest, WriteSnapshot } from "./channels/write.js";
import { ACTION_LABELS } from "./channels/write.js";
import type { WorklogQuery, WorklogReport } from "./channels/stats.js";
import type { ChannelName, EntityEnvelope, EntityKind } from "./domain/model.js";
import {
  DEFAULT_DB_FEATURES,
  DiscoveryStore,
  fingerprintOf,
  isStale,
  resolveDbFeatures,
  resolveSkin,
  type DbFeatures,
  type DiscoveryReport,
  type DiscoverySnapshot,
  type HttpSkin,
  type LoginFlow,
} from "./domain/discovery.js";
import { statusCode, STATUS_LABEL } from "./domain/labels.js";
import { renderEntity } from "./domain/render.js";

/** 给工具层用的稳定错误：code 固定，message 直接给人看。 */
export class LifeSaverError extends Error {
  public readonly code: string;
  /** 可选的可执行提示（设置页该填什么、换哪个通道）。 */
  public readonly hint?: string;

  public constructor(code: string, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LifeSaverError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ServiceDeps {
  /** 每次现取配置：volatile 字段会在设置页保存后变值，不能 apply 时缓存。 */
  readonly config: () => LifeSaverConfig;
  /** 每次现取机密：凭据中心写入后无需重启。 */
  readonly secrets: () => Promise<Secrets>;
  readonly logger?: { info?(message: string): void; warn?(message: string): void };
}

export interface ReadOptions {
  readonly kind: EntityKind;
  readonly id: number;
  readonly scope: "brief" | "full";
  readonly withAttachments: boolean;
  readonly attachmentDir?: string;
  readonly maxAttachments: number;
  readonly maxAttachmentBytes: number;
  readonly signal?: AbortSignal;
}

/** 一次读取的结果：结构化实体 + 已渲染的 markdown + 降级说明。 */
export interface ReadOutcome {
  readonly envelope: EntityEnvelope;
  readonly rendered: string;
  /** auto 模式下 db 挂了改用 http 的原因。 */
  readonly degraded?: { readonly from: ChannelName; readonly reason: string };
}

export interface SearchOutcome {
  readonly hits: readonly SearchHit[];
  readonly source: ChannelName;
  readonly degraded?: { readonly from: ChannelName; readonly reason: string };
}

/** 一次写操作的结果：写后回读的真实快照 + 降级说明。 */
export interface WriteResult {
  readonly outcome: WriteOutcome;
  /** mode=auto 时 http 挂了改用 db 的原因。 */
  readonly degraded?: { readonly from: ChannelName; readonly reason: string };
}

/** 单条通道的体检结果。 */
export interface ChannelHealth {
  readonly configured: boolean;
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly probe?: ProbeResult;
}

export interface StatusOutcome {
  readonly mode: ChannelMode;
  readonly http: ChannelHealth;
  readonly db: ChannelHealth;
  readonly caps?: Readonly<Record<ChannelName, ChannelCaps>>;
  /** 结构探测（自探索）的结论：三套皮肤/两种登录协议/库结构能力。 */
  readonly discovery: DiscoveryStatus;
}

/**
 * 给状态页看的一份「当前这台禅道长什么样」。
 *
 * 刻意把「探到的」和「生效的」放在一起：`db`/`skin` 是覆盖层应用后的生效值，
 * `confirmed` 说明这个值是探出来的还是默认值——两者混着看才不会误以为是确定的。
 */
export interface DiscoveryStatus {
  readonly enabled: boolean;
  /** 人可读的部署坐标（库 + 站点），指纹变了就是换了部署。 */
  readonly where: string;
  readonly fingerprint: string;
  readonly db: DbFeatures;
  /** 生效的页面皮肤；没探到也没配就是 undefined。 */
  readonly skin?: HttpSkin;
  readonly loginFlow?: LoginFlow;
  /** 库侧探到的事实（人类语言）。 */
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  /** 库结构是否真被探过。false = 正在用默认值。 */
  readonly confirmed: boolean;
  /** 最近一次有效探测的时间（毫秒）。 */
  readonly probedAt?: number;
  /** 缓存是否已过期（下次体检会重探）。 */
  readonly stale: boolean;
}

interface CachedChannels {
  readonly signature: string;
  readonly db: Channel;
  readonly http: Channel;
}

export class LifeSaverService {
  private cached: CachedChannels | undefined;
  private disposed = false;
  /**
   * 探到的部署结构（皮肤/登录协议/库列能力）。
   *
   * 放内存不落盘：换机器本来就要重探，而同一台机器上进程重启也不过两条查询，
   * 落盘反而带来「配置改了缓存还在」的坑。
   */
  private readonly discovery = new DiscoveryStore();

  public constructor(private readonly deps: ServiceDeps) {}

  /** 当前生效的配置（已解包）。 */
  public config(): LifeSaverConfig {
    return this.deps.config();
  }

  public async secrets(): Promise<Secrets> {
    return await this.deps.secrets();
  }

  /**
   * 拿到一对通道实例（不一定都能用：没配的那条 created 但调用会报 config 错）。
   * 签名变化时先释放旧实例，避免连接池泄漏。
   */
  private async channels(): Promise<CachedChannels> {
    return await this.channelsFor(this.config(), await this.secrets());
  }

  /** 当前部署的探测快照（指纹不符时为 undefined，避免把别套禅道的结论套上来）。 */
  private snapshot(config: LifeSaverConfig): DiscoverySnapshot | undefined {
    return this.discovery.get(fingerprintOf(config));
  }

  /**
   * 读路径要用的库结构能力。
   *
   * 自探索关掉就退回默认层：默认层故意取「新库形态」（有 keywords、走关联表），
   * 因为读错列会直接 SQL 报错，比静默读到空正文更容易被发现。
   * 这里不发查询——通道内部自己有探针缓存，探测只发生在体检时。
   */
  private dbFeatures(config: LifeSaverConfig): DbFeatures {
    if (!config.discovery.enabled) return DEFAULT_DB_FEATURES;
    return resolveDbFeatures(config, this.snapshot(config));
  }

  /** 读路径要用的皮肤偏好（配置钉死优先，其次探索层）。 */
  private skin(config: LifeSaverConfig): HttpSkin | undefined {
    if (!config.discovery.enabled) return undefined;
    return resolveSkin(config, this.snapshot(config));
  }

  /**
   * 用给定配置建（或复用）一对通道。
   * 设置页「测试连接」会把还没保存的草稿合成进来，所以配置得能从外面传，
   * 不能只读 `this.config()`；缓存仍按签名走，草稿探活不会顶掉正式实例。
   */
  private async channelsFor(config: LifeSaverConfig, secrets: Secrets): Promise<CachedChannels> {
    const signature = channelSignature(config, secrets);
    if (this.cached && this.cached.signature === signature) return this.cached;

    const previous = this.cached;
    this.cached = undefined;
    if (previous) {
      // 释放旧实例不阻塞新请求：连接会自己超时，日志里留一条即可。
      void Promise.all([previous.db.dispose(), previous.http.dispose()]).catch(() => undefined);
    }

    const urlFor = makeUrlFor(config);
    const db = createDbChannel({
      db: config.db,
      sftp: config.sftp,
      password: secrets.dbPassword,
      sftpPassword: secrets.sftpPassword,
      urlFor,
      // 写库需要执行人账号与站点地址（拼通知链接）；读路径用不到这两个。
      account: config.http.account,
      baseUrl: normalizeBaseUrl(config.http.baseUrl),
      // 结构能力用回调而不是快照值：体检探到新结论后，已缓存的通道实例要能跟着变，
      // 否则「改了配置但连接还用旧的」这类问题又要靠重启解决。
      features: () => this.dbFeatures(config),
    });
    const http = createHttpChannel({
      baseUrl: normalizeBaseUrl(config.http.baseUrl),
      account: config.http.account,
      password: secrets.httpPassword,
      timeoutMs: config.http.timeoutMs,
      urlFor,
      skin: () => this.skin(config),
    });
    this.cached = { signature, db, http };
    return this.cached;
  }

  /** 当前模式允许尝试的通道顺序。 */
  private order(mode: ChannelMode): ChannelName[] {
    return mode === "auto" ? ["db", "http"] : [mode];
  }

  /**
   * 体检：配了没、能不能连。探活并发跑，单个失败不影响另一个。
   * `override` 是设置页里还没保存的草稿（见 `applyOverrides`）：只影响这一次探活，
   * 不写配置、不影响之后工具调用读到的值。
   */
  public async status(signal?: AbortSignal, override?: LifeSaverConfig): Promise<StatusOutcome> {
    const config = override ?? this.config();
    const secrets = await this.secrets();
    const channels = await this.channelsFor(config, secrets);
    const [httpProbe, dbProbe] = await Promise.all([
      probeSafely(channels.http, signal),
      probeSafely(channels.db, signal),
    ]);
    const discovery = await this.discover(config, channels, { http: httpProbe, db: dbProbe }, signal);
    return {
      mode: resolveMode(config.mode),
      http: channelHealth(config, secrets, "http", httpProbe),
      db: channelHealth(config, secrets, "db", dbProbe),
      caps: { http: channels.http.caps, db: channels.db.caps },
      discovery,
    };
  }

  /**
   * 结构探测：只在体检时做，且只探**已经探通**的那条通道。
   *
   * 这是整个自探索的安全边界——没配好/连不通时绝不猜 host、库名、账号。
   * 猜错库的后果是读到别人公司的单子，比读不到严重得多。
   * 探测预算：库侧两条 information_schema、页面侧零额外请求（皮肤与登录协议
   * 是读页面/登录取 cookie 时顺手记下的真值）。
   */
  private async discover(
    config: LifeSaverConfig,
    channels: CachedChannels,
    probes: { http: ProbeResult; db: ProbeResult },
    signal?: AbortSignal,
  ): Promise<DiscoveryStatus> {
    const fingerprint = fingerprintOf(config);
    const enabled = config.discovery.enabled;
    const existing = this.snapshot(config);
    let snapshot = existing;

    if (enabled) {
      // 缓存没过期就不重探：两条查询也是钱，体检不该每次都打。
      // 首次（没有快照）交给 probe 内建的 schema() 顺手探——通道里已经缓存，不重复打。
      const stale = isStale(existing, Date.now(), config.discovery.ttlMs);
      const refresh = Boolean(existing) && stale;
      const [dbReport, httpReport] = await Promise.all([
        probes.db.ok ? safeDiscover(channels.db, { refresh, signal }) : Promise.resolve(undefined),
        probes.http.ok ? safeDiscover(channels.http, { signal }) : Promise.resolve(undefined),
      ]);
      for (const report of [dbReport, httpReport]) {
        if (report) snapshot = this.discovery.merge(fingerprint, report);
      }
    }

    const scope = enabled ? snapshot : undefined;
    const db = resolveDbFeatures(config, scope);
    return {
      enabled,
      where: whereOf(config),
      fingerprint,
      db,
      skin: resolveSkin(config, scope),
      loginFlow: scope?.loginFlow,
      notes: scope?.dbNotes ?? [],
      warnings: scope?.warnings ?? [],
      confirmed: db.confirmed,
      probedAt: scope?.at,
      stale: enabled ? isStale(snapshot, Date.now(), config.discovery.ttlMs) : false,
    };
  }

  /** 读一条实体。auto 下 db 失败自动换 http，并把原因带回去。 */
  public async read(options: ReadOptions): Promise<ReadOutcome> {
    const mode = resolveMode(this.config().mode);
    const channels = await this.channels();
    const order = this.order(mode);
    let degraded: ReadOutcome["degraded"];

    for (const [index, name] of order.entries()) {
      try {
        const envelope = await channels[name].read({
          kind: options.kind,
          id: options.id,
          withAttachments: options.withAttachments,
          attachmentDir: options.attachmentDir,
          maxAttachments: options.maxAttachments,
          maxAttachmentBytes: options.maxAttachmentBytes,
          signal: options.signal,
        });
        const rendered = renderEntity(envelope, options.scope);
        return degraded ? { envelope, rendered, degraded } : { envelope, rendered };
      } catch (error) {
        const reason = describeError(error);
        this.deps.logger?.warn?.(`life-saver: ${name} 读取 ${options.kind}#${options.id} 失败：${reason}`);
        const isLast = index === order.length - 1;
        if (isLast) throw toLifeSaverError(error, options.kind, options.id, order, degraded);
        degraded = { from: name, reason };
      }
    }
    // order 不为空，走不到这里；给 TS 一个兜底。
    throw new LifeSaverError("internal", "没有可用的取数通道");
  }

  /** 搜索。降级规则同 read。 */
  public async search(query: string, kind: EntityKind | undefined, limit: number, signal?: AbortSignal): Promise<SearchOutcome> {
    const mode = resolveMode(this.config().mode);
    const channels = await this.channels();
    const order = this.order(mode);
    let degraded: SearchOutcome["degraded"];

    for (const [index, name] of order.entries()) {
      try {
        const hits = await channels[name].search({ query, kind, limit, signal });
        return degraded ? { hits, source: name, degraded } : { hits, source: name };
      } catch (error) {
        const reason = describeError(error);
        this.deps.logger?.warn?.(`life-saver: ${name} 搜索「${query}」失败：${reason}`);
        if (index === order.length - 1) throw toLifeSaverError(error, undefined, undefined, order);
        degraded = { from: name, reason };
      }
    }
    throw new LifeSaverError("internal", "没有可用的取数通道");
  }

  /**
   * 写通道顺序：与读**相反**。
   * 页面路径（http）走禅道自己的业务逻辑，history、通知、看板泳道都由它写全，
   * 所以默认它优先；库路径（db）作为降级，快但要自己复刻 7 张表的副作用。
   */
  private writeOrder(mode: string): ChannelName[] {
    return mode === "auto" ? ["http", "db"] : mode === "db" ? ["db"] : ["http"];
  }

  /**
   * 跑一条写动作。
   *
   * 这里是「默认真写」的，所以护栏全压在这一个函数里：
   * 写前先读（拿到 before 快照，也是归属与状态校验的依据）、
   * 状态白名单、归属校验、expectStatus 断言、写后由通道回读自校验、
   * 以及只允许单条操作（本函数签名里就没有批量入口）。
   */
  public async write(request: WriteRequest): Promise<WriteResult> {
    const config = this.config();
    if (!config.write.enabled) {
      throw new LifeSaverError(
        "write-disabled",
        "写能力已被关闭（write.enabled=false），当前只能读。",
        "打开配置里的「允许写入」（插件：设置页 → 写入；MCP：环境变量 ZENTAO_WRITE_ENABLED=1）。",
      );
    }
    const { kind, id, action } = request;
    if (kind !== "task" && kind !== "bug") {
      throw new LifeSaverError("bad-args", `不支持的写入类型：${String(kind)}`);
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new LifeSaverError("bad-args", `编号不合法：${String(id)}`);
    }
    if (!supportsWrite(kind, action)) {
      throw new LifeSaverError("bad-args", `${kindLabel(kind)} 不支持动作「${String(action)}」`);
    }

    // 写前读：before 快照 + 归属/状态校验的唯一依据。
    const before = await this.read({
      ...this.baseReadOptions(),
      kind,
      id,
      scope: "full",
      withAttachments: false,
      signal: request.signal,
    });
    const entity = before.envelope.entity;
    // 两条通道的口径差别就卡在这里：DB 线给 `doing`，HTTP 线给「进行中」。
    // 护栏一律用机器码比；取不到机器码就退回原值，宁可放行也不误杀整条写路径。
    const status = entity.codes?.status ?? statusCode(entity.status) ?? (entity.status ?? "");
    const assignedTo = entity.codes?.assignedTo ?? entity.assignedTo ?? "";
    const openedBy = entity.codes?.openedBy ?? entity.openedBy ?? "";
    const account = config.http.account;

    assertAllowedStatus(kind, action, status);
    if (request.expectStatus !== undefined && !sameStatus(request.expectStatus, status)) {
      throw new LifeSaverError(
        "expect-mismatch",
        `${kindLabel(kind)} #${id} 的当前状态是「${entity.status ?? status ?? "未知"}」，与断言的「${request.expectStatus}」不符，已拒绝执行。`,
        "确认是不是这条记录，或去掉 expectStatus 再试。",
      );
    }
    if (!config.write.allowOthers && account) {
      const owners = new Set([assignedTo, openedBy].filter((value) => value !== "" && value !== "closed"));
      // 归属校验只在「确实拿到了账号」时才敢下结论。
      // HTTP 线的人员字段本来是中文名，靠 userPairs 反查才有账号；反查表万一取不到，
      // 这里手上就是「张三」这种显示名，跟 `zhangsan` 一比必然不等——照这么拒绝，
      // 等于反查失败就把整条写路径封死。宁可这一道放松（还有状态白名单与写后自校验兜着），
      // 也不要给出「你不是自己的任务的负责人」这种荒谬结论。
      const known = [...owners].every((value) => isAccountLike(value));
      if (known && owners.size > 0 && !owners.has(account)) {
        throw new LifeSaverError(
          "not-owner",
          `${kindLabel(kind)} #${id} 的指派人是「${entity.assignedTo ?? "空"}」、创建人是「${entity.openedBy ?? "空"}」，都不是当前账号 ${account}，已拒绝执行。`,
          "确需代别人操作时，打开配置里的 write.allowOthers。",
        );
      }
    }

    const channels = await this.channels();
    const order = this.writeOrder(config.write.mode);
    let degraded: WriteResult["degraded"];

    for (const [index, name] of order.entries()) {
      const channel = channels[name];
      if (typeof channel.write !== "function") {
        degraded = { from: name, reason: "该通道没有实现写入" };
        if (index === order.length - 1) {
          throw new LifeSaverError("write-disabled", `${name} 通道不支持写入`);
        }
        continue;
      }
      try {
        const outcome = await channel.write(request);
        this.deps.logger?.info?.(
          `life-saver: ${name} 写入 ${kind}#${id}「${ACTION_LABELS[action] ?? String(action)}」成功`,
        );
        return degraded ? { outcome, degraded } : { outcome };
      } catch (error) {
        const reason = describeError(error);
        this.deps.logger?.warn?.(`life-saver: ${name} 写入 ${kind}#${id} 失败：${reason}`);
        // 业务拒绝（状态不符、必填缺失）换条通道也是同样结果，不必再试。
        if (error instanceof ChannelError && error.code === "write-rejected") {
          throw new LifeSaverError("write-rejected", reason);
        }
        if (index === order.length - 1) {
          throw toLifeSaverError(error, kind, id, order, degraded);
        }
        degraded = { from: name, reason };
      }
    }
    throw new LifeSaverError("internal", "没有可用的写入通道");
  }

  /** 工时统计：只走库（页面没有「按人按区间」的聚合口径）。 */
  public async stats(query: WorklogQuery): Promise<WorklogReport> {
    const channels = await this.channels();
    const channel = channels.db;
    if (typeof channel.stats !== "function") {
      throw new LifeSaverError("stats-unavailable", "当前配置下没有可用的统计通道", "统计需要配置只读库（db.host / db.user / ZENTAO_DB_PASSWORD）。");
    }
    try {
      return await channel.stats(query);
    } catch (error) {
      throw toLifeSaverError(error, undefined, undefined, ["db"]);
    }
  }

  /** 按 id 找关联对象：任务→需求、BUG→任务/需求。 */
  public async relatedOf(envelope: EntityEnvelope, limit: number, signal?: AbortSignal): Promise<ReadOutcome[]> {
    const entity = envelope.entity;
    const targets: ReadOptions[] = [];
    const base = this.baseReadOptions();
    const push = (kind: EntityKind, id: number | undefined): void => {
      if (id === undefined || id <= 0) return;
      if (targets.some((item) => item.kind === kind && item.id === id)) return;
      targets.push({ ...base, kind, id, withAttachments: false, attachmentDir: undefined, signal });
    };

    if (entity.kind === "task") push("story", entity.storyId);
    if (entity.kind === "bug") {
      push("task", entity.taskId);
      push("story", entity.storyId);
    }
    if (entity.kind === "story") push("story", entity.parent);

    const out: ReadOutcome[] = [];
    for (const target of targets.slice(0, Math.max(0, limit))) {
      try {
        out.push(await this.read({ ...target, scope: "full" }));
      } catch (error) {
        this.deps.logger?.warn?.(`life-saver: 关联 ${target.kind}#${target.id} 取不到：${describeError(error)}`);
      }
    }
    return out;
  }

  /** 关联对象用的默认参数（不含 kind/id）。 */
  private baseReadOptions(): Omit<ReadOptions, "kind" | "id"> {
    const config = this.config();
    return {
      scope: "full",
      withAttachments: false,
      maxAttachments: config.limits.maxAttachments,
      maxAttachmentBytes: config.limits.maxAttachmentBytes,
    };
  }

  /** 当前模式下的取数上限（工具层拼参数时用）。 */
  public limits(): { maxAttachments: number; maxAttachmentBytes: number; maxRelated: number } {
    const config = this.config();
    return {
      maxAttachments: config.limits.maxAttachments,
      maxAttachmentBytes: config.limits.maxAttachmentBytes,
      maxRelated: config.limits.maxRelated,
    };
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const cached = this.cached;
    this.cached = undefined;
    if (!cached) return;
    await Promise.allSettled([cached.db.dispose(), cached.http.dispose()]);
  }
}

/** 实体在禅道网页里的地址；没配 baseUrl 就不给链接。 */
function makeUrlFor(config: LifeSaverConfig): ((kind: EntityKind, id: number) => string | undefined) | undefined {
  const base = normalizeBaseUrl(config.http.baseUrl);
  if (!base) return undefined;
  return (kind, id) => `${base}/index.php?m=${kind}&f=view&${kind}ID=${id}`;
}

/**
 * 一条通道的体检结论。
 *
 * `configured` 与 `ready` 是**两个**问题，不能写成同一个表达式：
 *   - configured：配置与凭据填齐了没有；
 *   - ready：填齐了**并且**刚探活通过。
 * 之前两者都算成「填齐了」，于是设置页会同时显示「可用 · 探活 ❌」——
 * 一道自相矛盾的结论，用户只能猜哪个是真的。
 */
function channelHealth(
  config: LifeSaverConfig,
  secrets: Secrets,
  name: ChannelName,
  probe: ProbeResult,
): ChannelHealth {
  const missing: string[] = [];
  if (name === "http") {
    if (!config.http.baseUrl) missing.push("http.baseUrl");
    if (!config.http.account) missing.push("http.account");
    if (!secrets.httpPassword) missing.push("ZENTAO_PASSWORD");
  } else {
    if (!config.db.host) missing.push("db.host");
    if (!config.db.user) missing.push("db.user");
    if (!secrets.dbPassword) missing.push("ZENTAO_DB_PASSWORD");
  }
  const configured = missing.length === 0;
  return { configured, ready: configured && probe.ok, missing, probe };
}

async function probeSafely(channel: Channel, signal?: AbortSignal): Promise<ProbeResult> {
  if (signal?.aborted) return { ok: false, error: "已取消" };
  try {
    return await channel.probe(signal);
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * 探测失败不能拖垮体检：把原因降级成一条 warning 塞回去。
 * 探测的定位是「锦上添花」——它挂了，读路径退回默认层继续能用。
 */
async function safeDiscover(
  channel: Channel,
  options: { refresh?: boolean; signal?: AbortSignal },
): Promise<DiscoveryReport | undefined> {
  if (!channel.discover) return undefined;
  try {
    return await channel.discover(options);
  } catch (error) {
    return { warnings: [`${channel.name} 结构探测失败：${describeError(error)}（本次使用默认结构）`] };
  }
}

/** 状态页要用的人可读部署坐标：换机器时第一眼要能确认「连的是哪套禅道」。 */
function whereOf(config: LifeSaverConfig): string {
  const db = config.db.host ? `${config.db.host}:${config.db.port}/${config.db.database}` : "未配数据库";
  const site = normalizeBaseUrl(config.http.baseUrl) || "未配站点";
  return `${db} · ${site}`;
}

function describeError(error: unknown): string {
  if (error instanceof ChannelError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function kindLabel(kind: "task" | "bug"): string {
  return kind === "task" ? "任务" : "BUG";
}

/**
 * 状态白名单：只在对的状态上执行动作。
 *
 * 这是「默认真写」下最省事的一道保险——禅道自己的页面也会挡，
 * 但库通道是直接改数据，没人替我们挡。
 */
function assertAllowedStatus(kind: "task" | "bug", action: WriteAction, status: string): void {
  const label = kindLabel(kind);
  const allow = ALLOWED_STATUS[kind][action];
  if (!allow || allow.length === 0) return;
  if (allow.includes(status)) return;
  throw new LifeSaverError(
    "status-mismatch",
    `${label}当前状态是「${STATUS_LABEL[status] ?? (status || "未知")}」，不能执行「${ACTION_LABELS[action] ?? String(action)}」。允许的状态：${allow.join(" / ")}。`,
    "先刷新一下这条记录；状态确实不对就先用禅道页面把状态改过来。",
  );
}

/**
 * `expectStatus` 的比较：断言值可能是机器码（`doing`）也可能是中文（`进行中`），
 * 当前状态同理，两者都归一到机器码再比，谁也不会因为写法不同被误判。
 */
function sameStatus(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const left = statusCode(expected);
  const right = statusCode(actual);
  return left !== undefined && left === right;
}

/**
 * 这个值看起来像禅道账号吗（纯 ASCII 标识符）？
 *
 * 用来判断归属校验能不能下结论：账号是 `zhangsan` 这种，显示名是「张三」。
 * 看到中文名就说明「显示名 → 账号」的反查没做成，此时不该拿它去比账号。
 */
function isAccountLike(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

/** 各动作允许的前置状态（来自禅道 control/model 层的校验，逐条对齐）。 */
const ALLOWED_STATUS: Readonly<
  Record<"task" | "bug", Partial<Record<WriteAction, readonly string[]>>>
> = {
  task: {
    start: ["wait"],
    recordworkhour: ["wait", "doing", "pause"],
    finish: ["doing", "wait", "pause"],
    pause: ["doing"],
    activate: ["pause", "done", "cancel", "closed"],
    close: ["done", "cancel"],
    cancel: ["wait", "doing", "pause", "done"],
    comment: [],
  },
  bug: {
    confirm: ["active"],
    resolve: ["active"],
    close: ["resolved"],
    // 日志（工时）在禅道侧只对未关闭的 BUG 开放；closed 的 BUG 详情页没有「日志」按钮。
    recordworkhour: ["active", "resolved"],
    comment: [],
  },
};

/** 通道自己的错误里已经带过一次「bug#5967失败：」，外层再说一遍就啰嗦了。 */
function trimEntityPrefix(reason: string, target: string): string {
  const body = reason.replace(/^读取\s*/, "");
  const prefix = `${target}失败：`;
  return body.startsWith(prefix) ? body.slice(prefix.length) : body;
}

/**
 * 通道错误 → 工具错误。
 * 保留原始 code（not-found / config / connect …），并补一句「该去设置页改什么」。
 */
function toLifeSaverError(
  error: unknown,
  kind: EntityKind | undefined,
  id: number | undefined,
  tried: readonly ChannelName[],
  previous?: { readonly from: ChannelName; readonly reason: string },
): LifeSaverError {
  const target = kind !== undefined && id !== undefined ? `${kind}#${id}` : "目标";
  if (error instanceof LifeSaverError) return error;
  if (error instanceof ChannelError) {
    const hint =
      error.code === "config"
        ? "补齐对应通道设置（插件：设置页；MCP：ZENTAO_BASE_URL / ZENTAO_DB_HOST 等环境变量），密码填在凭据中心或环境变量。"
        : error.code === "not-found"
          ? "确认编号是否正确，或换 mode=http 用网页通道再试。"
          : undefined;
    // 降级链上每一条都要交代：只说「已尝试 db → http」等于没说为什么 db 不行。
    const suffix =
      tried.length > 1
        ? `（已尝试：${tried.join(" → ")}${previous ? `；${previous.from} 的原因：${trimEntityPrefix(previous.reason, target)}` : ""}）`
        : "";
    return new LifeSaverError(error.code, `${target}：${error.message}${suffix}`, hint, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LifeSaverError("internal", `${target}：${message}`, undefined, { cause: error });
}
