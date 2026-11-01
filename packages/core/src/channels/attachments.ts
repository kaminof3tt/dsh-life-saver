/**
 * 附件落盘的公共小工具。
 *
 * 通道只负责拿到字节，落盘规则（文件名、目录、限额）统一在这里，
 * 免得两条通道产出两套命名，用户看到两堆不一样的 attachments 目录。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 把任意文件名收敛成「不会跑出目录、不会撞 Windows 保留名」的形式。 */
export function safeFileName(id: number, filename: string): string {
  const normalized = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "file";
  const withId = /^\d+[_-]/.test(normalized) ? normalized : `${id}_${normalized}`;
  return withId.length > 120 ? withId.slice(0, 120) : withId;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function saveAttachment(
  dir: string,
  id: number,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  await ensureDir(dir);
  const path = join(dir, safeFileName(id, filename));
  await writeFile(path, bytes);
  return path;
}
