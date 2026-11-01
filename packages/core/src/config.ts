/**
 * 插件配置。
 *
 * 分三层：
 *   1. 静态 schema —— 决定设置页长什么样、默认值是什么；
 *   2. 持久化值 —— 由 ctx.settings 落在 profile 的 cordis.patch.yml 里（桥接路由与设置页读写的都是它）；
 *   3. 机密 —— 密码不进配置，走凭据中心（ZENTAO_PASSWORD / ZENTAO_DB_PASSWORD / ZENTAO_SFTP_PASSWORD），
 *      读不到再退回环境变量，避免落盘与出现在设置页。
 *
 * 所有字段都标 `.volatile()`：dsh-settings 只允许写 volatile 路径
 * （`isVolatilePath` + `mutate` 里那句「Config field X is not volatile」），
 * 不标的话自建设置页保存会直接 500。带 volatile 的字段在 apply 里是 ref，
 * 读值必须先 `unwrapConfig`。
 */

import Schema from "@deepseek-ai/schemastery";

/**
 * cordis 的 ref 形态。
 *
 * 以前从 `@deepseek-ai/cosmokit` 借这个类型，但那会把 core 绑到宿主运行时上——
 * MCP 服务器里没有 cosmokit，却只是需要一个结构类型。所以这里自己声明：
 * 结构一致就够了，`unwrapConfig` 也只用到 `get()` / `isRef` 这两点。
 */
export interface Volatile<T> {
  get(): T;
}

/** 取数通道选择。 */
export type ChannelMode = "auto" | "db" | "http";

/** 配置命名空间，必须与 cordis.patch.yml 的行 id 一致。 */
export const SETTINGS_NAMESPACE = "life-saver";

/** 凭据中心的 ref 名（也兼容同名环境变量）。 */
export const SECRET_REFS = {
  httpPassword: "ZENTAO_PASSWORD",
  dbPassword: "ZENTAO_DB_PASSWORD",
  sftpPassword: "ZENTAO_SFTP_PASSWORD",
} as const;

