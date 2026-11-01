/**
 * 宿主侧 bridge：给插件页那张自建表单补三块「配置页给不了」的能力。
 *
 * 配置本身走 DSH 的配置镜像（页面拿到 `form.state` / `form.mutate`），
 * 正常情况下不经过这里；这里负责三件镜像覆盖不到的事：
 *   1. 三个密码放进凭据中心（不出现在配置、不落进 cordis.patch.yml）
 *   2. 「测试连接」——真连一次禅道，把 db / http 两条通道的探活结果给页面，
 *      并且认页面里还没保存的草稿（`overrides`），不然填完还得先存才测得动
 *   3. 保存兜底：直接调宿主 `settings.mutate` 并把原始错误原样回给页面
 *      （`form.mutate` 失败只回一个 false，用户看到的永远是同一句话，查不动）
 *
 * 路由前缀 `/api/dsh-life-saver`，全部 POST + JSON：
 *   POST /credentials-status  三个密码是否已配置（含环境变量兜底标记）
 *   POST /credentials-set     写一个密码（ref 走白名单）
 *   POST /credentials-unset   删一个密码
 *   POST /test                探活（可带 `overrides` 草稿）
 *   POST /config-set          写配置（`{ops, revision}`）
 *   POST /config-describe     宿主眼里这一行的配置快照（诊断用）
 *   POST /session-targets     目标表 + 已登记工作区（页面下拉框用）
 *   POST /session-start       人在页面上点「在新会话处理」——真正开新会话
 *   POST /session-probe       只探测/同步仓库，不建会话（试运行）
 *
 * 安全：只接受本机/同源请求，ref、命名空间、配置路径全部白名单校验。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SECRET_REFS, applyOverrides, type LifeSaverConfig, type Secrets } from "life-saver-core/config.js";
import type { LifeSaverService, StatusOutcome } from "life-saver-core/service.js";
import { isEntityKind } from "life-saver-core/domain/model.js";
import {
  describeTargets,
  startSession,
  type SessionControllerLike,
  type StartRequest,
  type WorkspaceRegistryLike,
} from "../session/launcher.js";

/** 统一前缀。客户端 `src/client/index.jsx` 里必须写同一个值。 */
export const BRIDGE_PREFIX = "/api/dsh-life-saver";

/** 请求体上限：表单只有几十个字段，1MB 足够。 */
const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** 探活超时：别把浏览器吊死。 */
const PROBE_TIMEOUT_MS = 30_000;

