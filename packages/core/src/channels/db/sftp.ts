/**
 * SFTP 只读访问：只为「把附件字节拿回来」这一件事存在。
 *
 * 三条约束：
 *   1. 只读——这里没有 write/unlink/rename 的任何入口。
 *   2. 懒连接——没配 SFTP 或没请求附件时，一次都不连。
 *   3. 路径只由「上传根目录 + zt_file.pathname」拼成，不接受任意路径，
 *      避免把通道变成通用文件读取器。
 *
 * 关于落盘路径：禅道把附件存成 `202610/3015125402841221.png` 这样的 pathname，
 * 但磁盘上**去掉扩展名**。老版本和部分部署又保留扩展名，所以两个候选都试。
 */

import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";

import { ChannelError } from "../types.js";

export interface SftpOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  readonly privateKeyPath?: string;
  /** 禅道 upload 目录绝对路径；多产品部署时它的同级数字目录也会被试。 */
  readonly uploadBase: string;
  readonly connectTimeoutMs?: number;
}

export interface SftpReader {
  /** 按 zt_file.pathname 取字节；找不到就抛 ChannelError。 */
  readFile(pathname: string, signal?: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT = 10_000;

function connect(options: SftpOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    const timer = setTimeout(() => {
      client.end();
      reject(new ChannelError("db", "sftp-timeout", `SFTP 连接超时（${timeout}ms）`));
    }, timeout);

    client.once("ready", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once("error", (error) => {
      clearTimeout(timer);
      reject(new ChannelError("db", "sftp-connect", `SFTP 连接失败：${error.message}`, { cause: error }));
    });

    void (async () => {
      try {
        const privateKey = options.privateKeyPath
          ? await readFile(options.privateKeyPath, "utf8")
          : undefined;
        client.connect({
          host: options.host,
          port: options.port,
          username: options.user,
          password: options.password,
          privateKey,
          readyTimeout: timeout,
        });
      } catch (error) {
        clearTimeout(timer);
        client.end();
        reject(
          new ChannelError("db", "sftp-key", `读取 SFTP 私钥失败：${(error as Error).message}`, { cause: error }),
        );
      }
    })();
  });
}

function openChannel(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(new ChannelError("db", "sftp-channel", `打开 SFTP 通道失败：${error.message}`, { cause: error }));
      else resolve(sftp);
    });
  });
}

function listDir(sftp: SFTPWrapper, dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    sftp.readdir(dir, (error, entries) => {
      if (error) resolve([]);
      else resolve(entries.map((entry) => entry.filename));
    });
  });
}

function tryRead(sftp: SFTPWrapper, remote: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    sftp.readFile(remote, (error, data) => {
      // 只把「文件不存在/无权限」当成可继续尝试，其他错误也归为未命中，
      // 最终由调用方统一报一条可读的错误。
      if (error || !data) resolve(undefined);
      else resolve(data);
    });
  });
}

export async function openSftp(options: SftpOptions): Promise<SftpReader> {
  if (!options.host || !options.user) {
    throw new ChannelError("db", "sftp-config", "SFTP 未配置：缺少 host 或 user");
  }
  if (!options.uploadBase) {
    throw new ChannelError("db", "sftp-config", "SFTP 未配置：缺少 sftp.uploadBase（禅道 upload 目录绝对路径）");
  }

  const client = await connect(options);
  const sftp = await openChannel(client);

  let dirsCache: string[] | undefined;
  const candidateDirs = async (): Promise<string[]> => {
    if (dirsCache) return dirsCache;
    // 禅道把附件放在 upload/<productID>/<yyyyMM>/<hash> 下，productID 是数字目录。
    // uploadBase 指向的正是 upload 本身，所以要扫它自己的子目录，而不是它的兄弟目录。
    const dirs = [options.uploadBase];
    for (const name of await listDir(sftp, options.uploadBase)) {
      if (!/^\d+$/.test(name)) continue;
      const candidate = posix.join(options.uploadBase, name);
      if (!dirs.includes(candidate)) dirs.push(candidate);
    }
    dirsCache = dirs;
    return dirs;
  };

  return {
    async readFile(pathname, signal) {
      if (signal?.aborted) throw new ChannelError("db", "aborted", "附件下载已取消");
      const rel = pathname.replace(/^\/+/, "");
      const withoutExt = rel.includes(".") ? rel.slice(0, rel.lastIndexOf(".")) : rel;
      const tried: string[] = [];
      for (const dir of await candidateDirs()) {
        for (const candidate of [posix.join(dir, withoutExt), posix.join(dir, rel)]) {
          tried.push(candidate);
          const data = await tryRead(sftp, candidate);
          if (data) return data;
        }
      }
      // 必须把「试过哪些路径」带出来：否则用户只会看到一句 attachment-missing，
      // 无从判断是 uploadBase 指错了，还是产品目录层级不一样。
      const sample = tried.slice(0, 6).join("、");
      const more = tried.length > 6 ? ` 等 ${tried.length} 个路径` : "";
      throw new ChannelError(
        "db",
        "attachment-missing",
        `SFTP 上找不到附件实体：${pathname}（试过：${sample}${more}；若都不对，检查 sftp.uploadBase 是否指向禅道的 upload 目录）`,
      );
    },
    async close() {
      client.end();
    },
  };
}
