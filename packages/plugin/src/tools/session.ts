/**
 * zentao_session_start：把一条禅道单子变成「在对应工作区里开好的新会话」。
 *
 * 这个工具的存在意义是省掉一串手工作业：找项目 → 找仓库 → 切分支 → 建工作区 →
 * 建会话 → 起标题 → 发开场提示词。宿主把这些能力都暴露了，只是顺序挑得很死。
 *
 * 默认两重刹车（用户要求「默认人工点触发」）：
 *   - `session.agentAutoStart=false` 时，模型自己调不动这个工具，得人去页面上点；
 *   - `session.autoPrompt=false` 时，会话建好但提示词不发，避免一开就烧钱。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { LifeSaverService } from "life-saver-core/service.js";
import { LifeSaverError } from "life-saver-core/service.js";
import { parseZentaoRef } from "life-saver-core/domain/link.js";
import { asEntityKind, compact } from "life-saver-core/tools/shared.js";
import { startSession, type LauncherDeps, type StartResult } from "../session/launcher.js";
import { sessionIdOf } from "./context.js";

function markdown(value: StartResult): string {
  const lines: string[] = [];
  lines.push(value.ok ? `## ${value.message}` : `## 没成：${value.message}`);
  if (value.code !== undefined && !value.ok) lines.push(`- 错误码：\`${value.code}\``);
  if (value.entity !== undefined) {
    lines.push(`- 禅道单子：${value.entity.title}${value.entity.url !== undefined ? `（${value.entity.url}）` : ""}`);
  }
  if (value.target !== undefined) lines.push(`- 工作区：${value.target.name} — \`${value.target.path}\``);
  if (value.workspace !== undefined) {
    lines.push(`- 登记：${value.workspace.created ? "新建" : "复用已有"}（\`${value.workspace.path}\`）`);
  }
  if (value.sessionId !== undefined) {
    lines.push(
      `- 会话：\`${value.sessionId}\`${value.title !== undefined ? ` 「${value.title}」` : ""}${
        value.reused === true ? "（**同编号的旧会话，已回到它继续**）" : ""
      }`,
    );
  }
  if (value.sessionId !== undefined) lines.push(`- 提示词：${value.prompted ? "已发出（会产生一次模型调用）" : "没发，等人自己发"}`);
  if (value.candidates !== undefined && value.candidates.length > 0) {
    lines.push("", "### 候选工作区（选一个再调一次，传 targetId）");
    for (const item of value.candidates) lines.push(`- \`${item.id}\` ${item.name} — \`${item.path}\``);
  }
  if (value.repos !== undefined && value.repos.length > 0) {
    lines.push("", "### 仓库");
    for (const repo of value.repos) {
      lines.push(`- **${repo.role}** \`${repo.path}\`${repo.branch !== undefined ? ` [${repo.branch}]` : ""} — ${repo.action}：${repo.message}`);
      for (const sub of repo.submodules ?? []) {
        lines.push(`  - 子模块 \`${sub.path}\`${sub.branch !== undefined ? ` [${sub.branch}]` : ""} — ${sub.action}：${sub.message}`);
      }
    }
  }
  if (value.warnings !== undefined && value.warnings.length > 0) {
    lines.push("", "### 注意");
    for (const item of value.warnings) lines.push(`- ${item}`);
  }
  if (value.elsewhere !== undefined && value.elsewhere.length > 0) {
    lines.push("", "### 别的目录里也有同编号的会话（不自动接管，供参考）");
    for (const item of value.elsewhere) lines.push(`- \`${item.sessionId}\` 「${item.title}」 — \`${item.cwd}\``);
  }
  if (value.prompt !== undefined) {
    lines.push("", "### 预备好的开场提示词（没发出去，可以直接用）", "```text", value.prompt, "```");
  }
  return lines.join("\n");
}

export function createSessionTool(service: LifeSaverService, deps: Omit<LauncherDeps, "service">) {
  return defineTool({
    name: "zentao_session_start",
    description:
      "把禅道的一条任务/BUG/需求变成「在对应工作区里开好的新会话」：匹配工作区 → 补齐并更新各端 git 仓库 → " +
      "登记工作区 → 建新会话 → 起标题 →（按配置）发开场提示词。默认只做准备不发提示词；" +
      "模型自主调用需要在设置里打开「允许模型主动开新会话」，否则请人在插件页点按钮。",
    parameters: {
      kind: {
        type: "string",
        enum: ["story", "task", "bug"],
        description: "实体类型：需求 story / 任务 task / BUG bug。",
        required: true,
      },
      id: {
        type: "string",
        description: "禅道编号，或禅道详情页链接（工具会自己认类型和编号）。",
        required: true,
      },
      targetId: {
        type: "string",
        description: "指定工作区（target 的 id 或 name）。不填就按禅道项目名自动匹配；匹配不上会回候选清单。",
      },
      prompt: {
        type: "string",
        description: "自定义开场提示词。给了就一定发（会产生一次模型调用）；不给则看设置里的「自动发提示词」。",
      },
      dryRun: {
        type: "boolean",
        description: "只探测和同步仓库、把开场提示词准备好，不建会话。先看一遍再真开时用。",
      },
      cloneMissing: {
        type: "boolean",
        description: "目录里缺仓库时按配置的 git 地址自动 clone（默认 true）。",
      },
      update: {
        type: "boolean",
        description: "开工前把仓库切到配置的分支并快进到远端最新（默认 true）。",
      },
      reuse: {
        type: "boolean",
        description:
          "同一编号之前开过会话时，是否回到那个旧会话继续（默认 true，看设置里的「优先复用旧会话」）。给 false 就强行再开一个新的。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string" },
          message: { type: "string" },
          sessionId: { type: "string" },
          title: { type: "string" },
          reused: { type: "boolean" },
          prompted: { type: "boolean" },
          dryRun: { type: "boolean" },
          targetPath: { type: "string" },
          markdown: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: value.markdown ?? value.message ?? "" }];
      },
    },

    async execute(rawArgs, exec) {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const ref = parseZentaoRef(args.id);
      const kind = ref.kind ?? asEntityKind(args.kind);
      if (!kind) throw new LifeSaverError("bad-args", "参数 kind 只能是 story / task / bug");
      const id = ref.id;
      if (id === undefined) {
        throw new LifeSaverError("bad-args", "没从 id 里认出编号：给个正整数（如 5967），或直接粘禅道链接。");
      }

      const result = await startSession(
        { ...deps, service },
        {
          kind,
          id,
          ...(typeof args.targetId === "string" && args.targetId.trim() !== "" ? { targetId: args.targetId.trim() } : {}),
          ...(typeof args.prompt === "string" && args.prompt.trim() !== "" ? { prompt: args.prompt } : {}),
          ...(args.dryRun === true ? { dryRun: true } : {}),
          ...(args.cloneMissing === false ? { cloneMissing: false } : {}),
          ...(args.update === false ? { update: false } : {}),
          ...(args.reuse === false ? { reuse: false } : {}),
          ...(sessionIdOf(exec) !== undefined ? { excludeSessionId: sessionIdOf(exec) as string } : {}),
        },
        exec.signal,
      );

      const rendered = markdown(result);
      return compact({
        ok: result.ok,
        code: result.code,
        message: result.message,
        sessionId: result.sessionId,
        title: result.title,
        reused: result.reused,
        prompted: result.prompted,
        dryRun: result.dryRun,
        targetPath: result.workspace?.path,
        markdown: rendered,
      });
    },
  });
}
