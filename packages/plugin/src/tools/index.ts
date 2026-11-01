/**
 * 工具层的装配点。
 *
 * 所有工具共用同一个 `LifeSaverService` 实例——连接池、登录 cookie 都在里面缓存，
 * 所以千万别在 execute 里 new 服务，否则每次调用都要重新登录一次禅道。
 *
 * `zentao_session_start` 额外要宿主的工作区/会话服务；这些服务可能晚于本插件挂载，
 * 也可能根本没装（纯 CLI 部署），所以统一走 `deps` 里的 getter，取不到就报人话。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { LifeSaverService } from "life-saver-core/service.js";
import type { LauncherDeps } from "../session/launcher.js";
import { createBugOpTool } from "./bugop.js";
import { createCommitTool } from "./commit.js";
import { createReadTool } from "./read.js";
import { createSearchTool } from "./search.js";
import { createSessionTool } from "./session.js";
import { createStatusTool } from "./status.js";
import { createTaskOpTool } from "./taskop.js";
import { createWorkhoursTool } from "./workhours.js";

/** 宿主侧依赖（工作区注册表 / 会话控制器），全部运行时现取。 */
export type HostDeps = Omit<LauncherDeps, "service" | "origin">;

/** 注册全部工具，返回卸载函数。 */
export function registerTools(ctx: Context, service: LifeSaverService, host: HostDeps): () => void {
  const definitions = [
    createReadTool(service),
    createSearchTool(service),
    createStatusTool(service),
    createWorkhoursTool(service),
    createTaskOpTool(service),
    createBugOpTool(service),
    createCommitTool(service),
    createSessionTool(service, { ...host, origin: "agent" }),
  ];
  const disposers = definitions.map((definition) => ctx.tools.register(definition));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