export const Config = Schema.object({
  mode: Schema.union(["auto", "db", "http"])
    .default("auto")
    .description(
      "取数通道。db=只读库+SFTP（快、能批量、不惊动审计日志）；http=账号密码登录换 cookie 再走页面（需要权限、但和人工看到的一致）；auto=先 db，失败自动降级到 http。",
    )
    .volatile(),
  discovery: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description(
        "是否自探索禅道的结构差异（详情页皮肤、登录密码算法、库里的 keywords 列 / 需求挂项目的落点）。" +
          "探测结果只在内存里缓存，换部署（库地址或站点地址变了）会自动重探；关掉则一律用代码里的默认值。",
      )
      .volatile(),
    ttlMs: Schema.number()
      .min(0)
      .max(7 * 24 * 60 * 60 * 1000)
      .default(10 * 60 * 1000)
      .description("探测结果缓存时长（毫秒）。0 = 每次都重探，一般只在排查「结构变了」时用。")
      .volatile(),
  })
    .description("结构自探索：换一套禅道也不用改代码。")
    .collapse(),
  http: Schema.object({
    baseUrl: Schema.string()
      .default("")
      .description("禅道根地址，例如 http://zentao.example.com（带不带 /zentao 后缀都可以）。")
      .volatile(),
    account: Schema.string()
      .default("")
      .description("禅道登录账号。密码不写进配置（插件：凭据中心；MCP：环境变量 ZENTAO_PASSWORD）。")
      .volatile(),
    timeoutMs: Schema.number()
      .min(1000)
      .max(600000)
      .default(60000)
      .description("单次 HTTP 请求超时（毫秒）。")
      .volatile(),
    skin: Schema.union(["auto", "detail-section", "detail", "article"])
      .default("auto")
      .description(
        "详情页正文的皮肤。auto = 按「新 → 老」依次尝试并记住命中哪一档；" +
          "如果探测总失败（比如页面被改造过），可以在这里钉死一档来跳过前两档的尝试。",
      )
      .volatile(),
  })
    .description("HTTP 通道设置。")
    .collapse(),
  db: Schema.object({
    host: Schema.string().default("").description("只读库地址。").volatile(),
    port: Schema.number().min(1).max(65535).default(3306).description("只读库端口。").volatile(),
    database: Schema.string().default("zentao").description("禅道库名。").volatile(),
    user: Schema.string().default("").description("只读账号。密码不写进配置（插件：凭据中心；MCP：环境变量 ZENTAO_DB_PASSWORD）。").volatile(),
    prefix: Schema.string().default("zt_").description("表前缀。").volatile(),
    keywords: Schema.union(["auto", "on", "off"])
      .default("auto")
      .description(
        "搜索是否连 keywords 列一起匹配。auto = 探测库结构（老版本禅道没有这一列）；" +
          "on/off = 不探、直接按这个来。",
      )
      .volatile(),
    connectionLimit: Schema.number().min(1).max(16).default(4).description("连接池上限。").volatile(),
  })
    .description("数据库只读通道设置。")
    .collapse(),
  sftp: Schema.object({
    host: Schema.string().default("").description("SFTP 主机（通常与库同机）。").volatile(),
    port: Schema.number().min(1).max(65535).default(22).description("SFTP 端口。").volatile(),
    user: Schema.string().default("").description("SFTP 账号。密码不写进配置（插件：凭据中心；MCP：环境变量 ZENTAO_SFTP_PASSWORD）。").volatile(),
    uploadBase: Schema.string()
      .default("")
      .description("禅道上 upload 目录的绝对路径，例如 /home/zentao/zentao/www/data/upload。")
      .volatile(),
    privateKeyPath: Schema.string().default("").description("可选：改用私钥登录时填私钥文件绝对路径。").volatile(),
  })
    .description("附件读取（SFTP）设置。")
    .collapse(),
  write: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description("是否允许工具改禅道里的数据（开始/完成/关闭任务、解决 BUG、记工时等）。关掉 = 只读不写。")
      .volatile(),
    mode: Schema.union(["http", "db", "auto"])
      .default("http")
      .description(
        "写操作走哪条线。http=走禅道页面（推荐：history、通知、看板泳道都由禅道自己写全）；db=直接改库（快，但要自己复刻 7 张表的副作用）；auto=http 失败降级到 db。",
      )
      .volatile(),
    allowOthers: Schema.boolean()
      .default(false)
      .description("是否允许改「不是指派给我」的任务/BUG。默认关：只能动自己名下的，防止误操作别人的单子。")
      .volatile(),
  })
    .description("写操作（开始/完成/解决/关闭/记工时）设置。")
    .collapse(),
  limits: Schema.object({    maxAttachments: Schema.number().min(0).max(200).default(40).description("单个对象最多落盘多少个附件。").volatile(),
    maxAttachmentBytes: Schema.number()
      .min(0)
      .default(20 * 1024 * 1024)
      .description("单个附件大小上限（字节），超过只记录不落盘。")
      .volatile(),
    maxRelated: Schema.number().min(0).max(20).default(8).description("最多递归取多少个关联对象。").volatile(),
  })
    .description("取数上限，防止一次拉爆。")
    .collapse(),
  output: Schema.object({
    dir: Schema.string()
      .default("")
      .description("落盘目录。留空则放到会话工作区的 zentao-extract/ 下。")
      .volatile(),
  })
    .description("输出位置。")
    .collapse(),
  targets: Schema.string()
    .default("")
    .description(
      "工作区目标表（JSON 数组）。每项：{id,name,path,zentaoProjects:[...],repos:[{role,path,gitUrl,branches,submodules}]}。" +
        "path 为工作区根目录绝对路径；repos[].path 可写绝对路径或相对工作区根目录的目录名；branches 是有序分支链（序号 1 是改动落点）；" +
        "submodules 是子模块分支的键值对（键模糊匹配子模块名，没配的跟随父仓库）。" +
        "在设置页有可视化编辑器，一般不用手写。",
    )
    .volatile(),
  session: Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description("是否允许 zentao_session_start 这个工具开新会话。关掉 = 只读禅道，不碰工作区。")
      .volatile(),
    agentAutoStart: Schema.boolean()
      .default(false)
      .description(
        "是否允许模型自己决定开新会话。默认关：只有人明确要求时才会开；打开后模型可以在读到任务/BUG 后自己发起（会产生真实的模型调用费用）。",
      )
      .volatile(),
    autoPrompt: Schema.boolean()
      .default(false)
      .description("开新会话后是否自动发首条提示词。关掉 = 建好会话、标题写好，提示词由人自己发（省钱、可控）。")
      .volatile(),
    promptTemplate: Schema.string()
      .default("")
      .description(
        "首条提示词模板。留空用内置模板。可用占位符：{{kind}} {{id}} {{title}} {{target}} {{repos}} {{branches}} {{submodules}} {{submodulebranches}} {{zentao}}。",
      )
      .volatile(),
    reuseExisting: Schema.boolean()
      .default(true)
      .description(
        "同一编号之前开过会话时，回到那个旧会话继续，而不是再建一个新的。只认编号（会话标题里的 #编号），不看标题是否改过；同编号不在这个工作区里就照常新建。",
      )
      .volatile(),
  })
    .description("开新会话（zentao_session_start）的行为开关。")
    .collapse(),
});

