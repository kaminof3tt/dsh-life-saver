import type { ToolSpec } from "./types.js";

export const WORK_START_SPEC: ToolSpec = {
  name: "zentao_work_start",
  description:
    "为一张禅道单子记录开工现场：匹配工作区、同步各端仓库、记录会话与单子的绑定和开工时的脏文件基线。" +
    "之后 zentao_commit 才能分清哪些改动是本会话做的。不建宿主会话、不自动发提示词。",
  properties: {
    kind: { type: "string", enum: ["story", "task", "bug"], description: "实体类型。", required: true },
    id: { type: "string", description: "禅道编号或链接。", required: true },
    targetId: { type: "string", description: "工作区目标 id 或名称。不填则按禅道项目名自动匹配。" },
    sessionId: { type: "string", description: "会话标识。MCP 客户端没有稳定会话 id 时给一个人工标识；同一任务一直用同一个值。", required: true },
    cloneMissing: { type: "boolean", description: "目录缺仓库时是否按配置 clone。默认 true。" },
    update: { type: "boolean", description: "开工前是否切分支并快进远端。默认 true。" },
    dryRun: { type: "boolean", description: "只探测和同步仓库，不写开工基线。" },
  },
};
