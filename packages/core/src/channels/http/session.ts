/**
 * 禅道 HTTP 会话：账号密码登录换 cookie，然后带着 cookie 读页面。
 *
 * 为什么不用禅道的 REST API：这台是 biz 版，页面才是「人看到的样子」，
 * 而且 API 需要额外的 token 权限；登录 + 页面这条路只要账号能看，就能取。
 *
 * 登录细节（禅道 12.x 起）：
 *   1. GET  /index.php?m=user&f=refreshRandom  → 纯文本 verifyRand
 *   2. 密码二次 md5：md5( md5(password) + verifyRand )
 *   3. POST /index.php?m=user&f=login&t=json  （multipart，返回 {status:success|failed, reason}）
 *   4. 成功后响应头里的 zentaosid 就是会话 cookie
 * 失败要按 `status` 字段判定，**不能**只看有没有 cookie——失败时禅道也会下发 session。
 */

import { createHash } from "node:crypto";

import type { LoginFlow } from "../../domain/discovery.js";
import { ChannelError } from "../types.js";

export interface HttpSessionOptions {
  readonly baseUrl: string;
  readonly account: string;
  readonly password: string;
  readonly timeoutMs: number;
  /** cookie 复用时长；禅道默认会话 1 小时。 */
  readonly cookieTtlMs?: number;
  /** 登录成功后回调：告诉上层这套部署吃的是哪一档密码协议（探测层要记）。 */
  readonly onLoginFlow?: (flow: LoginFlow) => void;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

/** 一次页面请求的结果：正文 HTML + 最终 URL（重定向后）。 */
export interface PageResponse {
  readonly html: string;
  readonly url: string;
}

/** 提交表单时的附加信息。 */
export interface PostOptions {
  /** 表单字段；数组下标形式（如 `work[1]`）由调用方自己拼好。 */
  readonly body: URLSearchParams;
  /** 表单所在页面，作为 Referer 发回去（禅道部分动作会看）。 */
  readonly referer?: string;
  readonly signal?: AbortSignal;
}

export interface HttpSession {
  /** 带 cookie 取页面。 */
  get(url: string, signal?: AbortSignal): Promise<PageResponse>;
  /** 带 cookie 提交表单（application/x-www-form-urlencoded）。 */
  post(url: string, options: PostOptions): Promise<PageResponse>;
  /** 带 cookie 取原始字节（附件/图片）。 */
  bytes(url: string, signal?: AbortSignal): Promise<Buffer>;
  /** 当前登录账号（探活用）。 */
  readonly account: string;
  /** 这次会话是靠哪一档密码协议登进来的；还没登录过是 undefined。 */
  readonly loginFlow?: LoginFlow;
}

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/** 登录接口的 JSON 响应：成功/失败都靠它判定。 */
interface LoginPayload {
  readonly status?: string;
  readonly reason?: string;
  readonly message?: string;
}

/** 禅道的 baseUrl 可能带 /zentao 子路径，拼接时保留它。 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function createHttpSession(options: HttpSessionOptions): HttpSession {
  const base = options.baseUrl.replace(/\/+$/, "");
  const ttl = options.cookieTtlMs ?? 50 * 60 * 1000;

  let cookie: string | undefined;
  let cookieAt = 0;
  let loginInFlight: Promise<string> | undefined;
  /** 登录成功后记住用的是哪档协议，供状态页展示与上层缓存。 */
  let loginFlow: LoginFlow | undefined;

  const timeout = (): AbortSignal => AbortSignal.timeout(options.timeoutMs);

  const withSignal = (signal?: AbortSignal): AbortSignal => {
    return signal ? AbortSignal.any([signal, timeout()]) : timeout();
  };

  const login = async (signal?: AbortSignal): Promise<string> => {
    if (!base) throw new ChannelError("http", "config", "未配置 http.baseUrl");
    if (!options.account) throw new ChannelError("http", "config", "未配置 http.account");
    if (!options.password) throw new ChannelError("http", "config", "未配置凭据 ZENTAO_PASSWORD");

    const randUrl = joinUrl(base, "/index.php?m=user&f=refreshRandom");
    const randResponse = await fetch(randUrl, {
      headers: { "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest" },
      signal: withSignal(signal),
      redirect: "follow",
    });
    if (!randResponse.ok) {
      throw new ChannelError("http", "login", `取 verifyRand 失败：HTTP ${randResponse.status}`);
    }
    const verifyRand = (await randResponse.text()).trim();
    if (!verifyRand) throw new ChannelError("http", "login", "refreshRandom 返回空，无法登录");

    // 关键：refreshRandom 把 rand 绑在会话里，登录 POST 必须把这个 cookie 带回去。
    // 不带的话禅道找不到对应会话，会一律回「用户名或密码不正确」——密码对也登不进去（实测踩过）。
    const jar = collectCookie(randResponse);

    const loginUrl = joinUrl(base, "/index.php?m=user&f=login&t=json");

    // 密码协议不是所有部署都一样：
    //   - 12.x 起默认 `md5(md5(password) + verifyRand)`（二次 md5）
    //   - 更老的版本、以及关掉 verifyRand 的部署只收 `md5(password)`
    // 把两档都试一次，比让用户去猜「这台是哪档」便宜；判据还是响应里的 status，
    // 不是有没有 cookie（失败时禅道也会下发 session）。
    const attempts: ReadonlyArray<{ flow: LoginFlow; hashed: string }> = [
      { flow: "md5-rand", hashed: md5(md5(options.password) + verifyRand) },
      { flow: "plain", hashed: md5(options.password) },
    ];

    const submit = async (hashed: string): Promise<{ response: Response; payload?: LoginPayload }> => {
      const form = new FormData();
      form.set("account", options.account);
      form.set("password", hashed);
      form.set("passwordStrength", "1");
      form.set("referer", "/index.php");
      form.set("verifyRand", verifyRand);
      form.set("keepLogin", "1");
      form.set("captcha", "");

      const response = await fetch(loginUrl, {
        method: "POST",
        body: form,
        headers: {
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest",
          Referer: joinUrl(base, "/index.php?m=user&f=login"),
          ...(jar ? { Cookie: jar } : {}),
        },
        signal: withSignal(signal),
        redirect: "manual",
      });

      let payload: LoginPayload | undefined;
      let text = "";
      try {
        text = await response.text();
        payload = JSON.parse(text) as LoginPayload;
      } catch {
        throw new ChannelError(
          "http",
          "login",
          `登录响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`,
        );
      }
      return { response, payload };
    };

    const failures: string[] = [];
    for (const attempt of attempts) {
      const { response, payload } = await submit(attempt.hashed);
      // 禅道失败时 status 可能是 "failed"，也可能直接给 reason 而没有 status。
      if (payload?.status !== "success") {
        const reason = payload?.reason ?? payload?.message ?? "未知原因";
        failures.push(`${attempt.flow} → ${reason}`);
        continue;
      }

      // 登录成功时禅道未必重发 zentaosid（实测只回了 za/zp/lang 这些），会话 id 往往还是
      // refreshRandom 那次给的，所以要把两份 cookie 合起来，不能只看登录响应。
      const session = mergeCookies(jar, collectCookie(response));
      if (!session) throw new ChannelError("http", "login", "登录成功但响应里没有会话 cookie");
      loginFlow = attempt.flow;
      options.onLoginFlow?.(attempt.flow);
      return session;
    }

    throw new ChannelError(
      "http",
      "login",
      `登录失败（已试二次 md5 与直接 md5 两种协议）：${failures.join("；")}`,
    );
  };

