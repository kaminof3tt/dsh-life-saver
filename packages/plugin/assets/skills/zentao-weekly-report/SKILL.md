---
name: zentao-weekly-report
description: 禅道个人周报自动出具 —— 连禅道 MariaDB 取某人一周的工时/任务/Bug/需求，按公司「研发部周总结+下周计划」xlsx 模板生成成品，并做「本周表 vs 工时库」「下周计划 vs 未完成待办」双对账与排版目检。当用户说「整理 XXX 的本周工作总结」「出周报」「再生成一个本周的 / 上周的」并给出数据库连接或禅道账号时使用。
whenToUse: 用户提出按人/按周出工作总结或工作计划，尤其提到禅道、工时、周报、研发部周总结模板时。
---

# 禅道个人周报

流水线：定口径 → 取数 → 归类 → 填模板 → **双对账** → 排版目检 → 交付。

## 快速路径（照着跑）

脚本都在本 skill 目录的 `scripts/` 下（`<本 skill 目录>` 就是加载本 skill 时给出的 base directory，绝对路径见加载时的 skill_resources）。所有脚本**只从环境变量读连接信息，没有默认值**，先按下方「连接配置」一节把变量导好。

```bash
# 0) 建工作目录，把下面几节里的 SQL 跑成 UTF-8 结果文件
mkdir -p <工作目录> && cd <工作目录>
C:/Python313/python.exe <本 skill 目录>/scripts/q.py s1.sql o1.txt

# 1) 先看全量待办，确定下周计划该覆盖什么（这一步以前漏了，导致计划表 bug 少列 8 个）
C:/Python313/python.exe <本 skill 目录>/scripts/audit_backlog.py huzhihao

# 2) 写 spec.json（week 本周行 / plan 下周行），生成
C:/Python313/python.exe <本 skill 目录>/scripts/build_week.py spec.json

# 3) 双对账，两个都要退出码 0
C:/Python313/python.exe <本 skill 目录>/scripts/verify_week.py "D:/Document/公司/研发-后端-胡志豪_<起>-<止>.xlsx" <起> <止> huzhihao
C:/Python313/python.exe <本 skill 目录>/scripts/audit_backlog.py huzhihao spec.json

# 4) 排版目检
powershell -NoProfile -ExecutionPolicy Bypass -File <本 skill 目录>/scripts/topdf.ps1 -Xlsx "<xlsx>" -Pdf "out.pdf"
C:/Python313/python.exe <本 skill 目录>/scripts/pdf2png.py out.pdf pg 110
```

## 连接配置（环境变量，无默认值）

脚本不写死任何连接信息，**四个变量必须齐全**，缺一个脚本就直接报错退出（退出码 2，会打印缺哪几个），不会回落到任何内置值：

| 变量 | 含义 |
|---|---|
| `ZENTAO_DB_HOST` | 禅道库地址 |
| `ZENTAO_DB_PORT` | 端口 |
| `ZENTAO_DB_USER` | 账号 |
| `ZENTAO_DB_PASSWORD` | 口令 |

```powershell
$env:ZENTAO_DB_HOST = '<host>'
$env:ZENTAO_DB_PORT = '<port>'
$env:ZENTAO_DB_USER = '<user>'
$env:ZENTAO_DB_PASSWORD = '<password>'
```

```bash
export ZENTAO_DB_HOST='<host>' ZENTAO_DB_PORT='<port>' ZENTAO_DB_USER='<user>' ZENTAO_DB_PASSWORD='<password>'
```

库名默认 `zentao`，可用 `ZENTAO_DB_NAME` 覆盖。

**取值来源**：本机装了 `dsh-life-saver` 插件时，地址/端口/账号照设置页里 `db.host` / `db.port` / `db.user` 填（或直接跑一次 `zentao_status()` 看现成输出），口令对应 `ZENTAO_DB_PASSWORD`。环境变量与服务端配置保持一致即可，不用另猜。

## 环境常量（本机，已验证）

