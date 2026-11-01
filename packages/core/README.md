# life-saver-core

禅道（Zentao）取数与写入层的**框架无关**实现：给一个编号就返回正文、备注、操作记录、
附件实体与关联需求；也能反过来改数据（开始/完成/暂停任务、记工时、解决/关闭 BUG、加备注）。

它不依赖 DeepSeek Harness，也不依赖任何 MCP SDK。两个壳共用它：

| 壳 | 包 | 负责 |
|---|---|---|
| DSH 插件 | [`dsh-life-saver`](https://www.npmjs.com/package/dsh-life-saver) | cordis 入口、工具注册、设置页、开新会话 |
| MCP 服务器 | [`life-saver-mcp`](https://www.npmjs.com/package/life-saver-mcp) | stdio 传输与 content blocks |

## 两条通道

| 通道 | 需要 | 能给的 | 代价 |
|---|---|---|---|
| `db`（默认，只读） | MySQL 只读账号 + SFTP | 正文、备注、操作记录、附件实体、**工时统计** | 字段口径跟禅道版本走 |
| `http` | 禅道账号密码（登录换 cookie 抓页面） | 正文、备注、附件清单、**写操作（推荐）** | 慢；要账号有页面权限 |

`mode: "auto"` 先用 db、失败退 http，两条都失败会同时报两个错，不静默返回空。
写操作默认反着来（先 http），因为走页面才能让禅道自己把 action/历史/通知写全。

db 通道读数据时**不碰登录态**：不写 `zt_action`、不在审计里留痕。

## 安装

```bash
npm i life-saver-core
```

## 最小用法

```ts
import { LifeSaverService, readSecretsFromEnv } from "life-saver-core";

const service = new LifeSaverService({
  config: () => currentConfig,                 // 同步读当前配置（改完立刻生效）
  secrets: async () => readSecretsFromEnv(),   // 或从宿主凭据中心取
  logger: console,
});

const outcome = await service.read({ kind: "bug", id: 5967, scope: "full" });
console.log(outcome.envelope.markdown);
```

`service` 是单例语义：连接池、登录 cookie、结构探测结果都缓存在实例里，
配置与机密每次现取，所以改配置不用重建实例。

公开方法：`status()`、`read(options)`、`search(query, kind, limit)`、`write(request)`、
`stats(query)`、`relatedOf(envelope, limit)`、`dispose()`。
失败一律抛 `LifeSaverError`，`code` 是稳定的机器码（`bad-args` / `not-found` /
`write-rejected` / `channel` / `internal` …），`hint` 是给人看的下一步动作。

## 机密

密码不进配置文件。`SECRET_REFS` 规定三个名字，凭据中心与同名环境变量都认：

| 键 | 环境变量 |
|---|---|
| `httpPassword` | `ZENTAO_PASSWORD` |
| `dbPassword` | `ZENTAO_DB_PASSWORD` |
| `sftpPassword` | `ZENTAO_SFTP_PASSWORD` |

`readSecretsFromEnv()` 就是给 MCP 这类「只有环境变量」的场景准备的。

## 两个入口

- `life-saver-core` —— 稳定的公开面（服务类、配置、动作枚举、渲染器、工具层小工具）；
- `life-saver-core/<path>.js` —— 深层导入（如 `life-saver-core/channels/write.js`），
  给需要更细粒度的壳用。新代码优先用前者：一旦某个符号被壳依赖，把它写进入口文件，
  以后挪文件才不会静默断链。

## 附件

读到的附件默认只给清单（`id` / `filename` / `size` / `url`），需要落盘时传
`download: true` + `outDir`。落盘按字节头补扩展名，避免禅道把 `.png` 存成无后缀的文件。
同一张图在清单里和落盘后是同一个名字。

## 许可

MIT