  const collectCookie = (response: Response): string => {
    const raw = response.headers.getSetCookie?.() ?? [];
    const pairs: string[] = [];
    for (const line of raw) {
      const pair = line.split(";", 1)[0]?.trim();
      if (!pair) continue;
      pairs.push(pair);
    }
    return pairs.join("; ");
  };

  /** 合并多份 "k=v; k2=v2"，同名以靠后的为准，丢掉 `k=deleted` 这类过期项。 */
  const mergeCookies = (...parts: string[]): string => {
    const merged = new Map<string, string>();
    for (const part of parts) {
      for (const pair of part.split(";")) {
        const item = pair.trim();
        if (!item) continue;
        const index = item.indexOf("=");
        if (index <= 0) continue;
        const key = item.slice(0, index);
        const value = item.slice(index + 1);
        if (value === "deleted") {
          merged.delete(key);
          continue;
        }
        merged.set(key, value);
      }
    }
    return [...merged].map(([key, value]) => `${key}=${value}`).join("; ");
  };

  const ensureCookie = async (signal?: AbortSignal): Promise<string> => {
    if (cookie && Date.now() - cookieAt < ttl) return cookie;
    loginInFlight ??= login(signal)
      .then((value) => {
        cookie = value;
        cookieAt = Date.now();
        return value;
      })
      .finally(() => {
        loginInFlight = undefined;
      });
    return loginInFlight;
  };

  const request = async (url: string, signal?: AbortSignal, post?: PostOptions): Promise<Response> => {
    const target = url.startsWith("http") ? url : joinUrl(base, url);
    const attempt = async (): Promise<Response> => {
      const session = await ensureCookie(signal);
      return fetch(target, {
        method: post ? "POST" : "GET",
        ...(post
          ? {
              body: post.body,
              headers: {
                "User-Agent": USER_AGENT,
                Accept: "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                Origin: base,
                ...(post.referer
                  ? { Referer: post.referer.startsWith("http") ? post.referer : joinUrl(base, post.referer) }
                  : {}),
                Cookie: session,
              },
            }
          : {
              headers: {
                "User-Agent": USER_AGENT,
                Accept: "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "X-Requested-With": "XMLHttpRequest",
                Cookie: session,
              },
            }),
        signal: withSignal(post?.signal ?? signal),
        redirect: "follow",
      });
    };

    let response = await attempt();
    // 会话过期时禅道会 302 到登录页；fetch 跟着跳，所以这里拿到的是 200 的登录页而不是 302
    // （旧代码判 `status === 302` 的那条分支永远不会命中）。改成看落点 URL，外加 401/403。
    const landedOnLogin = (result: Response): boolean => {
      try {
        const search = new URL(result.url).search;
        return /[?&]m=user(&|$)/.test(search) && /[?&]f=login(&|$)/.test(search);
      } catch {
        return false;
      }
    };
    // 只重试幂等的 GET：POST 重发一次表单等于重复提交，可能多记一笔工时、多插一条备注。
    if (post === undefined && (response.status === 401 || response.status === 403 || landedOnLogin(response))) {
      cookie = undefined;
      response = await attempt();
      if (landedOnLogin(response)) {
        throw new ChannelError("http", "login", `登录失效：${target} 被重定向回登录页（账号或密码可能已改）`);
      }
    }
    if (!response.ok) {
      throw new ChannelError("http", "request", `请求失败：HTTP ${response.status} ${target}`);
    }
    return response;
  };

  return {
    account: options.account,
    get loginFlow() {
      return loginFlow;
    },
    async get(url, signal) {
      const response = await request(url, signal);
      return { html: await response.text(), url: response.url || url };
    },
    async post(url, postOptions) {
      const response = await request(url, postOptions.signal, postOptions);
      return { html: await response.text(), url: response.url || url };
    },
    async bytes(url, signal) {
      const response = await request(url, signal);
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer);
    },
  };
}