| 项 | 值 |
|---|---|
| Python | `C:\Python313\python.exe`（已装 pymysql / openpyxl / pymupdf） |
| 公司模板 | `D:\Document\公司\研发-后端-胡志豪.xlsx`（**只读，永远不覆盖**，改副本） |
| 成品命名 | `D:\Document\公司\研发-后端-胡志豪_<YYYYMMDD>-<YYYYMMDD>.xlsx` |
| 本 skill 脚本 | base directory 下的 `scripts/`（加载本 skill 时给出的绝对路径） |

工具环境注意：本机官方 `pwsh` 工具可能被替换成 `ops_bash`（报错 `dsh-ops standard mode replaced the official tool pwsh`），命令一律走 `ops_bash`（bash 语法，路径用 `/c/...` 或 `D:/...`）。

## 一、定口径

- 「本周」= 周一 ~ 周五，标题写 `研发部YYYY.MM.DD 至 YYYY.MM.DD 工作总结`。
- **取工时的日期窗口要比汇报周多往前 2 天**（例：汇报 10.26~10.30，工时窗口取 10-24 ~ 10-30），避免周末补登记的工时被漏掉。
- 下周计划表标题 = 下周一 ~ 下周五，`研发部YYYY.MM.DD 至 YYYY.MM.DD 工作计划`。
- 时间以系统采样时间为准，不猜。

## 二、取数

用 `scripts/q.py`（多条 SQL 用 `;;` 分隔，结果落 UTF-8 文件再 cat，**别直接 print 中文到控制台，GBK 会乱码**）：

```sql
-- 1. 本周工时明细（按对象聚合）
SELECT e.objectType, e.objectID, SUM(e.consumed) h, MIN(e.date) d1, MAX(e.date) d2
FROM zt_effort e JOIN zt_user u ON u.account=e.account
WHERE u.account='huzhihao' AND e.date BETWEEN '2026-10-24' AND '2026-10-30'
GROUP BY e.objectType, e.objectID;;
```

```sql
-- 2. 有动作但没登记工时的对象（真正的漏项高发区）
SELECT a.objectType, a.objectID, COUNT(*) n, MIN(a.date) d, MAX(a.date) d2
FROM zt_action a JOIN zt_user u ON u.account=a.actor
WHERE u.account='huzhihao' AND a.date BETWEEN '2026-10-24 00:00:00' AND '2026-10-30 23:59:59'
GROUP BY a.objectType, a.objectID;;
```

```sql
-- 3. 本周被改动的 bug 状态流转（判断"关闭/转他人/待验证"）
SELECT id, LEFT(title,60) t, status, resolvedBy, assignedTo, DATE(resolvedDate) rd, DATE(closedDate) cd
FROM zt_bug WHERE id IN (...);;
```

```sql
-- 4. 任务/需求兜底（进度、剩余工时、关联需求）
SELECT id, name, status, estimate, consumed, `left`, project, story FROM zt_task WHERE id IN (...);;
SELECT id, title, stage, status, assignedTo FROM zt_story WHERE id IN (...);;
```

看板字段含义：`zt_effort.objectType` ∈ {task, bug}；`consumed` 单位小时；`resolvedBy` 是真正修复人，`assignedTo` 是当前处理人 —— **两者不一致说明"我排查定位→转别人修复"，这类必须照样进表**（这是用户明确会抽查的点）。

## 三、归类规则

**项目 / 分支映射**（写死在 `build_week.py` 的 `PROJ`，新增项目要同步改）：

| 键 | 项目 | 分支 |
|---|---|---|
| YQ | 园区物管 | `develop/v2.6.2-yuanqu-wg` |
| SZH | 苏住房 | `develop/v2.6.2-suzhufang-dev` |
| KS | 昆山物管 | `suzhou-kunshan-dev-v1.39.4` |
| WX | 无锡三资 | `develop/v2.6.2-wuxisanzi` |
| TC | 太仓物管 | `suzhou-taicang-wuguan-dev-v1.26` |
| TX | 泰兴物管 | `develop/v2.6.2-taixing` |
| YQ0 | 园区V0 | `dev` |
| HS2 | 惠山物管 | `develop/v2.6.2-huishan` |
| HS1 | 惠山物管V1 | `dev` |

