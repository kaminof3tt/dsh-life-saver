/**
 * zentao_commit：按禅道单子提交「本次对话的改动」。
 *
 * 描述、参数与执行都在 core：这里只补两件宿主相关的事——会话 cwd 与宿主会话 id
 * （提交隔离、开工基线都按会话 id 记账）。
 *
 * 为什么必须有这个工具而不是靠模型自己 `git add -A`：一个工作区里可能同时跑着几个会话，
 * `git add -A && git commit` 会把别人未提交的改动一起卷进去，提交备注也永远是随手编的。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { COMMIT_SPEC, commitRequestOf, runCommit, type LifeSaverService } from "life-saver-core";
import { compact } from "life-saver-core/tools/shared.js";
import { parametersOf } from "./parameters.js";
import { contextOf } from "./context.js";

export function createCommitTool(service: LifeSaverService) {
  return defineTool({
    name: "zentao_commit",
    description: COMMIT_SPEC.description,
    parameters: parametersOf(COMMIT_SPEC),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          sha: { type: "string" },
          subject: { type: "string" },
          link: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          heldBack: { type: "array", items: { type: "string" } },
          stagedElsewhere: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          dryRun: { type: "boolean" },
          pushed: { type: "boolean" },
          markdown: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: value.markdown ?? value.message ?? "" }];
      },
    },

    async execute(rawArgs, exec) {
      const context = contextOf(exec);
      const result = await runCommit(commitRequestOf(rawArgs), {
        service,
        cwd: context.cwd,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });

      return compact({
        ok: result.ok,
        message: result.message,
        repo: result.repo,
        branch: result.branch,
        sha: result.sha,
        subject: result.subject,
        link: result.link,
        files: [...result.files],
        heldBack: [...result.heldBack],
        stagedElsewhere: [...result.stagedElsewhere],
        warnings: [...result.warnings],
        dryRun: result.dryRun,
        pushed: result.pushed,
        markdown: result.markdown,
      });
    },
  });
}