/** `webServer.register` 接受的路由形状（只用到 exact）。 */
export interface BridgeRoute {
  readonly kind: "exact";
  readonly path: string;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** 凭据中心服务，只声明用到的方法。 */
export interface CredentialsLike {
  describe(ref: string): Promise<{ readonly configured?: boolean } | undefined>;
  /** 读明文；只有本插件自己用，桥接路由永不返回它。 */
  resolve(ref: string): Promise<{ readonly value?: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** 宿主设置服务，只声明本插件用到的两个方法。 */
export interface SettingsLike {
  /** 读当前配置快照：`/config-describe` 用它把「宿主眼里这一行到底是什么」摊给页面。 */
  describe(): readonly { readonly ns: string; readonly revision: number; readonly value?: unknown }[];
  /** 提交一串 `{op:'set'|'unset', path:[...], value?}`；版本对不上会抛冲突错误。 */
  mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<unknown>;
}

export interface BridgeDeps {
  /** 凭据中心：可能晚于本插件挂载，所以每次现取。 */
  readonly credentials: () => CredentialsLike | undefined;
  /** 取数服务：`/test` 用它真连一次禅道。 */
  readonly service: LifeSaverService;
  /** 机密现取（凭据中心 → 环境变量兜底）。 */
  readonly secrets: () => Promise<Secrets>;
  /** 当前生效的配置（`/test` 的草稿覆盖以它为底）。 */
  readonly config: () => LifeSaverConfig;
  /** 宿主设置服务：可能晚于本插件挂载，所以每次现取。 */
  readonly settings: () => SettingsLike | undefined;
  /** 宿主工作区注册表 / 会话控制器：`/session-*` 用；缺了就报人话。 */
  readonly workspaceRegistry: () => WorkspaceRegistryLike | undefined;
  readonly sessionController: () => SessionControllerLike | undefined;
  /** 本插件在 profile 里的行 id，也就是设置命名空间（`life-saver`）。 */
  readonly namespace: string;
}

/** 生成全部桥接路由。 */
export function makeBridgeRoutes(deps: BridgeDeps): BridgeRoute[] {
  const handlers = {
    async credentialsStatus() {
      const credentials = deps.credentials();
      const secrets = await deps.secrets().catch(() => undefined);
      const configured: Record<string, boolean> = {};
      for (const ref of Object.values(SECRET_REFS)) {
        if (credentials === undefined) {
          configured[ref] = false;
          continue;
        }
        try {
          const info = await credentials.describe(ref);
          configured[ref] = info?.configured === true;
        } catch {
          configured[ref] = false;
        }
      }
      return {
        ok: true,
        value: {
          available: credentials !== undefined,
          configured,
          // 环境变量兜底也算「有值」，但页面要能区分来源
          fromEnv: {
            [SECRET_REFS.httpPassword]: (secrets?.httpPassword ?? "").length > 0,
            [SECRET_REFS.dbPassword]: (secrets?.dbPassword ?? "").length > 0,
            [SECRET_REFS.sftpPassword]: (secrets?.sftpPassword ?? "").length > 0,
          },
        },
      };
    },

    async credentialsSet(request: unknown) {
      const credentials = deps.credentials();
      if (credentials === undefined) {
        return { ok: false, code: "credentials-unavailable", message: "凭据服务尚未就绪，稍后重试" };
      }
      const body = asRecord(request);
      const key = String(body?.key ?? "");
      const ref = allowedRef(key);
      if (ref === undefined) return { ok: false, code: "credentials-rejected", message: `未知的凭据 key: ${key}` };
      const value = body?.value;
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, code: "credentials-rejected", message: "密码不能为空" };
      }
      try {
        await credentials.set(ref, value.trim());
        return { ok: true, value: { ref, set: true } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: messageOf(error) };
      }
    },

    async credentialsUnset(request: unknown) {
      const credentials = deps.credentials();
      if (credentials === undefined) {
        return { ok: false, code: "credentials-unavailable", message: "凭据服务尚未就绪，稍后重试" };
      }
      const body = asRecord(request);
      const key = String(body?.key ?? "");
      const ref = allowedRef(key);
      if (ref === undefined) return { ok: false, code: "credentials-rejected", message: `未知的凭据 key: ${key}` };
      try {
        await credentials.unset(ref);
        return { ok: true, value: { ref, set: false } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: messageOf(error) };
      }
    },

    /** 真连一次禅道：两条通道各自探活，结果原样给页面。草稿优先于已保存的配置。 */
    async test(request: unknown) {
      const body = asRecord(request);
      const overrides = body?.overrides;
      let effective: LifeSaverConfig | undefined;
      if (overrides !== undefined && overrides !== null) {
        if (typeof overrides !== "object" || Array.isArray(overrides)) {
          return { ok: false, code: "probe-rejected", message: "overrides 必须是对象" };
        }
        try {
          effective = applyOverrides(deps.config(), overrides);
        } catch (error) {
          return { ok: false, code: "probe-rejected", message: `草稿配置不合法：${messageOf(error)}` };
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const status = await deps.service.status(controller.signal, effective);
        return { ok: true, value: { ...(viewStatus(status) as Record<string, unknown>), draft: effective !== undefined } };
      } catch (error) {
        return { ok: false, code: "probe-failed", message: messageOf(error) };
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * 写配置：直接调宿主设置服务，把 `write()` 抛出来的原文回给页面。
     * `form.mutate` 只回 true/false，页面没法告诉用户到底哪条不合法。
     */
    async configSet(request: unknown) {
      const body = asRecord(request);
      const rawOps = body?.ops;
      if (!Array.isArray(rawOps) || rawOps.length === 0) {
        return { ok: false, code: "config-rejected", message: "ops 必须是非空数组" };
      }
      if (rawOps.length > 64) {
        return { ok: false, code: "config-rejected", message: "一次最多提交 64 项改动" };
      }
      const ops: { op: string; path: string[]; value?: unknown }[] = [];
      for (const raw of rawOps) {
        const op = asRecord(raw);
        const kind = String(op?.op ?? "");
        if (kind !== "set" && kind !== "unset") {
          return { ok: false, code: "config-rejected", message: `未知操作：${kind}` };
        }
        const path = op?.path;
        if (!Array.isArray(path) || path.length === 0 || path.length > 4) {
          return { ok: false, code: "config-rejected", message: "path 必须是 1–4 段的数组" };
        }
        const segments: string[] = [];
        for (const segment of path) {
          const text = String(segment);
          if (!/^[A-Za-z0-9_]+$/.test(text)) {
            return { ok: false, code: "config-rejected", message: `非法配置路径：${path.join(".")}` };
          }
          segments.push(text);
        }
        const value = op?.value;
        if (kind === "set" && typeof value === "object" && value !== null) {
          return { ok: false, code: "config-rejected", message: `配置项 ${segments.join(".")} 只接受标量` };
        }
        ops.push(kind === "set" ? { op: kind, path: segments, value } : { op: kind, path: segments });
      }
      const revision = body?.revision;
      const settings = deps.settings();
      if (settings === undefined) {
        return { ok: false, code: "settings-unavailable", message: "设置服务尚未就绪，稍后重试" };
      }
      try {
        await settings.mutate(
          deps.namespace,
          ops,
          typeof revision === "number" && Number.isFinite(revision) ? revision : undefined,
        );
        const descriptor = deps.settings()?.describe().find((row) => row.ns === deps.namespace);
        return {
          ok: true,
          value: { applied: ops.length, revision: descriptor?.revision, saved: descriptor?.value },
        };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof Error && error.name === "SettingsConflictError" ? "config-conflict" : "config-write-failed",
          message: messageOf(error),
        };
      }
    },

    /** 诊断：宿主眼里这一行的配置长什么样（值、版本、命名空间）。 */
    async configDescribe() {
      const settings = deps.settings();
      if (settings === undefined) {
        return { ok: false, code: "settings-unavailable", message: "设置服务尚未就绪，稍后重试" };
      }
      let descriptors: readonly { readonly ns: string; readonly revision: number; readonly value?: unknown }[];
      try {
        descriptors = settings.describe();
      } catch (error) {
        return { ok: false, code: "config-describe-failed", message: messageOf(error) };
      }
      const mine = descriptors.find((row) => row.ns === deps.namespace);
      return {
        ok: true,
        value: {
          namespace: deps.namespace,
          available: descriptors.map((row) => row.ns),
          found: mine !== undefined,
          revision: mine?.revision,
          value: mine?.value,
        },
      };
    },

    /** 目标表 + 已登记工作区：页面拿它画下拉框，也顺便告诉用户「哪个目标还没登记成工作区」。 */
    async sessionTargets() {
      const config = deps.config();
      const targets = describeTargets(config);
      const registry = deps.workspaceRegistry();
      let registered: { id: string; path: string; title: string }[] = [];
      if (registry !== undefined) {
        try {
          registered = registry.list().map((item) => ({ id: item.id, path: item.path, title: item.title }));
        } catch (error) {
          return { ok: false, code: "workspace-list-failed", message: messageOf(error) };
        }
      }
      return {
        ok: true,
        value: {
          targets: targets.map((target) => ({
            id: target.id,
            name: target.name,
            path: target.path,
            zentaoProjects: target.zentaoProjects,
            repos: target.repos.map((repo) => ({
              role: repo.role,
              path: repo.path,
              gitUrl: repo.gitUrl,
              branches: repo.branches,
              submodules: (repo.submodules ?? []).map((rule) => ({ match: rule.match, branches: rule.branches })),
            })),
          })),
          workspaces: registered,
          host: {
            workspaceRegistry: registry !== undefined,
            sessionController: deps.sessionController() !== undefined,
          },
          session: {
            enabled: config.session.enabled,
            agentAutoStart: config.session.agentAutoStart,
            autoPrompt: config.session.autoPrompt,
            reuseExisting: config.session.reuseExisting,
          },
        },
      };
    },

    /** 人在页面上点「在新会话处理」：真的走到建会话那一步。 */
    async sessionStart(request: unknown) {
      const parsed = parseStartRequest(request);
      if ("error" in parsed) return parsed.error;
      try {
        const result = await startSession(
          {
            config: deps.config,
            service: deps.service,
            workspaceRegistry: deps.workspaceRegistry,
            sessionController: deps.sessionController,
            origin: "ui",
          },
          parsed.value,
        );
        return { ok: result.ok, value: result };
      } catch (error) {
        return { ok: false, code: "session-start-failed", message: messageOf(error) };
      }
    },

    /** 试运行：只探测/同步仓库并把提示词准备好，不建会话。 */
    async sessionProbe(request: unknown) {
      const parsed = parseStartRequest(request);
      if ("error" in parsed) return parsed.error;
      try {
        const result = await startSession(
          {
            config: deps.config,
            service: deps.service,
            workspaceRegistry: deps.workspaceRegistry,
            sessionController: deps.sessionController,
            origin: "ui",
          },
          { ...parsed.value, dryRun: true },
        );
        return { ok: result.ok, value: result };
      } catch (error) {
        return { ok: false, code: "session-probe-failed", message: messageOf(error) };
      }
    },
  };

  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "只接受 POST" });
      return false;
    }
    if (!isBridgeRequestAllowed(req)) {
      writeJson(res, 403, { ok: false, code: "forbidden", message: "只接受本机或同源请求" });
      return false;
    }
    return true;
  };

  const withBody = (
    name: string,
    parse: (body: unknown) => Promise<unknown> | unknown,
  ): BridgeRoute => ({
    kind: "exact",
    path: `${BRIDGE_PREFIX}/${name}`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: "malformed-body", message: "请求体不是合法 JSON 或超过 1MB" });
        return;
      }
      writeJson(res, 200, await parse(body));
    },
  });

  const withNoBody = (name: string, run: () => Promise<unknown>): BridgeRoute => ({
    kind: "exact",
    path: `${BRIDGE_PREFIX}/${name}`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      writeJson(res, 200, await run());
    },
  });

  return [
    withNoBody("credentials-status", () => handlers.credentialsStatus()),
    withBody("credentials-set", (body) => handlers.credentialsSet(body)),
    withBody("credentials-unset", (body) => handlers.credentialsUnset(body)),
    withBody("test", (body) => handlers.test(body)),
    withBody("config-set", (body) => handlers.configSet(body)),
    withNoBody("config-describe", () => handlers.configDescribe()),
    withNoBody("session-targets", () => handlers.sessionTargets()),
    withBody("session-start", (body) => handlers.sessionStart(body)),
    withBody("session-probe", (body) => handlers.sessionProbe(body)),
  ];
}

