---
name: zentao-extract
description: 禅道内容全量提取 —— 只给 task/bug/story 编号，自动拉取正文、备注、操作记录、附件实体，并递归拉取关联需求的正文/备注/附件。用于拿禅道需求文档、Bug 重现步骤、附件截图来驱动代码开发。当用户给出禅道编号（如「task 1875」「bug 5494」「需求 1313」）并要求看内容/改代码/分析需求时使用。
whenToUse: 用户给出一个禅道 task/bug/story 编号，要求查看正文、备注、操作记录、附件，或要求按该需求/Bug 开发代码时。
---

# 禅道内容全量提取

## 用途

给一个禅道编号，落盘一份可读 Markdown + 全部附件实体。不需要禅道登录、不需要浏览器、不需要猜路径。

## 首选通道：dsh-life-saver 插件的 zentao_* 工具

本机装入的 DSH 插件 `dsh-life-saver`（本 skill 就是随它一起发布的，源码 `D:\workspace2\life-saver\dsh-life-saver`，profile `~/.dsh/profiles/desktop`）。
**只要工具清单里有 `zentao_*`，就不要跑下面的 python 脚本** —— 插件直接返回结构化内容，正文已剥标签、备注按时间正序、附件清单带本地路径：

| 工具 | 用途 |
|---|---|
| `zentao_read({ kind: "story"\|"task"\|"bug", id, download: true })` | 正文 + 备注 + 操作记录 + 附件清单；`download: true` 时附件实体落到 `<工作区>/zentao-extract/<kind>-<id>/` |
| `zentao_search({ query, kind?, limit })` | 按关键词定位编号（只用来找 id，别拿它当正文） |
| `zentao_status()` | 两条通道（只读库+SFTP / 账号密码登录→cookie→抓页面）的配置与连通性体检 |

用法要点：

1. `includeRelated` 默认 `true`，会自动带出关联需求/任务/Bug 的摘要；**实质业务规格通常在关联需求里**，任务/Bug 自身描述常常是空的（沿用下面的递归原则）。
2. 附件落盘后的绝对路径直接出现在返回值里，图片用 `read_image` 打开。
3. 通道由 `mode` 控制：`auto`（默认，DB+SFTP 失败再退回 HTTP）、`db`、`http`。DB 通道不碰禅道登录态，不会在审计日志里留痕。
4. 编号类型不明确时先 `zentao_search` 定位，再 `zentao_read`。
5. `zentao_read` 的 `id` 也能直接收禅道链接（`?m=bug&f=view&bugID=5967`、`bug-view-5967.html`、`#bug=5967`）——用户贴链接时原样传给工具即可，不用自己抠编号；链接里的类型优先于 `kind`。

## 触发条件

用户说出任意形式的禅道编号：
- 「task 1875」「任务 1875」「#1875」
- 「bug 5494」「缺陷 5494」
- 「需求 1313」「story 1313」
- 「按这个需求改代码」「这个 bug 怎么修」+ 编号

编号类型不明确时按语义推断（需求/故事→story，缺陷→bug，任务/开发任务→task）。

## 输入

| 项 | 值 |
|---|---|
| 对象类型 | `task` / `bug` / `story` |
| 对象 ID | 纯数字 |
| 兜底脚本 | `D:\workspace2\zentao\zentao.py`（仅插件不可用时） |
| 依赖 | Python 3 + `pymysql` + `paramiko` |

兜底脚本的连接信息从环境变量读，变量名与插件一致（`ZENTAO_DB_HOST` / `ZENTAO_DB_PORT` /
`ZENTAO_DB_USER` / `ZENTAO_DB_PASSWORD` / `ZENTAO_DB_NAME`，附件走 SFTP 再加
`ZENTAO_SSH_HOST` / `ZENTAO_SSH_PORT` / `ZENTAO_SSH_USER` / `ZENTAO_SSH_PASSWORD` /
`ZENTAO_UPLOAD`）。**具体取值不写在本文件里**——照 DSH 设置页 `dsh-life-saver` 的
`db.*` / `sftp.*` 填，或直接跑一次 `zentao_status()` 看现成输出。

## 执行步骤（兜底：插件不可用时才用）

> 上面「首选通道」里的 `zentao_read` 可以直接拿全部内容；只有在插件未安装或报错时，才走这里的 python 脚本。

```powershell
cd D:\workspace2\zentao
python zentao.py task 1875      # 或 bug 5494 / story 1313
```

成功输出一行：`out\<type>_<id>\index.md  (N 附件下载成功, 0 失败)`

ID 不存在 → 中文提示 + `exit 2`，不产生产物目录内容。
类型非法 → `type 必须是 task / bug / story` + `exit 1`。

## 产物说明

```
out/<type>_<id>/
├── index.md      # 全部可读内容，图片以 ![](...) 内联
└── files/        # 附件实体，命名 <fileId>_<原文件名去扩展名>.<扩展名>
```

`index.md` 结构（按出现顺序）：

