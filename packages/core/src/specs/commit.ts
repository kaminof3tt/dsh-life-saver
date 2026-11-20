import type { ToolSpec } from "./types.js";

export const COMMIT_SPEC: ToolSpec = {
  name: "zentao_commit",
  description:
    "把当前会话改过的文件提交成一条带禅道单子信息的提交：提交信息第一行「类型 #编号 标题」、第二行禅道链接。" +
    "默认只提交开工基线之后新出现的改动；没有基线时必须显式传 files。先 dryRun 预览，确认后再真提交。",
  properties: {
    kind: { type: "string", enum: ["story", "task", "bug"], description: "实体类型。不填则用开工时绑定的单子。" },
    id: { type: "string", description: "禅道编号或链接。不填则用开工时绑定的单子。" },
    repo: { type: "string", description: "仓库目录（绝对路径，或相对当前工作目录）。不填则认为当前目录在仓库里。" },
    files: {
      type: "array",
      items: "string",
      description: "要提交的文件（相对仓库或绝对路径）。给了就只提交这些文件；不给则按开工基线算差集。",
    },
    message: { type: "string", description: "自定义提交信息。给了就不再自动生成禅道格式。" },
    dryRun: { type: "boolean", description: "只预览要提交的文件和信息，不动 git。提交前建议先跑一次。" },
    push: { type: "boolean", description: "提交后是否 git push 当前分支。默认 false。" },
  },
};
