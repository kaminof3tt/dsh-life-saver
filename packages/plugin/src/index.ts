/**
 * `dsh-life-saver` 的插件入口。
 *
 * 挂载顺序（全部走 `ctx.inject`，服务可能晚于本插件就绪）：
 *   tools      → 注册 zentao_read / zentao_search / zentao_status / zentao_session_start 四个工具
 *   skills     → 注册三个随包发布的禅道 skill（zentao-extract / …-scrub-trace / …-weekly-report）
 *   settings   → 关掉自动生成的设置页（我们自己画），并允许写 volatile 字段
 *   webServer  → 暴露 `/api/dsh-life-saver/*` 给设置页读写
 *
 * 宿主服务 `workspaceRegistry` / `sessionController` 只在 `zentao_session_start`
 * 里用到（拉完禅道内容后在对应工作区开一个新会话），取不到时工具报人话而不是崩插件。
 *
 * 取数服务是单例：连接池、登录 cookie 都缓存在 `LifeSaverService` 里，
 * 配置/机密每次现取（设置页改完立刻生效，不用重启）。
 */

import type { Context } from "@deepseek-ai/cordis";
import {
  Config as ConfigSchema,
  SECRET_REFS,
  SETTINGS_NAMESPACE,
  readSecretsFromEnv,
  unwrapConfig,
  type LifeSaverConfig,
  type Secrets,
} from "life-saver-core/config.js";
import { LifeSaverService } from "life-saver-core/service.js";
import { registerTools } from "./tools/index.js";
import { messageOf } from "life-saver-core/tools/shared.js";
import type { SessionControllerLike, WorkspaceRegistryLike } from "./session/launcher.js";
import { makeBridgeRoutes, type BridgeRoute, type CredentialsLike, type SettingsLike } from "./bridge/routes.js";
import { registerSkills, type SkillRegistryLike } from "./skills/index.js";

/**
 * cordis 行名（与 `cordis.patch.yml` 的 `id` 一致）。
 *
 * 必须和 `SETTINGS_NAMESPACE` 是同一个值：设置页读写的命名空间就是它。
 * 两处各写一份字面量的话，改一处只会在运行时表现为「配置读不到」。
 */
export const name = SETTINGS_NAMESPACE;

/** 必需服务为空：工具/设置/HTTP 都是可选挂载，缺了不影响插件本身跑起来。 */
export const inject: string[] = [];

export const Config = ConfigSchema;

export type LifeSaverPluginConfig = ReturnType<typeof ConfigSchema>;