> HS1/HS2 的区分依据 `zt_project`：144「【物管平台V1】无锡惠山物业管理项目」→ HS1（`dev`）；193「【物管平台】惠山市智慧物业服务平台」→ HS2（`develop/v2.6.2-huishan`）。6208（惠山维修资金）属 HS1，5683 也属 HS1；5410/5462/5470/5474/5524/6124 属 HS2。不要把 HS1 写成「惠山维修资金」——它实际是 V1 项目线。

分支名以 `git branch -a` 实拉为准，别凭印象写（曾把泰兴写成 trunk、苏住房漏了 `-dev` 被用户当场纠正）。

**已核实的仓库 → 分支对应**（`D:\workspace\<项目>\` 下的实际仓库）：

| 项目 | 仓库路径 | 分支 |
|---|---|---|
| 园区物管 / 园区V0 / 苏住房 / 惠山物管 | `estate-manage-yuanqu`、`estate-manage-suzhufang`、`estate-manage-huishan` | 见上表 |
| 昆山物管 | `D:\workspace\昆山物管v1\zhi1-backend-kunshan-wuguan` | `suzhou-kunshan-main-v1.39.4`（开发线用 `suzhou-kunshan-dev-v1.39.4`） |
| 太仓物管 | `D:\workspace\太仓物管v1\zhi1-backend-taicang-wuguan` | `suzhou-taicang-wuguan-dev-v1.26` |
| 惠山物管V1 | `D:\workspace\惠山物管v1\zhi1-backend-huishan-wuguan` | `dev` |
| 泰兴物管 | `D:\workspace\泰兴物管v2` → `estate-manage-2.6.2-taixing` | `develop/v2.6.2-taixing` |

**任务类型**：`kind=task/story` → `功能开发`；`kind=bug` → `BUG修复`。

**目前进度**：bug 修完统一 `100%`；任务按 `consumed/(consumed+left)`，如 2042 用 5h 剩 3h → 60%；暂停任务按历史进度（903 = 80%）。

**进本周表的对象**：本周有工时，或本周有实质动作（关闭/修复/转派/评论分析文档）的对象。

**排除的三类**（要在回话里说明理由，别默默丢）：
1. 【前端】子任务 —— `finishedBy` 是前端同事（jiangxuezhe/tiany），工时记在前端名下，本人只开单与关闭。
2. 只转了一条评论/SQL 配置、无开发工时的任务。
3. `status=wait`、本周 0 工时的任务 → 放到**下周计划**表。

**无工时但有动作的 bug**：`zt_effort` 查不到记录 → 用 `zt_bug.resolvedDate/closedDate` 补起止日期，工时列留空，备注写「未单独登记工时」。

**下周计划必须覆盖全量待办**：bug / task / story 三层一条都不能少，用 `audit_backlog.py` 自动盘（见 5.2），别只挑几个「存量缺陷」顶上 —— 曾只列 4 个、实际 12 个，被用户当场指出「下周计划里的 bug 统计不对」。severity=1 的备注「致命问题」、2 的写「非常严重」。

## 四、生成

写一份 spec.json（结构见 `scripts/build_week.py` 顶部注释；`scripts/example_spec.json` 是 2026.10.26 那期的完整实例，直接改日期和行即可），然后：

```bash
cd <工作目录>   # 把 spec.json 放在这里
C:/Python313/python.exe <本 skill 目录>/scripts/build_week.py spec.json
```

脚本干的事：复制模板 → 从 `zt_bug.title` / `zt_task.name` / `zt_story.title` **现取标题** → 从 `zt_effort` 现算起止与工时 → 第 3 行样式为模板逐行刷格式 → 删多余模板行 → 保存。

打印 `saved ... week rows N hours H plan rows M hours P`，H 必须等于库里的合计。

## 五、对账（两道，必做）

### 5.1 本周表 vs 工时库（verify_week.py）

```bash
C:/Python313/python.exe verify_week.py "D:/Document/公司/研发-后端-胡志豪_20261026-20261030.xlsx" 2026-10-24 2026-10-30 huzhihao
```

判据：`缺项(库有表无)` 必须为空、合计工时必须一致；`多项(表有库无工时)` 允许出现，那是补录的无工时 bug。退出码 0 才算过。

注意路径：`verify_week.py` 与 `audit_backlog.py` 都在本 skill 的 `scripts/` 下，用 base directory 拼出来的绝对路径调用；`spec.json` 与 xlsx 用相对/绝对工作目录路径均可。

### 5.2 下周计划 vs 未完成待办（audit_backlog.py）

**这一步是防「计划漏项」的硬闸门**，必须先跑再交付：

```bash
C:/Python313/python.exe audit_backlog.py huzhihao spec.json
```

脚本会把库里三层待办全量打出来，再与 `spec.plan` 做差集：

| 层 | 判定条件 |
|---|---|
| 未解决 bug | `zt_bug.assignedTo=账号 AND deleted='0' AND status='active'` |
| 未完成任务 | `zt_task.assignedTo=账号 AND deleted='0' AND status IN ('wait','doing','pause')` |
| 未启动需求 | `zt_story.assignedTo=账号 AND deleted='0' AND stage='projected'` |

判据：三个 `[OK]` 且**退出码 0** 才能交付。任何 `[漏项]` 都要补进 `spec.plan` 后重跑。
需求层的覆盖判定允许「由其下任一任务覆盖」——周报里通常列任务而非需求本身。

> 教训：曾只从上周计划照搬 4 个「存量缺陷」当下周 bug 清单，实际库里指派未解决的有 12 个，被用户当场指出「下周计划里的 bug 统计不对」。这个脚本就是为了把这种遗漏堵死。

## 六、排版目检（必做）

本机**没有 LibreOffice**（`C:/Program Files` 与 `D:/Program Files` 下均无 soffice.exe），走 Excel COM：

```bash
cd <工作目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .../scripts/topdf.ps1 -Xlsx "<xlsx>" -Pdf "<out.pdf>"
C:/Python313/python.exe .../scripts/pdf2png.py out.pdf pg 110
```

然后 `read_image` 看 pg1.png/pg2.png：中文换行是否正常、备注列右边界有没有被切、行高有没有压行。Sheet1 通常占 2 页，Sheet2 占 1 页。

## 七、坑（踩过一次就别再踩）

1. **单元格文本必须来自库内字段**。手写简写版（漏【园区物管客测】等前缀）会被用户逐条比对挑出来，已发生两次。
2. **下周计划不能只抄上周的存量缺陷**，必须跑 `audit_backlog.py` 全量核对（已发生一次，被用户指出 4 个 vs 实际 12 个）。
3. `topdf.ps1` 必须存成 **UTF-8 with BOM**，否则中文路径被按 ANSI 解成乱码，Excel COM 抛 `COMException 无法找到 D:\Document\公司\...`。
4. **不要提前 `cur.close()`**：取标题要复用游标，先全部取完再 `conn.close()`，否则 `pymysql.err.InterfaceError: (0, '')`。
5. 行高要按「显示宽度 ÷ 列宽」估算换行行数（`math.ceil(disp_len/列宽)`），否则 Excel 打开压成一行。
6. 分支名列宽设 34，默认 12 放不下 `suzhou-taicang-wuguan-dev-v1.26`。
7. 模板容量有限：Sheet1 最多 33 行、Sheet2 最多 21 行，超了要扩模板或用 `insert_rows`。本周计划表已经到 20 行，接近上限。
8. `openpyxl` 复制行样式要 `copy(cell._style)`；直接赋值 `cell.style` 会丢边框。
9. 日期列 `number_format='yyyy/mm/dd'`，进度列 `'0%'`。
10. **PowerShell 里 `rm -f` 不可用**（会被解析成 `Remove-Item -Filter/-Force` 二义性报错），删文件用 `Remove-Item a,b,c -ErrorAction SilentlyContinue`。
11. **`tail`/`head` 在原生 PowerShell 里没有**，用 `$out | Select-Object -Last N`；`ops_bash` 模式下才可用 bash 语法 —— 先确认当前是哪个工具。

## 八、交付话术

回话给：文件路径（`present` 一张卡片）、两表行数与合计工时、**按用户核对意见的逐条修正表**、**"有没有漏项"的审计结论**（给出库里的对象数与表内行数的一一对应关系，并点明"排查后转他人"的 bug 已包含）、被排除对象的理由。不要复述取数过程。