/**
 * 把 schema 推断出的类型里的 `Volatile<T>` 拆成 T。
 *
 * schemastery 的 `.volatile()` 把字段声明成 `Volatile<T>`（`{ get(): T }`），
 * 因为运行期是 ref；但我们所有字段都有 default，`unwrapConfig` 之后一定是值。
 * 所以这里顺手 `NonNullable`：类型上不再允许 undefined，代码里就不用到处 `?? ""`。
 */
export type Unwrapped<T> = T extends Volatile<infer U>
  ? Unwrapped<NonNullable<U>>
  : T extends readonly (infer E)[]
    ? Unwrapped<E>[]
    : T extends (...args: never[]) => unknown
      ? T
      : T extends object
        ? { -readonly [K in keyof T]: Unwrapped<T[K]> }
        : T;

export type LifeSaverConfig = Unwrapped<ReturnType<typeof Config>>;

/** 运行期解析出来的机密；缺哪项由对应通道在使用前报错。 */
export interface Secrets {
  readonly httpPassword: string;
  readonly dbPassword: string;
  readonly sftpPassword: string;
}

/**
 * 把 apply 拿到的配置解成普通值。
 *
 * volatile 字段在 cordis 里是 ref（有 `get()`），不unwrap就会拿到一个对象，
 * 后面所有 `config.db.host` 都变成 undefined。free-search 的 resolveConfig 同款。
 */
export function unwrapConfig<T>(config: T): Unwrapped<T> {
  if (isRef(config)) return unwrapConfig((config as { get(): T }).get());
  if (Array.isArray(config)) return config.map((item) => unwrapConfig(item)) as unknown as Unwrapped<T>;
  if (config !== null && typeof config === "object") {
    return Object.fromEntries(
      Object.entries(config as Record<string, unknown>).map(([key, value]) => [key, unwrapConfig(value)]),
    ) as Unwrapped<T>;
  }
  return config as Unwrapped<T>;
}

function isRef(value: unknown): value is { get(): unknown } {
  return value !== null && typeof value === "object" && typeof (value as { get?: unknown }).get === "function";
}

/** 从环境变量读机密（凭据中心拿不到时的兜底）。 */
export function readSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): Secrets {
  return {
    httpPassword: env[SECRET_REFS.httpPassword] ?? "",
    dbPassword: env[SECRET_REFS.dbPassword] ?? "",
    sftpPassword: env[SECRET_REFS.sftpPassword] ?? "",
  };
}

/**
 * 把设置页里的「当前填写值」叠到已保存配置上，用于「测试连接」。
 *
 * 插件页的探活如果要先保存才能测，用户改完一个字段点测试就会被告知「缺 http.account」——
 * 那是个纯粹的 UX 陷阱。这里让页面把 draft 直接带过来，宿主合成一份临时配置去探活，
 * 不落盘、不触发通道缓存重建。
 *
 * 只认 base 里已有的键，类型不符的直接忽略（页面的数字输入可能给字符串）。
 */
export function applyOverrides(base: LifeSaverConfig, raw: unknown): LifeSaverConfig {
  return mergeValue(base, raw) as LifeSaverConfig;
}

function mergeValue(base: unknown, raw: unknown): unknown {
  if (raw === null || raw === undefined) return base;
  if (typeof base === "string") return typeof raw === "string" ? raw : base;
  if (typeof base === "boolean") return typeof raw === "boolean" ? raw : base;
  if (typeof base === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
    return base;
  }
  if (Array.isArray(base)) return Array.isArray(raw) ? raw : base;
  if (base !== null && typeof base === "object") {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = mergeValue(out[key], value);
    }
    return out;
  }
  return base;
}

/** 归一化 baseUrl：去掉尾部斜杠，保留用户是否写了 /zentao。 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 把配置里的 mode 收窄成联合类型（schema 校验后一定合法，这里只是给 TS 看）。 */
export function resolveMode(mode: string): ChannelMode {
  return mode === "db" || mode === "http" ? mode : "auto";
}

/**
 * 配置签名：通道实例挂在签名上，改配置（或机密）就重建通道。
 * 只放真正影响连接的字段，避免改个 limit 就把连接池拆了。
 */
export function channelSignature(config: LifeSaverConfig, secrets: Secrets): string {
  return JSON.stringify({
    mode: resolveMode(config.mode),
    http: {
      baseUrl: normalizeBaseUrl(config.http.baseUrl),
      account: config.http.account,
      timeoutMs: config.http.timeoutMs,
      password: secrets.httpPassword,
    },
    db: {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      prefix: config.db.prefix,
      connectionLimit: config.db.connectionLimit,
      password: secrets.dbPassword,
    },
    sftp: {
      host: config.sftp.host || config.db.host,
      port: config.sftp.port,
      user: config.sftp.user,
      uploadBase: config.sftp.uploadBase,
      privateKeyPath: config.sftp.privateKeyPath,
      password: secrets.sftpPassword,
    },
  });
}