/** 插件主体。 */
export function apply(ctx: Context, config: LifeSaverPluginConfig): void {
  /** 每次现取配置：volatile 字段保存后是新值，不能在 apply 时缓存。 */
  const current = (): LifeSaverConfig => unwrapConfig(config) as LifeSaverConfig;

  /**
   * 取一个宿主服务。
   *
   * cordis 的 `ctx.get(name)` 返回 `unknown`，而这里要用的服务（credentials /
   * settings / workspaceRegistry / sessionController）的类型都由**别的插件**声明，
   * 本插件不依赖它们做编译期检查。以前每个取法都手写一遍
   * `(ctx as unknown as { get(name: string): unknown }).get("…")` 加一次
   * null 判断，四处各错各的；收成一个函数后只有这里需要维护。
   */
  const lookup = <T>(serviceName: string): T | undefined => {
    const value = (ctx as unknown as { get(name: string): unknown }).get(serviceName);
    return value === null || value === undefined ? undefined : (value as T);
  };

  /** 凭据中心可能晚于本插件挂载，运行期动态取。 */
  const getCredentials = (): CredentialsLike | undefined => lookup<CredentialsLike>("credentials");

  /** 设置服务同理：`/config-set` 兜底保存要用（`form.mutate` 只回布尔，拿不到原因）。 */
  const getSettings = (): SettingsLike | undefined => lookup<SettingsLike>("settings");

  /**
   * 宿主的工作区注册表 / 会话控制器：开新会话要用。
   * 两个服务都由 DSH 核心提供，纯 CLI 部署里可能没有——取不到就让工具报人话，
   * 不要因为缺它们把整个插件挂掉（禅道读取本身还是好用的）。
   */
  const getWorkspaceRegistry = (): WorkspaceRegistryLike | undefined =>
    lookup<WorkspaceRegistryLike>("workspaceRegistry");

  const getSessionController = (): SessionControllerLike | undefined =>
    lookup<SessionControllerLike>("sessionController");

  /** 三个密码：凭据中心优先，环境变量兜底。 */
  const readSecrets = async (): Promise<Secrets> => {
    const env = readSecretsFromEnv();
    const credentials = getCredentials();
    const read = async (ref: string, fallback: string): Promise<string> => {
      if (credentials === undefined) return fallback;
      try {
        const resolved = await credentials.resolve(ref);
        const value = resolved?.value ?? "";
        return value.length > 0 ? value : fallback;
      } catch {
        return fallback;
      }
    };
    const [httpPassword, dbPassword, sftpPassword] = await Promise.all([
      read(SECRET_REFS.httpPassword, env.httpPassword),
      read(SECRET_REFS.dbPassword, env.dbPassword),
      read(SECRET_REFS.sftpPassword, env.sftpPassword),
    ]);
    return { httpPassword, dbPassword, sftpPassword };
  };

  const logger = {
    info: (message: string): void => {
      ctx.logger?.info?.(`life-saver: ${message}`);
    },
    warn: (message: string): void => {
      ctx.logger?.warn?.(`life-saver: ${message}`);
    },
  };

  const service = new LifeSaverService({ config: current, secrets: readSecrets, logger });

  // 卸载时关连接池：不然 dev 热重载会把 mysql 连接泄一地。
  ctx.effect(
    () => () => {
      void service.dispose().catch((error: unknown) => logger.warn(`关闭连接池失败：${messageOf(error)}`));
    },
    "life-saver: service",
  );

  // ---- 工具 ----
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(
      () =>
        registerTools(sctx, service, {
          config: current,
          workspaceRegistry: getWorkspaceRegistry,
          sessionController: getSessionController,
          logger,
        }),
      "life-saver: tools",
    );
  });

  // ---- 技能 ----
  // 三个禅道 skill 随包发布：资产在 `assets/skills/`，`skills` 服务没就绪就跳过，
  // 缺服务不该让取数工具一起哑火。注册失败（比如同名 provider 已存在）也只记一条 warn。
  ctx.inject(["skills"], (sctx) => {
    const skills = (sctx as unknown as { skills?: SkillRegistryLike }).skills;
    if (skills === undefined) return;
    sctx.effect(() => {
      try {
        return registerSkills({ skills }, logger);
      } catch (error) {
        logger.warn(`注册随包技能失败：${messageOf(error)}`);
        return () => {};
      }
    }, "life-saver: skills");
  });

  // ---- 设置页 ----
  ctx.inject(["settings"], (sctx) => {
    // 服务类型由 dsh-settings 声明；本插件不依赖它做编译期检查，走窄类型转换。
    const settings = (sctx as unknown as {
      settings: { configure(options: { auto: boolean }, fiber?: unknown): () => void };
    }).settings;
    // 不让 DSH 自动生成表单：本条目有自建页面（plugins.row.config），
    // 而且手动注册页面策略后自动页会被忽略。
    sctx.effect(() => settings.configure({ auto: false }, ctx.fiber), "life-saver: settings page");
  });

  // ---- 桥接路由 ----
  // `webServer` 的服务类型由 dsh-web-server 声明；本插件不依赖它做编译期检查，
  // 所以走一次窄类型转换，缺服务时 inject 回调根本不会触发。
  const looseCtx = ctx as unknown as {
    inject(names: string[], callback: (scoped: Context) => void): void;
  };
  looseCtx.inject(["webServer"], (sctx) => {
    const webServer = (sctx as unknown as { webServer: { register(route: BridgeRoute): () => void } }).webServer;
    sctx.effect(() => {
      const routes = makeBridgeRoutes({
        credentials: getCredentials,
        service,
        secrets: readSecrets,
        config: current,
        settings: getSettings,
        workspaceRegistry: getWorkspaceRegistry,
        sessionController: getSessionController,
        namespace: name,
      });
      const disposers = routes.map((route) => registerOnce(webServer, route, logger));
      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose();
          } catch {
            // 重复卸载不是错误
          }
        }
      };
    }, "life-saver: bridge routes");
  });
}

/**
 * 幂等注册：DSH 热重载/重复 apply 时同一条路由已存在不算失败，
 * 否则一次重复注册会把整个 apply 抛出去，插件页就白了。
 */
function registerOnce(
  webServer: { register(route: BridgeRoute): () => void },
  route: BridgeRoute,
  logger: { warn?(message: string): void },
): () => void {
  try {
    return webServer.register(route);
  } catch (error) {
    const message = messageOf(error);
    if (/already registered|duplicate/i.test(message)) {
      logger.warn?.(`路由 ${route.path} 已注册，跳过`);
      return () => {};
    }
    throw error;
  }
}