| 段落 | 内容 |
|---|---|
| `# TASK #id` / `# BUG #id` / `# 关联需求 STORY #id` | 字段表：标题、状态、工时、指派链、项目/执行/模块名、时间戳 |
| `## 任务描述` / `## 重现步骤` / `## 需求正文（N 个版本）` | 正文纯文本（HTML 已剥标签、保留换行） |
| `## 需求附件` / `## 任务附件` / `## 缺陷附件` | 附件表：id / 文件名 / 类型 / 大小 / 上传人 / 时间 / 实体相对路径 |
| `## xxx 操作记录 / 备注（N 条）` | 按时间正序的 action 流水，`commented` 的正文以 `> ` 引用块呈现 |
| `## 工时记录` | 仅 task，有 `zt_taskestimate` 行时出现 |
| `## 子任务` / `## 该需求下的任务` / `## 该需求下的缺陷` | 关联清单 |

### 递归关联（重要）

**能关联需求就一定去需求里取内容** —— 需求的正文和备注才是真正的业务规格，任务/Bug 自身描述常常是空的（task 1875 实测：任务描述空、0 附件，全部实质内容都在关联需求 1313 里）。

- `task` → 关联需求（`zt_task.story`）+ 来源 Bug（`zt_task.fromBug`）+ 子任务
- `bug` → 关联需求（`zt_bug.story`）+ 关联任务（`zt_bug.task`）
- `story` → 该需求下的全部任务与缺陷（仅清单，不递归展开）

## 关键路径与通道

### 附件真实路径（唯一不明显的点）

```
宿主机 /home/zentao-biz/data/zentao/www/data/upload/1/<pathname 去掉扩展名>
```

- `zt_file.pathname` 形如 `202610/1214272305072b6a.png`，但**落盘文件没有扩展名**，实际是 `.../202610/1214272305072b6a`
- 文件类型只能靠 `file` 命令或内容嗅探识别（实测该文件 `file` 返回 `PNG image data, 2236 x 1660`）
- 去掉扩展名后字节数与 `zt_file.size` 严格一致，可作校验

### 通道选择

- **文字内容**：直连禅道库读表（地址/端口/账号见环境变量 `ZENTAO_DB_*`），不经过登录态
- **附件实体**：SSH/SFTP 直连宿主机的 22 端口取文件（主机/账号见环境变量 `ZENTAO_SSH_*`），**不经过禅道登录**
- 已排除的死路：禅道 HTTP 下载接口需登录态；DB 侧 `LOAD_FILE()` 读不到 web 容器文件（DB 在独立容器 `8c3d2ea8b931`，`/data/www` 不存在）

### `/1` 前缀前置条件

`zentao.py:22` 的 `UPLOAD` 常量固定为 `.../upload/1`。这**仅在单产品部署成立**（`upload/<productID>/` 只有 1 个产品目录）。
多产品/多项目环境需改为按 `zt_file.pathname` 前缀动态拼接 —— 即先确认 `upload/` 下有哪几个产品目录，再按 `objectType`/`objectID` 反查所属产品。

## 已知限制与升级路径

| 限制 | 表现 | 升级路径 |
|---|---|---|
| 非图片附件无内联预览 | pdf/zip/docx 只给 `files/` 链接，不嵌图 | 在 `Dump.show_files` 里按 `extension` 分派，图片走 `![]`，其余走链接卡片 |
| 附件去重未跨对象复用 | 同一文件被正文 `{18269.png}` 和备注 `files` 双引用时重复下载 | `Dump.fetch` 开头已判 `if fid in self.got: return`，只是 `got` 按实例隔离；改为模块级缓存即可 |
| 中文文件名控制台乱码 | PowerShell 输出显示乱码（代码页问题） | 落盘文件名和 `index.md` 内均正确，不影响使用；需要看控制台时 `chcp 65001` |
| >100MB 文件未分块 | 单次 SFTP `get` 全量传输 | 大文件改 `sftp().open()` + 分块读写，或走 `scp -C` 压缩传输 |
| 非 Windows 环境 | `files/` 路径用 `/` 分隔已兼容，`os.path.join` 在产物目录上仍是平台相关 | 已在 `index.md` 里统一 `.replace('\\','/')`，跨平台可读 |

## 示例

task 1875（实测）：

```powershell
python zentao.py task 1875
# out\task_1875\index.md  (4 附件下载成功, 0 失败)
```

拿到：
- 任务 1875 字段表（closed、40h 预计、16h 消耗、指派 llh→liqiang→huzhihao）
- 8 条任务操作记录（含 `recordworkhour` 8h「开发」、`finished`「开发联调」）
- **关联需求 1313 的完整 5279 字正文**（业务规则、UI 交互、异常规则、权限规则）
- 需求 4 张附件图实体（18269 是 2236x1660 的 4 页 UI 原型，18353 是 gcq 备注里的分值界面截图）
- 需求 15 条备注（gcq 的「5/30」分值规则、zhunan 的扣分制说明）

其他实测：`bug 5494`（3 附件 + 重现步骤）、`story 1313`（4 附件）、`bug 5666`（31 附件，含关联需求 1229 的 22 条备注）、`task 2056`（同时递归到需求 1242 与 Bug 5262）、`bug 1694`（78MB log）、`task 114`（33MB zip，解压校验 13 条目通过）、`bug 5320`（16MB pdf，`%PDF-1.4` 头 + `%%EOF` 尾完整）。

## 后续开发用法

提取完成后直接读 `index.md`：
1. 先看关联需求段的 `## 需求正文` —— 这是业务规格
2. 再看备注段的 `> ` 引用块 —— 这是评审时的规则澄清和补充约束
3. 图片按 `files/` 路径直接 `read_image` 查看 UI 原型
4. 正文里的 `{18269.png}` 占位符对应附件表里同 id 的行
