/**
 * zentao_status 的执行与渲染：配了没、连得上吗、两条通道各自能干什么。
 *
 * 排障第一条命令。刻意不返回任何密码，只回「有没有配」。
 * 文案保持宿主中立（说「配置」而不是「插件页」），因为 MCP 侧没有页面可点。
 */

import type { ChannelCaps } from "../channels/types.js";
import type { DiscoveryStatus, LifeSaverService, StatusOutcome } from "../service.js";
import type { ToolRunContext } from "./context.js";

/** 皮肤的人话：三套选择器，宁可写清楚「哪套 DOM」，也别只回一个内部枚举。 */
const SKIN_LABELS: Readonly<Record<string, string>> = {
  "detail-section": "新版（`.detail-section`）",
  detail: "老版（`.detail`）",
  article: "最老版（`.article`）",
};

const LOGIN_LABELS: Readonly<Record<string, string>> = {
  "md5-rand": "二次 md5（md5(pwd)+verifyRand）",
  plain: "直接 md5(pwd)（老版本 / 未开 verifyRand）",
};

const PROJECT_LABELS: Readonly<Record<string, string>> = {
  story: "`zt_story.project` 列",
  relation: "`zt_projectstory` 关联表",
  none: "库里没有，输出 null",
};

export interface StatusToolOutput {
  mode: string;
  reachable: boolean;
  markdown: string;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 结构探测段。
 *
 * 这一段的全部价值在「别让人误以为默认值是探出来的」：所以 `confirmed`、
 * `skin`、`loginFlow` 三个「未确认」都写明白，而不是留空让人自己猜。
 */
function discoveryLines(discovery: DiscoveryStatus): string[] {
  if (!discovery.enabled) {
    return ["", "## 结构探测（自探索）", "", "- 已关闭（`discovery.enabled=false`）：读取一律用代码默认结构（新版皮肤 + 二次 md5 + 标题/keywords + 关联表）。"];
  }

  const lines: string[] = ["", "## 结构探测（自探索）", ""];
  lines.push(`- 部署坐标：\`${discovery.where}\``);
  lines.push(
    `- 库结构：${discovery.confirmed ? "已确认 ✅" : "未确认（用默认值）"} · 搜索：${discovery.db.hasKeywords ? "标题 + keywords" : "只有标题"} · 需求所属项目：${
      PROJECT_LABELS[discovery.db.projectSource] ?? discovery.db.projectSource
    }`,
  );
  lines.push(
    `- 页面皮肤：${discovery.skin ? `${SKIN_LABELS[discovery.skin] ?? discovery.skin}` : "未确认（读过一条实体后才能判定，也可用 http.skin 手工钉死）"}`,
  );
  lines.push(
    `- 登录算法：${discovery.loginFlow ? `${LOGIN_LABELS[discovery.loginFlow] ?? discovery.loginFlow}` : "未确认（HTTP 登录成功后才能判定）"}`,
  );
  if (discovery.probedAt) {
    lines.push(`- 最近探测：${formatTime(discovery.probedAt)}${discovery.stale ? "（缓存已过期，下次体检重探）" : "（缓存有效）"}`);
  }
  for (const note of discovery.notes) lines.push(`  - ${note}`);
  for (const warning of discovery.warnings) lines.push(`- ⚠️ ${warning}`);
  return lines;
}

function mark(ok: boolean): string {
  return ok ? "✅" : "❌";
}

function channelLines(name: string, health: StatusOutcome["db"], caps?: ChannelCaps): string[] {
  const lines: string[] = [];
  const probe = health.probe;
  const probeText = probe
    ? probe.ok
      ? `探活 ${mark(true)}${probe.detail ? ` ${probe.detail}` : ""}`
      : `探活 ${mark(false)} ${probe.error ?? "失败"}`
    : "未探活";
  lines.push(`- **${name}**：${health.ready ? "可用" : "不可用"}（配置${health.configured ? "齐全" : "缺失"} · ${probeText}）`);
  if (health.missing.length > 0) lines.push(`  - 缺：${health.missing.join("、")}`);
  if (caps) {
    const ability = [
      caps.read ? "读实体" : undefined,
      caps.search ? "搜索" : undefined,
      caps.attachments ? "取附件实体" : "仅列附件",
      caps.notes ? "备注/操作记录" : "无备注",
      caps.estimates ? "工时" : undefined,
      caps.write ? "写入" : "只读",
      caps.stats ? "工时统计" : undefined,
    ].filter(Boolean);
    lines.push(`  - 能力：${ability.join("、")}`);
  }
  return lines;
}

/** 体检的 markdown。插件与 MCP 共用同一份文案，避免「一边说能用一边说缺配置」。 */
export function renderStatusMarkdown(status: StatusOutcome): string {
  const reachable = status.db.probe?.ok === true || status.http.probe?.ok === true;
  const lines = [
    "# 禅道连接体检",
    "",
    `- 取数模式：**${status.mode}**（auto = 先只读库，失败降级 HTTP）`,
    `- 总体：${reachable ? "至少一条通道连通 ✅" : "两条通道都不通 ❌"}`,
    "",
    "## 通道",
    ...channelLines("只读库 + SFTP (db)", status.db, status.caps?.db),
    ...channelLines("HTTP 页面 (http)", status.http, status.caps?.http),
    ...discoveryLines(status.discovery),
    "",
  ];
  if (!reachable) {
    lines.push(
      "> 两条通道都不通时的排查顺序：① baseUrl / db.host 是否指向内网禅道；② 密码是否已保存（ZENTAO_PASSWORD / ZENTAO_DB_PASSWORD）；③ 库端口是否被防火墙拦。",
    );
  }
  return lines.join("\n");
}

export async function runStatusTool(service: LifeSaverService, ctx: ToolRunContext): Promise<StatusToolOutput> {
  const status = await service.status(ctx.signal);
  const reachable = status.db.probe?.ok === true || status.http.probe?.ok === true;
  return { mode: status.mode, reachable, markdown: renderStatusMarkdown(status) };
}

export function renderStatusOutput(value: StatusToolOutput): string {
  return value.markdown ?? "";
}
