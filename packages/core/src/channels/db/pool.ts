/**
 * 禅道库连接。
 *
 * 三条硬约束（写能力上线后仍然全部成立）：
 *   1. 连接串上不放多语句开关，`multipleStatements` 保持关闭——一条 statement 一次往返，
 *      事务里还额外拒收带分号的 SQL；
 *   2. 本文件之外不允许出现 SQL 字符串拼接，所有值都走占位符；
 *   3. 表前缀只允许 `[A-Za-z0-9_]`，它在拼进 SQL 前先校验，其余标识符全部白名单写死。
 *
 * 写操作只新增了 `transaction()`：多表写入必须同生共死，其余一概不动。
 *
 * 为什么不用 ORM：禅道的表结构很稳，只有十几条固定查询；
 * ORM 带来的类型体操与运行期反射，成本高于收益。
 */

import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { LifeSaverConfig } from "../../config.js";
import { ChannelError } from "../types.js";

const IDENT = /^[A-Za-z0-9_]+$/;

export interface DbHandle {
  /** 带前缀的表名，前缀已校验。 */
  readonly table: (name: string) => string;
  query<T extends RowDataPacket>(sql: string, params?: readonly unknown[], signal?: AbortSignal): Promise<T[]>;
  one<T extends RowDataPacket>(sql: string, params?: readonly unknown[], signal?: AbortSignal): Promise<T | undefined>;
  /**
   * 在一个事务里跑一串写操作。
   *
   * 为什么需要它：写一个「完成任务」要动 7 张表，中途失败留下半截数据比不写更糟。
   * 回调拿到的是一个**只在事务内有效**的执行器，抛错即整体回滚。
   *
   * 三条只读约束在这个方法上同样成立：`multipleStatements` 仍关、值只走占位符、
   * 表名仍走 `table()` 的白名单校验——写能力没有放宽任何一条。
   */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}

/** 事务内可用的执行器。只允许单条语句，且不回传 ResultSet 之外的任何东西。 */
export interface DbTransaction {
  readonly table: (name: string) => string;
  query<T extends RowDataPacket>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  one<T extends RowDataPacket>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: readonly unknown[]): Promise<{ affectedRows: number; insertId: number }>;
}

export interface DbConnectOptions {
  readonly db: LifeSaverConfig["db"];
  readonly password: string;
  /** 探活超时，避免连不上时把一次工具调用拖到超时。 */
  readonly connectTimeoutMs?: number;
}

function assertIdentifier(value: string, what: string): string {
  if (!IDENT.test(value)) {
    throw new ChannelError("db", "bad-identifier", `${what} 只允许字母、数字与下划线，收到：${JSON.stringify(value)}`);
  }
  return value;
}

