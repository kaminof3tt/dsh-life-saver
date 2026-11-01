/**
 * zentao_commit：按禅道单子提交「本次对话的改动」。
 *
 * 提交信息固定两行（第一行「类型 #编号 标题」，第二行禅道链接），只提交这个会话动过的
 * 文件——并行的其它会话在同一个仓库里改的东西不会被顺手带进来。
 *
 * 为什么必须有这个工具而不是靠模型自己 `git add -A`：一个工作区里可能同时跑着几个会话，
 * `git add -A && git commit` 会把别人未提交的改动一起卷进去，提交备注也永远是随手编的。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { parseZentaoRef } from "life-saver-core/domain/link.js";
import { LifeSaverError, type LifeSaverService } from "life-saver-core/service.js";
import { asEntityKind, compact } from "life-saver-core/tools/shared.js";
import { renderCommitOutput, runCommit, type CommitRequest } from "../commit/run.js";
import { cwdOf, sessionIdOf } from "./context.js";

export function createCommitTool(service: LifeSaverService) {
  return defineTool({
    name: "zentao_commit",
    description:
      "把本次对话改的文件提交成一条带禅道单子信息的提交：提交信息第一行「类型 #编号 标题」、第二行禅道链接，" +
      "并且只提交这个会话动过的文件——同一个工作区里别的会话的改动不会被带进来（靠会话私有索引隔离）。" +
      "不给 files 时按「开工基线之后新出现的改动」计算；先用 dryRun 看一眼文件清单再真提交。" +
      "默认只提交不推送；要推得显式传 push=true。",
    parameters: {
      kind: {
        type: "string",
        enum: ["story", "task", "bug"],
        description: "实体类型：需求 story / 任务 task / BUG bug。不填就用本会话开工时绑定的那张单子。",
      },
      id: {
        type: "string",
        description: "禅道编号，或禅道详情页链接。不填就用本会话开工时绑定的那张单子。",
      },
      repo: {
        type: "string",
        description: "仓库目录（绝对路径，或相对当前工作区）。不填就用当前会话工作区所在的仓库。",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "要提交的文件（相对当前工作区或绝对路径）。给就只提交这些文件，适合「明确知道改了哪几个」的场合；" +
          "不给则按开工基线算差集。",
      },
      message: {
        type: "string",
        description: "自定义提交信息（会整段覆盖自动生成的两行）。一般不用给，让工具按单子生成。",
      },
      dryRun: {
        type: "boolean",
        description: "只看将要提交哪些文件、信息长什么样，不动 git。提交前建议先跑一次。",
      },
      push: {
        type: "boolean",
        description: "提交成功后是否顺手 git push 当前分支（默认 false，只提交不推送）。",
      },
    },
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
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const ref = parseZentaoRef(args.id);
      const kind = ref.kind ?? asEntityKind(args.kind);
      const id = ref.id;
      if (args.id !== undefined && id === undefined) {
        throw new LifeSaverError("bad-args", "没从 id 里认出编号：给个正整数（如 5967），或直接粘禅道链接。");
      }

      const request: CommitRequest = {
        ...(kind === undefined || id === undefined ? {} : { kind, id }),
        ...(typeof args.repo === "string" && args.repo.trim() !== "" ? { repoPath: args.repo.trim() } : {}),
        ...(Array.isArray(args.files) && args.files.length > 0
          ? { files: args.files.filter((item): item is string => typeof item === "string" && item.trim() !== "") }
          : {}),
        ...(typeof args.message === "string" && args.message.trim() !== "" ? { message: args.message } : {}),
        ...(args.dryRun === true ? { dryRun: true } : {}),
        ...(args.push === true ? { push: true } : {}),
      };

      const sessionId = sessionIdOf(exec);
      const result = await runCommit(request, {
        service,
        cwd: cwdOf(exec),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
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

export { renderCommitOutput };
