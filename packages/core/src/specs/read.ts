import type { ToolSpec } from "./types.js";

/** zentao_read：读取一条需求/任务/BUG 的正文与全部上下文。 */
export const READ_SPEC: ToolSpec = {
  name: "zentao_read",
  description:
    "读取禅道的一条需求(story)/任务(task)/BUG(bug)：正文、备注与操作记录、附件清单，并可把附件实体落盘。" +
    "返回已渲染好的 Markdown。取数通道自动选择：优先只读库+SFTP，不可用时降级到登录 cookie 抓页面（auto 模式）。",
  properties: {
    kind: {
      type: "string",
      enum: ["story", "task", "bug"],
      description: "实体类型：需求 story / 任务 task / BUG bug。",
      required: true,
    },
    id: {
      type: "string",
      description:
        "禅道编号，或直接粘浏览器地址栏里的禅道链接（形如 index.php?m=bug&f=view&bugID=5967 或 task-view-1875.html），工具会自己认类型和编号。",
      required: true,
    },
    scope: {
      type: "string",
      enum: ["brief", "full"],
      description: "brief=只要字段与正文（备注/附件只给数量）；full=连备注与附件表一起（默认）。",
    },
    download: {
      type: "boolean",
      description: "是否把附件实体下载到本地（默认 false，只给清单）。附件是截图/文档，需要看内容时再打开。",
    },
    outDir: {
      type: "string",
      description: "下载目录（绝对路径）。不填则用配置里的输出目录，再退到 <工作区>/zentao-extract/<kind>-<id>。",
    },
    includeRelated: {
      type: "boolean",
      description: "是否顺带取关联对象（任务→需求、BUG→任务/需求、子需求→父需求）。默认 true。",
    },
  },
};
