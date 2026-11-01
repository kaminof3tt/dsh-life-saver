import type { ToolSpec } from "./types.js";

/**
 * zentao_status：连接体检。
 *
 * 不带参数。刻意不返回任何密码，只回「有没有配」。
 */
export const STATUS_SPEC: ToolSpec = {
  name: "zentao_status",
  description:
    "禅道连接体检：当前取数模式、两条通道（只读库+SFTP / HTTP 登录抓页面）是否配齐、能否连通、各自支持哪些能力。" +
    "读取出错或刚配好环境时先跑这个。",
  properties: {},
};
