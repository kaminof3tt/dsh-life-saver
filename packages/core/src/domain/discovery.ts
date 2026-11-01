/**
 * 部署自探索。
 *
 * 换一台机器、换一套禅道，代码里写死的东西都会变成坑：详情页的类名、
 * 登录密码的算法、`keywords` 列在不在、需求挂项目的落点……这些**可以不问人**
 * 地在运行时探出来，于是做一层「探索 + 缓存」，取值按三层来：
 *
 *     覆盖层（用户显式配置） > 探索层（这里的探测结果） > 默认层（保守默认）
 *
 * 三条纪律（每条都对应一次实际踩过的坑）：
 *   1. 只在**已经配好**的连接上探结构：绝不猜 host / 库名 / 账号——
 *      猜错库不是「探不到」，是读到别人的单子。
 *   2. 探测失败不阻断读：退回默认层，由 zentao_status 明确标「结构未确认」，
 *      而不是静默地用错 SQL。
 *   3. 部署指纹（库地址+库名+表前缀 / 站点地址 / upload 根）一变就重探：
 *      同一份缓存套到另一套禅道上，比不探更危险。
 *
 * 探不了的（别假装能探）：UA、端口、库名、账号、密码。
 */

import type { LifeSaverConfig } from "../config.js";

/** 详情页正文的三种皮肤，按「新 → 老」排列；探测就是看哪一档先命中。 */
export type HttpSkin = "detail-section" | "detail" | "article";

/** 登录密码的算法：新版 md5(md5(pwd)+rand)，老版直接 md5(pwd)。 */
export type LoginFlow = "md5-rand" | "plain";

/** 需求「所属项目」的落点：老库有 zt_story.project，新库只靠 zt_projectstory。 */
export type ProjectSource = "story" | "relation" | "none";

/** 库侧结构。`confirmed=false` 表示这是默认值，不是探出来的。 */
export interface DbFeatures {
  /** 搜索时能不能用 `keywords LIKE ?`（老库没有这一列）。 */
  readonly hasKeywords: boolean;
  readonly projectSource: ProjectSource;
  readonly confirmed: boolean;
}

/** 探测失败时全部退回默认层：宁可多查一次关联表，也不能让读直接报错。 */
export const DEFAULT_DB_FEATURES: DbFeatures = {
  hasKeywords: true,
  projectSource: "relation",
  confirmed: false,
};

/** 一次部署的探测结果。字段都为「探到才有」。 */
export interface DiscoverySnapshot {
  /** 部署指纹，见 `fingerprintOf`。 */
  readonly fingerprint: string;
  /** 首次/最近一次探测时间（毫秒）。 */
  readonly at: number;
  readonly db?: DbFeatures;
  /** 库侧探测得到的事实（给人看，例如「取到 zt_story.project」）。 */
  readonly dbNotes: readonly string[];
  readonly skin?: HttpSkin;
  readonly loginFlow?: LoginFlow;
  /** 探测过程中的问题；status 原样展示。 */
  readonly warnings: readonly string[];
}

/** 通道 `discover()` 的返回值；service 负责合并进 store。 */
export interface DiscoveryReport {
  readonly db?: DbFeatures;
  readonly dbNotes?: readonly string[];
  readonly skin?: HttpSkin;
  readonly loginFlow?: LoginFlow;
  readonly warnings?: readonly string[];
}

/**
 * 部署指纹：只放「换了就该重探」的身份字段。
 *
 * 不含账号/密码/端口之外的量（账号变了结构不会变），也不含 timeout、limit
 * 这类调参——它们不改变禅道的结构。
 */
export function fingerprintOf(config: LifeSaverConfig): string {
  return JSON.stringify({
    db: [config.db.host, config.db.port, config.db.database, config.db.prefix],
    http: [normalizeUrl(config.http.baseUrl)],
    sftp: [config.sftp.host, config.sftp.uploadBase],
  });
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 覆盖层：用户显式配了就用它；留 auto 才轮到探索层。 */
export function resolveDbFeatures(config: LifeSaverConfig, snapshot?: DiscoverySnapshot): DbFeatures {
  const discovered = snapshot?.db;
  const hasKeywords =
    config.db.keywords === "on"
      ? true
      : config.db.keywords === "off"
        ? false
        : (discovered?.hasKeywords ?? DEFAULT_DB_FEATURES.hasKeywords);
  return {
    hasKeywords,
    projectSource: discovered?.projectSource ?? DEFAULT_DB_FEATURES.projectSource,
    // 用户手动指定的 keywords 也是「确认过的」；只有整层都没探到才算未确认。
    confirmed: discovered?.confirmed === true || config.db.keywords !== "auto",
  };
}

/** 皮肤同理：配了就用配置，没配就用探到的，都没探到返回 undefined。 */
export function resolveSkin(config: LifeSaverConfig, snapshot?: DiscoverySnapshot): HttpSkin | undefined {
  if (config.http.skin !== "auto") return config.http.skin;
  return snapshot?.skin;
}

/** 缓存是否过期。`ttlMs <= 0` 视为每次都重探。 */
export function isStale(snapshot: DiscoverySnapshot | undefined, now: number, ttlMs: number): boolean {
  if (!snapshot) return true;
  if (ttlMs <= 0) return true;
  return now - snapshot.at >= ttlMs;
}

/** 探测结果缓存。刻意做成纯内存：进程重启就重探一次，代价只有两条查询。 */
export class DiscoveryStore {
  private snapshot: DiscoverySnapshot | undefined;

  public constructor(private readonly now: () => number = () => Date.now()) {}

  /** 拿当前部署的快照；指纹不符时直接丢弃旧结论。 */
  public get(fingerprint: string): DiscoverySnapshot | undefined {
    if (!this.snapshot) return undefined;
    return this.snapshot.fingerprint === fingerprint ? this.snapshot : undefined;
  }

  /** 合并一次探测报告。指纹不符时从头开始，不继承上一套部署的结论。 */
  public merge(fingerprint: string, report: DiscoveryReport): DiscoverySnapshot {
    const base = this.get(fingerprint) ?? {
      fingerprint,
      at: this.now(),
      dbNotes: [],
      warnings: [],
    };
    const next: DiscoverySnapshot = {
      ...base,
      // 只有「这次真的探到了东西」才更新探测时间，避免失败也把 TTL 续上。
      at: report.db?.confirmed || report.skin || report.loginFlow ? this.now() : base.at,
      db: report.db ?? base.db,
      dbNotes: report.dbNotes ? unique([...base.dbNotes, ...report.dbNotes]) : base.dbNotes,
      skin: report.skin ?? base.skin,
      loginFlow: report.loginFlow ?? base.loginFlow,
      warnings: report.warnings ? unique([...base.warnings, ...report.warnings]) : base.warnings,
    };
    this.snapshot = next;
    return next;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}