/** 解析页面上传来的开工请求：kind/id 必填，其余可选。 */
function parseStartRequest(request: unknown): { readonly value: StartRequest } | { readonly error: unknown } {
  const body = asRecord(request);
  if (body === undefined) return { error: { ok: false, code: "session-rejected", message: "请求体必须是对象" } };
  const kind = isEntityKind(body.kind) ? body.kind : undefined;
  if (kind === undefined) return { error: { ok: false, code: "session-rejected", message: "kind 只能是 story / task / bug" } };
  const rawId = body.id;
  const id = typeof rawId === "number" ? Math.trunc(rawId) : Number.parseInt(String(rawId ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) return { error: { ok: false, code: "session-rejected", message: "id 必须是正整数" } };
  return {
    value: {
      kind,
      id,
      ...(typeof body.targetId === "string" && body.targetId.trim() !== "" ? { targetId: body.targetId.trim() } : {}),
      ...(typeof body.prompt === "string" && body.prompt.trim() !== "" ? { prompt: body.prompt } : {}),
      ...(body.dryRun === true ? { dryRun: true } : {}),
      ...(body.cloneMissing === false ? { cloneMissing: false } : {}),
      ...(body.update === false ? { update: false } : {}),
      ...(body.reuse === false ? { reuse: false } : {}),
    },
  };
}

/** 凭据 key 白名单：页面直接传 ref 名。 */
function allowedRef(key: string): string | undefined {
  return Object.values(SECRET_REFS).find((ref) => ref === key);
}

/** 只允许本机回环或同源请求，避免被跨站页面当代理打。 */
function isBridgeRequestAllowed(req: IncomingMessage): boolean {
  const host = firstHeaderValue(req.headers.host);
  if (host === undefined) return false;
  const hostname = stripPort(host);
  const originHost = parseHost(firstHeaderValue(req.headers.origin));
  if (isLoopbackHost(hostname)) {
    // 本机服务最怕的不是「谁来读」，而是「恶意网页往 127.0.0.1 发 POST」：
    // 这种请求的 Host 一定是回环地址，光看 Host 挡不住，所以浏览器带了
    // Origin 就必须是回环来源。非浏览器客户端（curl/脚本）不带 Origin，放行。
    if (firstHeaderValue(req.headers.origin) === undefined) return true;
    return originHost !== undefined && isLoopbackHost(originHost);
  }
  if (originHost === undefined) return false;
  return isLoopbackHost(originHost) || originHost === hostname;
}

/** 取出 Origin 的 hostname；解析不出来就当没有。 */
function parseHost(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  );
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(decodeBody(Buffer.concat(chunks))) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 请求体按字节解成字符串。
 *
 * 为什么不能直接 `toString("utf8")`：Node 的 utf8 解码遇到非法字节会**静默替换成 U+FFFD**，
 * 而 JSON 结构本身是纯 ASCII，所以 `JSON.parse` 照样成功 —— 结果就是中文悄悄变成乱码，
 * 一路传进禅道提示词里。Windows 控制台的 `curl -d '...中文...'` 就发 GBK 字节，踩过一次。
 * 这里先严格按 UTF-8 解，解不动再按 GB18030（兼容 GBK/GB2312）解；都解不动就用替换字符兜底，
 * 让 JSON.parse 去决定是不是真的坏了。
 */
function decodeBody(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // 不是合法 UTF-8：多半是 GBK 系编码（Windows 控制台/老工具），转一次再给 JSON.parse。
  }
  try {
    return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 体检结果转成页面好读的形状。 */
function viewStatus(status: StatusOutcome): unknown {
  return JSON.parse(JSON.stringify(status)) as unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