export async function openDb(options: DbConnectOptions): Promise<DbHandle> {
  const config = options.db;
  const prefix = assertIdentifier(config.prefix || "zt_", "db.prefix");
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: options.password,
    database: config.database,
    charset: "utf8mb4",
    connectionLimit: config.connectionLimit,
    connectTimeout: options.connectTimeoutMs ?? 8000,
    // 只读：不允许多语句，不做本地文件读取
    multipleStatements: false,
    // 时间字段统一按字符串取，避免时区二次解释
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    rowsAsArray: false,
  });

  // 连接池在后台重连失败时会 emit 'error'；没有监听器就是 uncaught exception，
  // 会把整个 DSH 宿主带走。这里吞掉，真正的失败仍由每次查询的 reject 上报。
  const core = (pool as unknown as { pool?: { on(event: "error", listener: (error: unknown) => void): void } }).pool;
  core?.on("error", () => undefined);

  const table = (name: string) => `${prefix}${assertIdentifier(name, "表名")}`;

  const query = async <T extends RowDataPacket>(
    sql: string,
    params: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T[]> => {
    if (signal?.aborted) throw new ChannelError("db", "aborted", "查询已取消");
    const pending = pool.query<T[]>(sql, params as unknown[]);
    // mysql2 不支持中途取消，但工具调用不能陪一条慢查询一直等下去：
    // 用户按了停止就把控制权还给上层，剩下的连接交给连接池回收。
    if (!signal) return (await pending)[0];
    // 我们已经提前返回，这条 promise 的失败没有接收方——必须自己吃掉，
    // 否则会变成 unhandledRejection 把宿主进程带走。
    pending.catch(() => undefined);
    return (await raceAbort(pending, signal))[0];
  };

  const one = async <T extends RowDataPacket>(
    sql: string,
    params: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T | undefined> => {
    const rows = await query<T>(sql, params, signal);
    return rows[0];
  };

  /**
   * 事务执行。
   *
   * 注意 `signal` 只在**开始前**检查一次：事务一旦 begin，就不能因为上层取消
   * 而半途撒手——那会留下一个既没 commit 也没 rollback 的连接。取消的语义是
   * 「把这一串写完再停」，而不是「写到一半走人」。
   */
  const transaction = async <T>(fn: (tx: DbTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw new ChannelError("db", "aborted", "写操作已取消");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      let statementCount = 0;
      const run = async (sql: string, params: readonly unknown[] = []) => {
        statementCount += 1;
        // 兜底：这里如果出现分号，说明有人绕过占位符拼了多语句。
        if (sql.includes(";")) {
          throw new ChannelError("db", "bad-identifier", "事务内禁止多语句 SQL");
        }
        const [rows] = await connection.query(sql, params as unknown[]);
        return rows;
      };
      const txQuery = async <R extends RowDataPacket>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await run(sql, params)) as R[];
      const txOne = async <R extends RowDataPacket>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<R | undefined> => {
        const rows = (await run(sql, params)) as R[];
        return rows[0];
      };
      const tx: DbTransaction = {
        table,
        query: txQuery,
        one: txOne,
        async execute(sql: string, params: readonly unknown[] = []) {
          const result = (await run(sql, params)) as ResultSetHeader;
          return { affectedRows: result.affectedRows ?? 0, insertId: result.insertId ?? 0 };
        },
      };
      const value = await fn(tx);
      if (statementCount === 0) {
        // 什么都没写却声称成功，多半是逻辑分支写错；回滚比留个空事务好。
        throw new ChannelError("db", "empty-transaction", "写操作没有产生任何 SQL，已回滚");
      }
      await connection.commit();
      return value;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // 回滚也失败（连接已断），事务在服务端会随连接关闭自动回滚。
      }
      throw error;
    } finally {
      connection.release();
    }
  };

  return {
    table,
    query,
    one,
    transaction,
    async close() {
      // pool.end() 会等所有在途连接握手完；连不上的地址会把它拖到 connectTimeout。
      // 退出路径不能陪着它等，1 秒后放手，剩下的 socket 随进程回收。
      await Promise.race([pool.end().catch(() => undefined), delay(1000)]);
    },
  };
}

/** 定时器兜底用；unref 让挂着的定时器不拖住进程退出。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * 让一个已经发出的 promise 能被 AbortSignal 打断。
 *
 * 只做「提前返回」：底层查询仍在跑，但结果会被连接池丢弃，
 * 不会泄漏会话；换来的是停止按钮真的能立刻生效。
 */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ChannelError("db", "aborted", "查询已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 连不上库时最常见的几类原因，直接说该怎么办。 */
const CONNECT_HINTS: Record<string, string> = {
  ECONNREFUSED: "端口上没有服务在监听，确认只读库地址与端口",
  ETIMEDOUT: "连接超时，确认网络可达、防火墙放行",
  EHOSTUNREACH: "主机不可达，确认地址写对了",
  ENOTFOUND: "主机名解析不到",
  ER_ACCESS_DENIED_ERROR: "账号或密码不对（密码来源：凭据中心 / 环境变量 ZENTAO_DB_PASSWORD）",
  ER_BAD_DB_ERROR: "库名不存在",
  ER_NO_SUCH_TABLE: "表不存在，确认 db.prefix 与禅道版本",
};

/**
 * 把 mysql2 的错翻译成带上下文的 ChannelError，并保证不含密码。
 *
 * mysql2 连不上时抛的可能是 AggregateError（IPv6/IPv4 各一条），它的 message 是空的，
 * 直接拼进去就变成「读取 bug#5967失败：」——所以这里要能挖到里层错误。
 */
export function asDbError(error: unknown, action: string): ChannelError {
  if (error instanceof ChannelError) return error;
  const code = errorCode(error) ?? "db-error";
  const detail = describeError(error) || code;
  const hint = CONNECT_HINTS[code];
  return new ChannelError("db", code, `${action}失败：${detail}${hint ? `（${hint}）` : ""}`, { cause: error });
}

/** 取错误码；AggregateError 取第一条子错误。 */
function errorCode(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && (error as { code: unknown }).code) return String((error as { code: unknown }).code);
  const nested = (error as { errors?: unknown }).errors;
  if (depth < 3 && Array.isArray(nested) && nested.length > 0) return errorCode(nested[0], depth + 1);
  return undefined;
}

/** 取可读描述；空 message 时继续往里挖。 */
function describeError(error: unknown, depth = 0): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const nested = (error as { errors?: unknown }).errors;
  if (depth < 3 && Array.isArray(nested) && nested.length > 0) {
    for (const inner of nested) {
      const text = describeError(inner, depth + 1);
      if (text) return text;
    }
  }
  return "";
}
