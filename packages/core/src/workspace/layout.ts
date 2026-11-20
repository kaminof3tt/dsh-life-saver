/**
 * 开工时的「布局」：会话叫什么、产物目录叫什么、工作区根目录在不在。
 *
 * 这三件事两个壳都要用（插件建真会话，MCP 只回报一个产物目录），而且必须
 * 逐字一致——产物目录名一旦分叉，提示词里写的路径和实际建出来的目录就不是同一个。
 */

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EntityKind } from "../domain/model.js";
import { kindLabel, type WorkspaceTarget } from "./targets.js";

/** 目标在工作区列表里的精简形态（工具输出用）。 */
export interface BriefTarget {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export function briefTarget(target: WorkspaceTarget): BriefTarget {
  return { id: target.id, name: target.name, path: target.path };
}

/** 会话标题：一眼能看出是哪条禅道单子。 */
export function sessionTitle(kind: EntityKind, id: number, title: string): string {
  return `${kindLabel(kind)} #${id} ${title}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * 会话产物目录名：和会话名一致，只把文件系统不认的字符换掉。
 *
 * 会话名里带 `#`、空格、中文都是常态，Windows 只拦 `\ / : * ? " < > |` 与控制字符；
 * 末尾的点和空格在 Windows 上会被静默吞掉，一并去掉，否则提示词里写的路径和实际建出来的不是同一个。
 */
export function artifactDirName(sessionName: string): string {
  const cleaned = sessionName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned === "" ? "session" : cleaned;
}

/** 会话产物目录的绝对路径。 */
export function artifactDirOf(target: WorkspaceTarget, titleText: string): string {
  return join(target.path, artifactDirName(titleText));
}

/**
 * 建会话前把根目录准备好。
 *
 * 不抛错：调用方（插件建会话 / MCP 记录开工基线）都要把原因原样讲给人听，
 * 而不是变成一条 stack。返回 ok:false 时 message 已经是可以直接展示的一句话。
 */
export async function ensureRoot(path: string, mayCreate: boolean): Promise<{ readonly ok: boolean; readonly message: string }> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return { ok: true, message: "" };
    return { ok: false, message: `工作区路径 ${path} 不是目录。` };
  } catch {
    // 不存在：下面按 mayCreate 决定建不建
  }
  if (!mayCreate) {
    return { ok: false, message: `工作区目录 ${path} 不存在，而且这个目标没配可自动 clone 的仓库，不替你造空目录。` };
  }
  try {
    await mkdir(path, { recursive: true });
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: `工作区目录 ${path} 建不出来：${error instanceof Error ? error.message : String(error)}` };
  }
}
