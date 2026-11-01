/**
 * 显示名 → 禅道账号的反查表。
 *
 * 为什么需要它：详情页上人员永远是中文显示名（`张三` `于 2026-10-30 17:13:53`），
 * 而写操作的归属校验必须比账号（`zhangsan`）——否则「是不是我名下的任务」根本没法判。
 * 页面上没有账号，只能问禅道要一张映射表。
 *
 * 来源是 `m=company&f=browse&t=json`，它的 `userPairs` 一次给全部用户（本环境 45 人），
 * 比翻 `m=user` 列表页省事，也不受分页影响。实测该环境无重名，反查唯一。
 *
 * 拿不到就返回 undefined——上层会退回「显示名 vs 账号」的宽松比较，宁可护栏松一点也不
 * 让整条写路径不可用。
 */

import type { HttpSession } from "./session.js";
import { joinUrl } from "./session.js";

export interface UserDirectory {
  /** 中文显示名 → 账号。 */
  resolveAccount(realname: string): string | undefined;
  /**
   * 预热：`resolveAccount` 是同步的（映射层在做纯函数转换，不能 await），
   * 所以读实体之前先 await 一次这个，之后同步查询才有值。
   */
  warm(): Promise<void>;
}

/** 反查表缓存时长：人员变动很少，10 分钟足够，且避免每写一次就多两个请求。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface Cached {
  readonly at: number;
  readonly byRealname: Map<string, string>;
}

/**
 * company/browse 的响应是**两层 JSON**：外层 `{status, data, md5}`，`data` 又是一段
 * 字符串化的 JSON。直接 `JSON.parse` 一次只能拿到外层，必须解两次。
 */
export function parseUserPairs(body: string): Map<string, string> | undefined {
  let outer: unknown;
  try {
    outer = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!outer || typeof outer !== "object") return undefined;
  const data = (outer as { data?: unknown }).data;
  let inner: unknown = data;
  if (typeof data === "string") {
    try {
      inner = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (!inner || typeof inner !== "object") return undefined;
  const pairs = (inner as { userPairs?: unknown }).userPairs;
  if (!pairs || typeof pairs !== "object") return undefined;
  const out = new Map<string, string>();
  for (const [account, realname] of Object.entries(pairs as Record<string, unknown>)) {
    if (typeof realname === "string" && realname) out.set(account, realname);
  }
  return out.size > 0 ? out : undefined;
}

export function createUserDirectory(options: {
  readonly session: () => HttpSession;
  readonly baseUrl: string;
  readonly signal?: () => AbortSignal | undefined;
}): UserDirectory {
  let cache: Cached | undefined;

  const load = async (): Promise<Cached | undefined> => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
    try {
      const response = await options.session().get(
        joinUrl(options.baseUrl, "/index.php?m=company&f=browse&t=json"),
        options.signal?.(),
      );
      const pairs = parseUserPairs(response.html);
      if (!pairs) return undefined;
      const byRealname = new Map<string, string>();
      for (const [account, realname] of pairs) {
        // 重名时保留先到的那个：宁可反查不到，也不要随机认领一个账号。
        if (!byRealname.has(realname)) byRealname.set(realname, account);
      }
      cache = { at: Date.now(), byRealname };
      return cache;
    } catch {
      // 反查表是「尽力而为」：拿不到就退回宽松比较，不能因此让读写失败。
      return undefined;
    }
  };

  return {
    resolveAccount(realname: string): string | undefined {
      return cache?.byRealname.get(realname);
    },
    async warm(): Promise<void> {
      await load();
    },
  };
}
