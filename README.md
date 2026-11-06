# dsh-life-saver

DSH 原生插件：把禅道的需求 / 任务 / BUG 直接变成 Agent 能读的内容（正文、备注、操作记录、附件实体），
不要在会话里现写 SQL 或抓页面。

给一个编号就出结果，例如「bug 5967 重现步骤看一下」——Agent 会调 `zentao_read`。

也能反过来写：把任务做完、记工时、解决/关闭 BUG、加备注，以及统计某人任意区间干了什么、花了多少工时。
写操作真的改数据（没有 dry-run），护栏写在[写入禅道](#写入禅道zentao_task_op--zentao_bug_op)一节。

## 仓库结构（本仓是 pnpm workspace）

| 目录 | 发到 npm 的名字 | 是什么 |
|---|---|---|
| `packages/core` | `life-saver-core` | 与框架无关的取数/写入层：两条通道（只读库 + SFTP、账号密码走页面）、配置 schema、域模型与渲染。零 `@deepseek-ai` 依赖，MCP 服务器也能直接用它 |
| `packages/plugin` | `dsh-life-saver` | DSH 插件壳：cordis 入口、8 个工具、3 个随包发布的技能、`/api/dsh-life-saver/*` 桥接路由、设置页、拉完内容开新会话 |

装进 DSH 的是 `packages/plugin`，但它依赖 `life-saver-core`，所以两个包都得构建。
`lib/` 不再随仓库提交（`.gitignore` 里有），克隆下来要先构建。

## 安装

```bash
git clone https://github.com/kaminof3tt/dsh-life-saver.git
cd dsh-life-saver && pnpm install && pnpm build
```

然后在 DSH 的 profile 目录（`~/.dsh/profiles/<profile>/`，桌面版是 `desktop`）做两件事：

1. `package.json` 的 `dependencies` 加一行 `"dsh-life-saver": "link:<仓库绝对路径>/packages/plugin"`；
2. 同一个 `package.json` 的 `dsh.profile.bundles` 数组里加 `"dsh-life-saver"`。

重启 DSH，插件页就会出现这一项；点进去的组件行就是配置页。

## 本机安装明细

| 项 | 值 |
|---|---|
| 安装位 | `<profile>/node_modules/dsh-life-saver`（junction → 仓库的 `packages/plugin`） |
| 登记 | profile 的 `package.json`：`dependencies["dsh-life-saver"] = "link:<仓库绝对路径>/packages/plugin"`，并加进 `dsh.profile.bundles` |
| 装载行 | 由本包的 `cordis.patch.yml` 自己 `- insert:`（`id: life-saver`）；profile 的 `cordis.patch.yml` 只按 `- id: life-saver` 覆盖配置 |
| 配置页 | GUI → 插件 → dsh-life-saver → 配置 |

> **插件页只列 bundle**。DSH 判定「是不是 bundle」的规则是：`profile/package.json` 的 `dependencies` 里有它 **且** 它的 `package.json` 声明了 `dsh.bundle.patch`。
> 只在 profile 的 `cordis.patch.yml` 里写 `- insert:` 能让宿主半侧加载（工具、bridge 都活），但**插件页不会出现这一项**，配置页也就无从打开。

改完代码怎么生效，三种情况别混：

| 改了什么 | 怎么生效 |
|---|---|
| `cordis.patch.yml` 的 config | 热生效，存盘即可（loader 监听这个文件） |
| 宿主源码（tools / channels / bridge）→ `lib/*.js` | **要重启 DSH**：插件页会提示「请重启 DSH 使更改生效 · 更改涉及 DSH 自身已加载的模块」 |
| 客户端页面 `packages/plugin/src/client/index.jsx` → `lib/client.js` | 刷新浏览器即可（bundle 在页面启动时装载） |

`pnpm build` 会按依赖顺序先出 core 的 `lib/*.js` + `*.d.ts`、再出插件的宿主与客户端产物；判断线上跑的是哪一版，看插件页有没有「需要重启」的提示。

## 两个通道

| 通道 | 需要 | 能给的 | 代价 |
|---|---|---|---|
| `db`（默认） | MySQL 只读账号 + SFTP | 正文、备注、操作记录、附件实体、**工时统计** | 字段口径跟禅道版本走 |
| `http` | 禅道账号密码（登录拿 cookie 抓页面） | 正文、备注、附件清单、**写操作（推荐）** | 慢；要账号有页面权限 |

`mode: auto` 时先用 db，失败再退 http。两条都失败会同时报两个错，不会静默返回空。
**只有读操作按这个顺序**——写操作是反过来的（默认先 http），因为走页面能让禅道自己把副作用写全；理由见[写入禅道](#写入禅道zentao_task_op--zentao_bug_op)。

DB 通道读数据时刻意不碰登录态：不写 `zt_action`、不在禅道审计里留痕，也不受「某人打开了所有需求」这种告警影响。
（只有显式把 `write.mode` 设成 `db` 时才会写库。）

### 直接贴链接也行

`zentao_read` 的 `id` 除了整数编号，也收浏览器地址栏里的禅道链接——它自己认类型和编号，不听调用方 `kind` 的（链接说的是什么就是什么）：

```
http://zentao.example.com/index.php?m=bug&f=view&bugID=5967
http://zentao.example.com/zentao/task-view-1875.html
http://zentao.example.com/index.php?m=story&f=view&storyID=1313#app=qa
http://zentao.example.com/index.php?m=story&f=view&id=1389  （biz 版用通用 id=）
#bug=5967 / storyID=1313 / 纯编号 5967
```

认不出来就报错让你给编号，绝不猜——猜错编号会把别人的需求读成你的。

## 配置

配置项都在 `packages/core/src/config.ts` 里声明，全部 `volatile`（可在 GUI 里改、即时生效）。密码走 DSH 凭据服务，不进配置文件：

| 配置 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto` / `db` / `http` |
| `http.baseUrl` | 空 | 禅道根地址，例如 `http://zentao.example.com`；带不带 `/zentao` 后缀都行 |
| `http.account` | 空 | 禅道登录名 |
| `http.timeoutMs` | `60000` | 单次页面请求超时 |
| `http.skin` | `auto` | 页面皮肤：`auto` / `detail-section`（禅道 15+/biz）/ `detail`（12.x）/ `article`。读不到正文时手工钉死比自动认更快 |
| `db.keywords` | `auto` | 搜索是否匹配 `keywords` 列：`auto` / `on` / `off`。搜索报 SQL 错（老库没这列）时钉死 `off` |
| `db.host` `db.port` | 空 `3306` | 只读库 |
| `db.database` `db.user` `db.prefix` | `zentao` 空 `zt_` | 表前缀跟部署走 |
| `discovery.enabled` | `true` | 体检时自动探测结构（皮肤 / 登录算法 / 库列与关联表）。关掉 = 一律用默认结构 |
| `discovery.ttlMs` | `600000` | 探测缓存时长；换库地址或站点地址会自动重探，`0` = 每次体检都重探 |
| `sftp.host` `sftp.port` `sftp.user` | 空 `22` 空 | 附件实体 |
| `sftp.uploadBase` | 空 | 禅道 upload 目录绝对路径，例如 `/home/zentao/zentao/www/data/upload`（**不带**产品号，插件自己扫 `upload/1/…`） |
| `limits.*` | 见源码 | 超时、并发、附件数量/大小上限 |
| `output.dir` | 空 | 附件落盘目录；空则用 `<会话工作区>/zentao-extract/<kind>-<id>/`（取自会话 header 的 cwd，不是宿主进程 cwd） |
| `targets` | `""` | 工作区目标表，JSON 数组字符串（页面里有可视化编辑器，一般不用手写），见下节 |
| `session.enabled` | `true` | 总开关；关了就完全不能用「开新会话」 |
| `session.agentAutoStart` | `false` | 允许 Agent 自己调 `zentao_session_start`。默认关：只有人在页面上点按钮才会开 |
| `session.autoPrompt` | `false` | 建好会话后是否自动把开场提示词发出去（发出去就是一轮真 LLM 调用，会计费） |
| `session.promptTemplate` | 空 | 自定义开场提示词，占位符 `{{kind}} {{id}} {{title}} {{target}} {{dir}} {{repos}} {{branches}} {{submodules}} {{submodulebranches}} {{zentao}}`；空则用内置模板 |
| `session.reuseExisting` | `true` | 同一编号之前开过会话时，回到那个旧会话继续，而不是新建。只认编号（标题里的 `#编号`），不看标题是否改过；同编号不在这个工作区就照常新建 |
| `write.enabled` | `true` | 写能力总开关。关掉 = 插件完全只读，`zentao_task_op`/`zentao_bug_op` 直接拒绝 |
| `write.mode` | `http` | `http`（走禅道表单页，推荐）/ `db`（直接改库）/ `auto`（先页面，通道不可用时降级到库） |
| `write.allowOthers` | `false` | 是否允许改「指派给别人且不是自己创建」的任务/BUG。默认只动自己名下的 |

凭据键（用 DSH 凭据服务存，或临时用同名环境变量）：

- `ZENTAO_PASSWORD` —— `http.account` 的密码
- `ZENTAO_DB_PASSWORD` —— `db.user` 的密码
- `ZENTAO_SFTP_PASSWORD` —— `sftp.user` 的密码（和 DB 密码常常相同，但分开存）

### 换一台机器装：哪些必须配，哪些它自己认

**必须配的**（这几项猜不出来，也不该猜）：`http.baseUrl` + `http.account`、`db.host` / `port` / `database` / `user` / `prefix`、`sftp.host` / `user` / `uploadBase`，三把密码进凭据中心；`targets` 里的工作区绝对路径各机器不同，得单独配。

**它自己认的**（换禅道版本最容易出问题的地方）：详情页是哪套皮肤、登录密码用二次 md5 还是直接 md5、库里有没有 `keywords` 列、需求是挂在 `zt_projectstory` 关联表还是 `zt_story.project` 列。

- 探测只在 `zentao_status` 体检时跑，且只在已经连通的通道上跑——**不猜 host、库名、账号**（猜错库等于读到别人公司的单子）。
- 探测结果在内存里缓存，默认 10 分钟；库地址 / 站点地址一变（部署指纹变了）立即重探。
- 结论在 `zentao_status` 的「结构探测（自探索）」段里能看到，标「未确认」说明这一项正用着代码默认值。
- 探测失败不会影响读：退回默认层照常工作，只是状态页会显式标出来。
- 认错了才需要手工钉死：读实体报 `skin-unknown` → 配 `http.skin`；搜索报 SQL 错（老库没 `keywords` 列）→ 配 `db.keywords=off`。插件页「结构探测（自探索）」里有下拉框。

## 八个工具

```
zentao_read          ({ kind, id, scope?, download?, outDir?, includeRelated? })
zentao_search        ({ query, kind?, limit? })
zentao_status        ()
zentao_workhours     ({ from, to, account?, kind?, detail?, limit? })
zentao_task_op       ({ id, action, comment?, consumed?, left?, date?, realStarted?, finishedDate?, assignedTo?, expectStatus? })
zentao_bug_op        ({ id, action, comment?, consumed?, date?, resolution?, resolvedBuild?, duplicateBug?, assignedTo?, expectStatus? })
zentao_commit        ({ kind?, id?, repo?, files?, message?, dryRun?, push? })
zentao_session_start ({ kind, id, targetId?, prompt?, dryRun?, cloneMissing?, update?, reuse? })
```

- `zentao_read`：`kind` = `story|task|bug`，`id` 是禅道编号。`scope: brief` 只要字段和正文；默认 `full` 连备注与附件表。
  `download: true` 才落附件实体（截图/文档），路径直接回在结果里。
  `includeRelated` 默认 `true`：任务→关联需求、BUG→关联任务/需求、子需求→父需求。
- `zentao_search`：只用来定位编号，正文请接着 `zentao_read`。
- `zentao_status`：两条通道各自「配没配、连不连得上、能干什么」，排障先跑它。
- `zentao_workhours`：查某人任意区间的工时（**只走库**，见下节）。`from`/`to` 是 `YYYY-MM-DD`，`account` 不填用 `http.account`。
  返回合计、按对象分组（做了什么，每组多少小时）、按天分布，以及「有动作但没记工时」的漏项提醒。
- `zentao_task_op`：改**任务**。`action` = `start` / `recordworkhour` / `finish` / `pause` / `activate` / `close` / `cancel` / `comment`。
- `zentao_bug_op`：改**BUG**。`action` = `confirm`（确认）/ `resolve`（解决）/ `close`（关闭）/ `comment`（备注）/ `recordworkhour`（记日志工时）。
- `zentao_session_start`：读完编号后在对应工作区**开一个新会话**去干活，见下节。
- `zentao_commit`：把**本次对话改的文件**提交成一条带禅道单子信息的提交，见「提交代码（zentao_commit）」。

## 三个随包技能

插件里带了三份 SKILL.md，装完插件就在技能清单里，**不用再手工往 `~/.dsh/skills/` 拷**。
资产在 `packages/plugin/assets/skills/<name>/`，包内以 bundled provider 注册（`provider: "dsh-life-saver"`）。

| 技能 | 干什么 |
|---|---|
| `zentao-extract` | 给编号就全量提取：正文、备注、操作记录、附件实体，并递归带出关联需求的正文/备注/附件。首选通道就是本插件的 `zentao_read`，插件不可用时退回 `D:\workspace2\zentao\zentao.py` |
| `zentao-change-assignee-scrub-trace` | 改派 + 抹痕迹：一个事务里删掉该次 `assigned` 在 7 张表里的行、回写业务表 4 个字段、对齐 `zt_history`，让页面看不出后期改动 |
| `zentao-weekly-report` | 个人周报：按公司模板出 xlsx，做「本周表 vs 工时库」「下周计划 vs 未完成待办」双对账，再排版目检。`scripts/` 里 7 个脚本（6 个 Python + 1 个 PowerShell）随包发布 |

三点要知道的：

1. **优先级**：bundled 的 rank 是 600，用户级 `~/.dsh/skills/` 是 400 —— 数字小的优先级高，所以**本机已经存过同名 skill 的人用的还是自己那份**，插件版只是给没存过的人一个开箱可用的默认。想用插件版就把 `~/.dsh/skills/<name>/` 挪走。
2. **脚本不写死连接信息**：weekly 的 6 个 Python 脚本和 scrub-trace 的骨架都只读环境变量（`ZENTAO_DB_HOST` / `ZENTAO_DB_PORT` / `ZENTAO_DB_USER` / `ZENTAO_DB_PASSWORD`，库名可选 `ZENTAO_DB_NAME`），**四个全必填、没有默认值**，缺一个直接退出码 2。取值照设置页的 `db.*` 填就行。
3. **资源目录**：加载技能时 `<skill_resources>` 给的就是 `assets/skills/<name>/` 的绝对路径，`scripts/xxx.py` 按它拼。

## 写入禅道（zentao_task_op / zentao_bug_op）

**这两组工具会真的改数据，没有预览、没有 dry-run。** 这是刻意的：多一步「先给我看看」在真实工作中只会被跳过去，
真正起保护作用的是下面这些护栏和两条线的分工。

### 八道护栏

1. **总开关**：`write.enabled=false` 时这两个工具直接拒绝（此时插件是完全只读的）。
2. **先读后写**：动手前先按读路径取一次当前状态（也就是 `zentao_read` 看到的那个），拿它做「写前」快照和状态判断。
3. **状态白名单**：动作与当前状态不匹配就拒绝。`start` 只接受 `wait`；`finish` 只接受 `doing`/`wait`/`pause`；
   `pause` 只接受 `doing`；`activate` 只接受 `pause`/`done`/`cancel`/`closed`；`close` 只接受 `done`/`cancel`；
   BUG 的 `confirm`/`resolve`/`recordworkhour` 只接受 `active`（`recordworkhour` 也接受 `resolved`）、`close` 只接受 `resolved`。
4. **归属校验**：默认只允许动「指派给自己或自己创建的」任务/BUG。要代别人操作得显式打开 `write.allowOthers`。
5. **`expectStatus` 断言**：传了就要求当前状态严格等于它，否则拒绝——适合「我知道它现在是 doing，不是就别动」。
6. **写后自校验**：写完立刻回读一次，把写前/写后一起回给你。状态没变时还会额外警告（`comment`/`recordworkhour`/`confirm` 本来就不改状态，不在此列）。
   `comment` 与 BUG 的 `recordworkhour` 还会**断言确实落地了**（备注条数 / 日志条数没涨就报错）——因为禅道这两种表单
   都存在「回包说成功、实际什么也没写」的情况（BUG 日志用平铺字段提交时实测如此）。
7. **一次一条**：不接受批量，也不接受一次多个动作。批量是事故的温床。
8. **DB 线单事务 + 字段白名单**：整次写入在一个事务里，任何一步异常全部回滚；可写字段写死在白名单里，
   事务内禁止多语句 SQL（这三条是 `db/pool.ts` 文件头的老约束，写能力上线后仍然全部成立）。

### 两条通道怎么对齐状态

DB 线天生给机器码（`doing`），HTTP 线页面上是中文（`进行中`）、人员是中文名（`张三`）。
护栏要拿这些东西跟动作白名单、跟 `http.account` 比，所以 HTTP 通道会额外产出 `codes`（`doing` / `zhangsan`）：

- 状态机器码来自页面上的 `span.status-xxx`（限定在 `.datalist-item-content` 内取，避免命中页面开头的内联样式表）。
- 人员账号靠 `GET /index.php?m=company&f=browse&t=json` 的 `userPairs`（一次给全，`{账号: 中文名}`）反查，缓存 10 分钟。
- **反查表取不到时不硬认**：此时归属校验放行（宁可少拦一次，也不要给出「你不是自己任务负责人」这种荒谬结论）。

`zentao_read` 输出里 `codes` 只有 HTTP 线才有；DB 线本来就是机器码，不需要它。

### 表单默认值要回填（HTTP 线的一个硬要求）

禅道的写动作 model 多半是 `fixer::input('post')` **全量落库**：POST 里没出现的列，会被写成库的默认值或空串
（本库 `sql_mode=''`，空串直接落库）。实测后果是：只发 `comment` 去确认 BUG，会把 `pri` 1→3、`type` 清空、
`deadline` 清空、`assignedTo` 清空。

浏览器不会出这事，是因为它把表单上**每个控件的当前值**都回传了。所以插件也照做：

1. 先 `GET` 对应的表单页（`?m=bug&f=confirm` 这种），从 HTML 里读出所有控件的当前值
   （普通 `input`/`textarea`，以及 zui 的 `picker`/`priPicker`/`datePicker`/`datetimePicker` 里的 `defaultValue`）；
2. 用这份「默认值」打底，再把我们真正想改的字段盖上去（`set` 覆盖），最后补 `uid` 一起提交。

`uid` 由调用方单独设置；`files[]`（上传控件）、`team*`（多人任务里是 JS 拼串占位值）、`contactList` 这类不回填。
这套逻辑是纯函数 `readFormDefaults()` / `mergeFormDefaults()`，状态与载荷都离线测得住（`test/http-payload.test.mjs`）。

### 两条线：写走页面，统计走库

- **默认 `write.mode=http`：走禅道自己的表单页。** 好处是副作用由禅道自己写全（历史面板、通知、泳道、附件、需求阶段…），
  以后升级禅道也不失配。代价是要求账号有页面权限，且比直接改库慢。
- **`write.mode=db`：直接改库。** 复刻了禅道 `task`/`bug` 的 model 语义，一次事务写全
  `任务/BUG` 本体 + `zt_effort` + `zt_action` + `zt_actionrecent` + `zt_history` + `zt_notify` + `zt_kanban*` + `zt_actionproduct`。
  适合不想走页面、或页面权限受限的场景；**升级禅道后需要重新核对**。
- **BUG 的「日志」（`recordworkhour`）走的是 biz 版独立的 `effort` 模块**（`?m=effort&f=createForObject&type=bug&bugID=N`），
  和任务的 `?m=task&f=recordworkhour` 是两套表单。库内只写 `zt_effort` + `zt_action(recordestimate)` + `zt_actionrecent`
  + `zt_history(consumed 累计值)` + `zt_actionproduct`，不动 `zt_bug` 的业务字段（那张表压根没有 consumed 列），也不发通知。
- **`write.mode=auto`：先页面，业务拒绝才降级到库。** 注意「业务拒绝」（如状态不对、必填项缺失）**不会**降级——
  换条线照样会被拒，只会掩盖真实原因。只有通道本身不可用（没配密码、页面权限不足、连不上）才降级。
- **统计（`zentao_workhours`）永远走库**，且只走库：`zt_effort` 是唯一按人记工时的表，页面没有等价的一次性查询。

### 已知限制（DB 线，`write.mode=db` 时适用）

DB 线现在**和页面线功能等价**：父任务状态汇总、需求阶段推进、搜索索引、BUG 解决后的测试单/版本回填都复刻了。
下面这些是刻意的取舍或环境事实，不是漏做：

- **不写 `parent='-1'`**。源码 `updateParentStatus()` 会把父任务标成 `-1`，但本库 175 个父任务的 `parent` 全是 `0`，
  照抄会在页面上多出一个「父任务」标记。以库内现状为准，不写。
- **「只有工时变化、状态没变」不写上级动作**。源码在这种情况下会造一条 `Edited`，但本库 335 条父任务状态动作里
  14 条 `edited` 全是真人改字段（history 里有 `docVersions`/`name`/`desc`），没有一条是汇总触发的。以库内现状为准。
- **父任务汇总动作不发通知**。实测 5 个父任务聚合动作（如 `task 1356` 的 `started`/`finished`）`zt_notify` 都是 0 行。
- **通知本来就稀疏**：真实库里 `finished 1946 条动作只有 168 条带通知`、`started 473/9`、`recordworkhour 116/0`。
  这说明发不发取决于禅道的通知偏好设置（插件读不到），所以别拿通知条数当「是否写对了」的判据，看动作和 history。
- **需求阶段只在 `type='normal'` 产品上推进**：本库 `zt_storystage` 一行都没有、产品全是 `normal`，所以只写 `zt_story.stage`；
  多分支产品（`hasBranch`）会把页面那条 warning 原样报出来，不推进 `zt_storystage`。
- **看板泳道**：只有该执行下真的存在对应类型的泳道时才会重排卡片；没有泳道会给警告（详情页数据不受影响）。
  BUG 尤其常见——本环境 300 多个执行里只有 47 个配了 BUG 泳道。
- **工时增量为 0 的动作**（如 `finish` 时本次工时分填 0）不会生成工时记录，此时会明确警告。
- **已知历史漂移，不是写错**：本库有 16 个父任务的 `left` 与子任务汇总对不上（如 `1601`~`1616`、`1666`，
  父任务已 `closed`、子任务各留 `left=2.00`，父任务仍留 `4.00/8.00`）。源码 `computeWorkingHours()` 对
  `status='closed'` 的子任务不加 `left`，这些是历史上批量关闭没触发汇总留下的旧值。

## 开新会话（zentao_session_start）

一句话：拿到 BUG/任务/需求后，不用人肉切工作区、建会话、粘贴编号——插件自己找到对的工作区，
把仓库更新到最新，在旁边开一个标题写好的新会话，把开场提示词备好（默认不替你发出去）。

### 工作区目标表（`targets`）

一个工作区可以有多个 git 仓库（园区 V2 那种：后端、前端、移动端各一个），所以目标表是数组：

```json
[
  {
    "id": "demo-v2",
    "name": "园区V2",
    "path": "D:\\workspace2\\demo-v2",
    "zentaoProjects": ["园区V2", "园区二期"],
    "repos": [
      { "role": "后端", "path": "server", "gitUrl": "git@git.example.com:demo/server.git", "branches": ["develop", "release", "master"] },
      { "role": "前端", "path": "web", "gitUrl": "git@git.example.com:demo/web.git", "branches": ["develop/v2.6.2"],
        "submodules": { "acme-web-admin": "develop/v2.6.2-demo" } },
      { "role": "移动端", "path": "app", "gitUrl": "git@git.example.com:demo/app.git", "branches": ["main"] }
    ]
  }
]
```

- `path`：工作区根目录，**绝对路径**，必须是个真实存在的目录（插件不会替你造空目录；`repos` 里给了 `gitUrl` 时会按需 `clone`）。
- `zentaoProjects`：这个工作区对应禅道里的哪些项目名，读到的任务/BUG 项目名命中就直接进它。
- `repos[].path`：绝对路径，或相对工作区根目录的目录名（`server`、`web`）。
- `repos[].branches`：这个仓库的**分支链**，有序，序号 1 是改动落点，见下节；`repos[].gitUrl`：仓库没有时可以自动拉下来。
- `repos[].submodules`：只给**和父仓库分支不一致**的子模块单独写一条，键值对形式（子模块名 → 分支链），键支持模糊匹配，见「子模块自己的分支」一节。
- 老写法 `"branch": "develop"` 仍然认，等价于 `"branches": ["develop"]`；两个都写时以 `branches` 为准。

在配置页里是可视化编辑器（增删工作区、增删仓库行），不用手写 JSON。

### 匹配顺序

显式 `targetId` → `zentaoProjects` 精确命中 → 工作区名/目录末段的模糊包含 → **都不中就列候选让人选，绝不猜**。
猜错的代价是把别人的项目改坏，所以到这一步一律停下。

### 分支链（`branches`）：一号分支改，往上 cherry-pick

一个仓库常常要同时维护好几条分支（开发线 → 发布线 → 主干）。所以分支配成**有序链**：

```json
{ "role": "后端", "path": "server", "gitUrl": "…", "branches": ["develop", "release", "master"] }
```

序号就是数组下标 + 1：

| 序号 | 分支 | 用途 |
|---|---|---|
| 1 | `develop` | **改动只落在这条**——开工时插件把仓库切到它、快进到最新 |
| 2 | `release` | 由序号 1 cherry-pick 上来 |
| 3 | `master` | 由序号 2 再 cherry-pick 上来 |

插件自己**不做** cherry-pick（那属于改代码的活，得有人判断冲突），但它会把两张话说死写进开场提示词：

- 分支链清单：`- 后端：1. develop → 2. release → 3. master`；
- 规矩：代码只改在序号 1 上，改完按链一路 `git cherry-pick` 上去（1→2→3…），
  冲突在当步解决再继续，不要跳序号、不要在后面的分支上重复手改。

留空（`[]` 或不写）表示这个仓库不校验分支——插件不切分支、提示词里也不出现分支链那段。

### 开工前先同步代码

每次开工（`dryRun` 也一样只探测不改）都会按顺序处理每个仓库：

| 情况 | 动作 |
|---|---|
| 目录没有、配了 `gitUrl` | `git clone --branch <序号1分支>`（只拉这一条，`cloneMissing: false` 可关） |
| 有仓库但没在序号 1 分支 | 本地有就 `checkout`，只在远端就 `checkout -b <序号1> origin/<序号1>` |
| 已经在该分支 | `fetch --prune origin` + `merge --ff-only origin/<序号1>` 快进 |
| **工作区是脏的** | 什么都不动，标 `untouched` 并在结果里提醒你；分叉快进不了也如实报错，不强推 |

`update: false` 可以跳过 fetch/merge（只想看看现状时用）。

### 父子模块仓库（自动识别，不用配）

仓库可能是**父子模块**（根目录有 `.gitmodules`、下面挂一堆子模块），也可能是**单仓库**。
同一个工作区里两种都可能出现（比如后端是父子模块、移动端是单仓库），所以判断是**逐个仓库看现场**，
不需要在配置里写任何东西。

| 情况 | 行为 |
|---|---|
| 子模块落后 | 每个「干净」的子模块各自 `fetch` + `merge --ff-only` 跟到远端最新 |
| 子模块在别的分支（或游离头） | 按「子模块自己的分支」规则算出目标分支，`checkout` 过去再快进，结果标 `switched` |
| 子模块有未提交改动 | 原样不动，结果里标 `skipped` 并在提示词/警告里点名（先提交再开工） |
| 父仓库刚 clone 下来 | 顺带 `git submodule update --init --recursive` 把子模块拉下来（按父仓库记录的提交，不切分支） |

两个容易踩的点，插件已经绕开了：

- **子模块指针漂移不算父仓库脏**。父子模块仓库里，子模块的 HEAD 和父仓库记录的提交对不上时，
  `git status --porcelain` 会输出 ` M acme-autonomy`，看着像人改的代码。用这个判脏的话，
  父子模块仓库会永远被判脏、永远不更新（0.4.0 之前就是这样，「开工前先更新代码」在园区物管v2 上从来没生效）。
  现在判父仓库干净度一律带 `--ignore-submodules=all`（注意 `--ignore-submodules=dirty` 不够，它仍会报指针漂移）。
- **不跑 `git submodule update`**（除了刚 clone 那一次）。那会把人工切在 `develop/xxx` 上的子模块打成 detached HEAD，
  下次谁都不知道该回到哪条分支。

提示词里也会交代：子模块跟父仓库同一条链——每次 cp 完父仓库，子模块里对应的那条提交也要按同一顺序 cp 上去
（先 commit 子模块，再 commit 父仓库的指针，两个提交一起往上走）；子模块有未提交改动的先别动它。

### 子模块自己的分支（`submodules`）：按名字模糊匹配，没配就跟父仓库

子模块的分支**不写死**，也不必逐个配。规则两条：**配了就用配的，没配就跟随父仓库**。

```json
{
  "role": "前端",
  "path": "web",
  "branches": ["develop/v2.6.2"],
  "submodules": {
    "acme-web-admin": "develop/v2.6.2-demo",
    "common-": ["develop/v2.6.2", "release/v2.6.2"]
  }
}
```

- 键是子模块名，**模糊匹配**：全路径、路径末尾、任意一段、子串都算命中，多条命中取键最长的那条。写 `common-` 就能一把罩住 `common-flowable`、`common-core` 之类。
- 值是它的**分支链**（和仓库的 `branches` 同一套语义，序号 1 是改动落点）：可以写一条字符串、逗号分隔，也可以写数组。
- 数组形式也认：`"submodules": [{ "match": "acme-web-admin", "branches": ["develop/v2.6.2-demo"] }]`。
- **没配的子模块跟随父仓库的分支链**（目标分支 = 父仓库的序号 1 分支）；父仓库也没配分支时不猜，在哪个分支就快进哪个。
- 配了但那条分支在子模块的本地和 `origin` 上都不存在时，原样不动并提示你回去改配置——不会乱切。

典型场景就是园区物管v2 的前端：父仓库在 `develop/v2.6.2`，子模块 `acme-web-admin` 却在 `develop/v2.6.2-demo`，
写一行 `"acme-web-admin": "develop/v2.6.2-demo"` 就对齐了。

提示词里也会把「子模块分支（和父仓库不一致的那些）」单列一段，并说明子模块按自己的链走。
占位符：`{{submodules}}`（子模块数量与更新情况）、`{{submodulebranches}}`（子模块的分支链）。

### 建会话

1. `workspaceRegistry.list()` 里按路径找已登记的工作区（大小写、斜杠方向都归一化过），有就复用，没有才 `create(path, name)`；
2. 同一编号在这个工作区里已有会话时**直接回到它**（`sessionController.list()` 只读扫标题，见下一节），不建新的；
3. 否则 `sessionController.create({ workspaceId })` 建会话——注意宿主规定 `workspaceId` 和 `cwd` **只能给一个**；
4. 需要时才发开场提示词；
5. **首条提示词真的发出去了**才 `sessionTitle.rename` 把标题写成 `BUG #5967 登录页点不动`（≤80 字，失败只警告不影响开工；复用旧会话时不改名）。
   没发提示词就**不写标题**：宿主点「新建会话」会复用本工作区里最新的 blank 会话（blank 只看有没有 `turn/start`），
   一个「改过名但从没说过话」的空壳会被反复复用，把旧标题一路带到后面的新会话上（宿主又没有清空标题的接口，空串判非法）。
   11-01 那次攒出来的 7 个「BUG #5967」空壳就是这么来的。

默认提示词会告诉新会话：先用 `zentao_read` 把编号内容读全、动手前确认自己在对的分支、**不要 `git push`**，
并把每个仓库的角色/路径/分支链/子模块数/当前状态列一遍。要改就在配置里写 `session.promptTemplate`（占位符多了 `{{branches}}`、`{{submodules}}`、`{{submodulebranches}}`）。

还会交代**会话产物目录**：**按需创建**——只有真要落文件（脚本、日志、导出数据、截图、临时笔记）时才在工作区根目录建一个和会话名同名的文件夹
（`BUG #5967 登录页点不动`，`\ / : * ? " < > |` 换成 `-`、去掉末尾的点和空格，因为 Windows 不认）；
一个文件都不用落就别建，免得工作区里堆一堆空文件夹。真落了文件就都放进去，不要塞进仓库、也不要散落在工作区根目录；
代码本身的修改照旧落在对应仓库里。自定义模板用 `{{dir}}` 取这个目录的绝对路径。

### 同一编号：回到旧会话

同一条单子第二次开工（比如 BUG 提了复测、任务追加了需求），**不新建会话，而是回到之前的那个**，
把这次的提示词发进去，上下文连着。规则由 `session.reuseExisting` 控制（默认开）。

识别只认**编号**，不看标题：会话标题里的 `#5967` 就是它的身份。所以禅道那边把标题改了也不影响，
人手动改过会话标题也不影响。判定细节：

| 情况 | 行为 |
|---|---|
| 同一工作区里有 `BUG #5967 …` 这类以规范前缀开头的会话 | 直接回到它（多条时取最近活跃的一条） |
| 只有标题里带了 `#5967`、但不是规范前缀 | 也认，但排在规范前缀之后 |
| 编号只是前缀相同（`#5967` vs `#59670`） | 不算同一条，正则带边界 |
| 同编号会话在**别的目录**里 | 不接管，照常新建；结果里会把这些「别处的会话」列给你看 |
| 没有（或 `reuseExisting` 关掉，或本次传 `reuse: false`） | 照常新建 |
| 发起调用的就是那个会话自己 | 排除掉，不会让自己「继续」自己 |

复用时不改名、不动工作区——对话记录还挂在原来那个标题下，改了对不上。`dryRun` 会明确告诉你
「真开工时会回到哪条旧会话」，可以先看一眼再决定。

注意副作用：复用是往旧会话里再发一条消息，如果那条旧会话**正在跑**，这条消息会排进它的队列。

### 三个刹车

| 开关 | 默认 | 作用 |
|---|---|---|
| `session.enabled` | 开 | 关掉就彻底禁用 |
| `session.agentAutoStart` | **关** | 关着时模型自己调 `zentao_session_start` 会被拒（`auto-start-disabled`），只能由人在页面上点按钮触发 |
| `session.autoPrompt` | **关** | 关着时只建会话、不自动发提示词——发一条就是一轮真 LLM 调用，钱得人点头 |

页面上有「试运行」按钮（等价 `dryRun: true`）：只做匹配和仓库探测、把开场提示词打印出来、并告诉你
「真开工时会回到哪条旧会话」，但不建会话、不发消息。

### 两个已知限制

- **GUI 不会自动跳到新会话**。会话建好后会出现在左侧会话列表里（宿主会广播 `api-session/added`），点开即可。
- 新会话不继承当前会话的文件策略/审批设置，用的是它自己工作区的那套。


## 提交代码（zentao_commit）

一句话：把**本次对话改的文件**提交成一条带禅道单子信息的提交，备注不用手写，
也不会顺手把同一个工作区里别的会话、或者你自己开工前就改了一半的文件卷进来。

```
zentao_commit ({ kind?, id?, repo?, files?, message?, dryRun?, push? })
```

### 提交信息固定两行

```text
BUG #5967 附件上传失败
http://192.0.2.10/index.php?m=bug&f=view&bugID=5967
```

第一行「类型 #编号 标题」、第二行禅道链接，都由工具从单子里取，不用手打（`message` 可以整段覆盖）。
没显式给 `kind` + `id` 时，用这个会话开工时绑定的那张单子——也就是 `zentao_session_start` 记下的。

### 只提交本次对话的改动

三层保护，按可靠性从高到低：

| 层 | 做法 | 挡什么 |
|---|---|---|
| 私有索引 | 每个会话一个 `GIT_INDEX_FILE`（`.git/life-saver/index-<会话>`），从 HEAD 起步、只 `git add` 自己的文件 | 别人 `git add` 进默认索引的东西不会进我的提交；也不会撞 `.git/index.lock` |
| 开工基线 | 开工时记下 HEAD + 当时已脏的文件（`.git/life-saver/<会话>.json`），提交时只取**新出现**的改动 | 你开工前就改了一半的文件（列在 `heldBack` 里，单独显示，不提交） |
| 事后对齐 | 提交后 `git reset -q HEAD -- <这些文件>` | 不给别人留「已暂存但内容过时」的条目 |

**并行会话的诚实说明**：git 本身记不住「这个文件是谁改的」。所以在**同一个仓库里有另一个会话也开工过**时，
默认的「开工后新出现的改动」可能把对方正在改的文件也算进来——工具会在 `warnings` 里明确提示，
并且推荐用 `files` 精确指定。给了 `files` 就是精确的：只提交点名的文件。

```text
zentao_commit ({ dryRun: true })                    # 先看：会提交哪些、挡下了哪些
zentao_commit ({ files: ["src/a.ts", "src/b.ts"] })  # 精确：只提交这两个
```

### 不做的事

- **不 push**（除非 `push: true`）；不去 `fetch`、不切分支、不 stash，工作区里别人的改动一律不动。
- 不做 cherry-pick、不碰子模块——那是改代码的活，得有人判断冲突。
- 没有改动时直接报 `nothing-to-commit`，不会造空提交。

## 排障

| 现象 | 原因 |
|---|---|
| `zentao_status` 说 `db.ready=false` | 缺 `db.host`/`db.user` 或凭据 `ZENTAO_DB_PASSWORD` |
| 写操作报 `write-disabled` | `write.enabled` 被关掉了；去插件页「写入禅道」打开 |
| 写操作报 `not-owner` | 这条记录既不是你指派的也不是你创建的。确需代别人操作时打开 `write.allowOthers` |
| 写操作报 `status-mismatch` | 当前状态不允许这个动作（如对 `doing` 的任务再 `start`）。提示里会列出允许的状态 |
| 写操作报 `write-rejected` | 禅道自己拒绝了（必填项缺失、`resolution` 没给、完成时间早于开始时间…）。**这条不会降级换通道**，因为换条线照样被拒；按消息里的字段名改 |
| `finish` 之后工时没增加 | 本次工时分填了 0，禅道不会为这次完成生成工时记录（工具会明确警告）。要先记工时用 `recordworkhour` |
| DB 线写完，父任务/需求阶段没跟着变 | DB 线刻意没复刻 `updateParentStatus` 与 `setStage`（算错会污染别的对象），请到页面上复核 |
| DB 线写完，看板卡片没动 | 该执行下没有对应类型的泳道；BUG 尤其常见（本环境 300 多个执行只有 47 个配了 BUG 泳道）。详情页数据照常正确 |
| 工时统计比预期少 | `zentao_workhours` 只算 `zt_effort`（唯一按人记工时的表）。老任务的 `zt_task.consumed` 有值但没有工时明细，统计会把它列进「有动作但没记工时」 |
| 能读文字、附件永远 `(no path)` | `sftp.uploadBase` 没配或路径不对；probe 的 detail 会直接写出来 |
| `Unknown column 'project'` / `'keywords'` | 老库和新库的 `zt_story` 列不一样（所属项目在 `zt_story.project` 列还是 `zt_projectstory` 关联表、有没有 `keywords` 列）。体检（`zentao_status`）时会自己认出来并换写法；还没体检就撞上，搜索会自动退成只匹配标题重来一次。仍报错说明连到了别的前缀库，检查 `db.prefix` |
| 读取实体报 `skin-unknown` | 页面上什么都没解析出来：登录失效、禅道换了一套皮肤，或 `http.skin` 钉错了。报错里带 HTML 长度和试过的三套选择器；先看 `zentao_status` 的「页面皮肤」，把 `http.skin` 设回 `auto` 或手工指定一档 |
| HTTP 通道 401 / 登录失败 | 账号密码错，或该账号没有对应产品/项目的页面权限 |
| HTTP 说「登录失败，请检查您的用户名或密码是否填写正确」，但密码确认没错 | 0.1.3 修的坑：登录必须**两步带同一个会话**——第一步 `m=user&f=refreshRandom` 返回的 `zentaosid` 要带进第二步 `m=user&f=login`，否则禅道找不到那段随机数，一律回这句「用户名或密码不正确」。另外注意账号是 `admin`（两个 h），少打一个也会是这个提示 |
| 页面不显示 | 插件行没插进 `cordis.patch.yml`，或浏览器没刷新 |
| `config-set` 报 `Config field "session.xxx" is not volatile` | 新加的配置项没标 `.volatile()`。宿主规定：不标就不能写，配置页保存也会 500 |
| 配置页填了、点了保存，`测试连接` 仍说「缺 http.account」 | 0.1.1 修的两个坑：① 草稿是摊平的键，比对时误用了嵌套取值 → 只有 `mode` 被当成改动，其余字段根本没提交；② `测试连接` 读的是已保存的配置，页面里的草稿不算数。现在保存直接走宿主 `settings.mutate`（失败会显示原始错误），测试连接会把草稿一起送过去 |

报错文案是刻意写的：缺配置就说缺哪个键、连不上就带 `ECONNREFUSED/ETIMEDOUT` 并给一句怎么办、`auto` 降级失败会把前一条通道的真实原因一起带出来（`已尝试：db → http；db 的原因：…`）。所以多数排障看错误消息本身就够，不用翻日志。

另一个容易踩的点：**改了插件源码要重启 DSH**（宿主侧模块已加载），只有 `cordis.patch.yml` 的配置是热的、客户端页面刷新浏览器即可。

0.2.0 实测补充：桌面端 profile 的 HMR 行 `root: []` 不监听源码目录，所以 `pnpm build`
之后进程里跑的可能还是旧代码。经验做法是构建完**顺手存一次配置**（页面上点保存，或
`POST /api/dsh-life-saver/config-set` 写个同值），让 plugin-manager 重新组合插件；改不动就重启 DSH。
判定依据：改完之后新字段出现在 `POST /api/dsh-life-saver/session-targets` 返回的 `session` 对象里，
就说明进程换上了新代码（旧代码里没有这个字段）。
判断线上是哪一版：改一句日志/报错文案，重跑一次看是不是新文案。

0.2.1：请求体解码不再「静默变乱码」。以前 `readJsonBody` 直接 `Buffer.toString("utf8")`，
Node 遇到非法字节会替换成 U+FFFD 而不报错，而 JSON 结构是纯 ASCII、`JSON.parse` 照样成功 ——
于是 Windows 控制台里 `curl -d '{"prompt":"…中文…"}'`（发的是 GBK 字节）会让中文悄悄变成 `����`，
一路传进新会话的提示词。现在先按 UTF-8 **严格**解，解不动再按 GB18030（兼容 GBK/GB2312）解，
都解不动才让 `JSON.parse` 报 `malformed-body`。浏览器页面走 `fetch`，本来就是 UTF-8，不受影响。

0.3.0：同一条单子第二次开工不再另起会话，而是回到之前那个（`session.reuseExisting`，默认开）。
识别只认编号：扫 `sessionController.list()` 的标题投影，`BUG #5967` 这种规范前缀优先，
其它含 `#5967` 的次之，都不跨工作区（cwd 必须和目标工作区一致，别处的同编号会话只列出来提示）。

0.4.0：仓库分支从「一个分支」改成「一条有序的分支链」（`branches`），序号 1 是改动落点——
开工时只切到它、只快进它，其余分支由模型按提示词里的链条一路 `git cherry-pick` 上去。
插件不替人做 cherry-pick（冲突要人判断），但会把「只改序号 1、按链往上 cp、不要跳序号」写死在开场提示词里。
老配置的 `"branch": "develop"` 仍然能用，等价于单元素链。

0.5.0：认父子模块仓库。以前判「工作区脏不脏」用的是 `git status --porcelain`，而父子模块仓库里
子模块指针漂移也会输出 ` M acme-autonomy`，于是园区物管v2 这类项目**永远被判脏、永远不更新**
——「开工前先把代码更到最新」这条规矩在父子模块项目上其实一直没生效。现在判父仓库干净度一律带
`--ignore-submodules=all`，子模块单独读分支和脏状态：干净的跟父仓库各自 `merge --ff-only` 快进，
脏的和游离头原样不动只报告。父子模块/单仓库逐仓库自动识别，不用配。详见「父子模块仓库」一节。

0.6.0：子模块的分支不再只能「跟父仓库」。0.5.0 里游离头子模块一律不动，可现实中子模块常常和父仓库
不在同一条分支上（园区物管v2 前端：父仓库 `develop/v2.6.2`，子模块 `acme-web-admin` 在 `develop/v2.6.2-demo`）。
现在仓库多一个 `submodules` 键值对，键是子模块名（**模糊匹配**：全路径/末尾/任意一段/子串，多条命中取键最长），
值是它的分支链；**没配的子模块照旧跟随父仓库**，父仓库也没配就不猜。命中就 `checkout` 过去再 `merge --ff-only`，
结果标 `switched`；配的分支在本地和 `origin` 都不存在时原样不动并提示回去改配置。提示词里单列
「子模块分支（和父仓库不一致的那些）」一段，占位符新增 `{{submodulebranches}}`。

0.7.0：能写了。新增 `zentao_task_op`（八个动作）、`zentao_bug_op`（五个动作）、`zentao_workhours`（任意区间工时统计）
三个工具，以及 `write.enabled`/`write.mode`/`write.allowOthers` 三项配置。写操作有两条线：默认走禅道页面
（副作用由禅道自己写全），`write.mode=db` 则单事务直写七张表。护栏八道：总开关、先读后写、状态白名单、归属校验、
`expectStatus`、写后自校验、一次一条、DB 线字段白名单。**刻意没有 dry-run**——多一步「先给我看看」在真实工作中只会被跳过。

这一版踩掉的真坑，都写进测试了：`{"result":"fail","message":{…}}` 曾被判成成功；`<html>…<script>location.reload()</script>`
这种老入口回包曾被判成失败；HTTP 通道给中文、护栏比机器码，导致默认 `write.mode=http` 下所有写操作被自家护栏全盘误杀
（现在通道额外产出 `codes`）；`bug confirm` 只发 comment 会把 `pri`/`type`/`deadline`/`assignedTo` 写成默认值
（现在先 GET 表单取每个控件当前值再覆盖）；`activate` 不回填 `assignedTo` 会把它清空；BUG 的「日志」是 biz 版独立
`effort` 模块、必须用数组下标字段提交，平铺式会「回包成功但什么也没写」（现在写后断言日志条数真的涨了）。

0.8.0：换一台机器不再「照抄配置就以为好了」。这一版加了结构自探索（`discovery.*`）：体检时在**已经连通的**库和
站点上探一次结构——详情页是哪套皮肤（`.detail-section` / `.detail` / `.article`）、登录密码是二次 md5 还是直接
md5、`zt_story` 有没有 `keywords` 列、所属项目落在 `zt_story.project` 列还是 `zt_projectstory` 关联表——结果按
「部署指纹」（库+前缀+站点+附件根）缓存 10 分钟，指纹一变立刻重探。三条底线：只在已连通的通道上探，绝不猜
host/库名/账号（猜错库＝读到别人单子）；探测失败不影响读取，退回代码默认并在 `zentao_status` 里显式标「未确认」；
认错了可以钉死（`http.skin` / `db.keywords`）。

同时把几处「静默出错」改成明说：三套皮肤都不命中时抛 `skin-unknown` 并带上 HTML 长度和试过的选择器（以前是
安静返回空正文）；登录协议从「只认二次 md5」变成两档回退，全失败时把两条路各自的原因一起报出来；SFTP 找不到
附件时列出试过的候选路径。搜索还加了一层兜底：结构没探过就撞上 `Unknown column 'keywords'`，自动退成只按标题
重搜一次（换禅道往往是先搜索、后体检）。

0.8.1（未发布）：补闸门，不重构。功能跑得快，闸门跟不上——客户端 1577 行 JSX 一直不在类型检查里（构建只转译），
于是 0.8.0 的 `TargetCard` 引用作用域外变量这种事能一路进到运行时，表现成「配置页整页空白」。这一版补三道：
客户端进 `tsc`（`tsconfig.client.json`，`allowJs + checkJs`）、加最小 eslint、补两类契约测试（桥接路由往返 +
写工具动作白名单、客户端字段表与配置 schema 对齐）。顺手修掉两个真问题：配置只读时「开新会话/试运行」按钮
照样可点（`SessionPanel` 解构了 `disabled` 却没用）；`json` 类字段（工作区目标表）存进去是数组、草稿里是字符串，
不做归一化会「什么都没改也提交一次回写」。
同一版还改了开场提示词：要求新会话先在工作区根目录建一个和会话名同名的文件夹，这次产生的文件都放进去
（会话名里的非法字符换 `-`，目录绝对路径既写进默认模板、也作为 `{{dir}}` 给自定义模板用）。

下一版（未发布）：三个禅道 skill 随包发布（`zentao-extract` / `zentao-change-assignee-scrub-trace` /
`zentao-weekly-report`）。以前它们只存在于作者本机的 `~/.dsh/skills/`，换台机器就得手工搬 7 个文件，而这些 skill
依赖的正是本插件的 `zentao_*` 工具——打进包里之后 `npm i dsh-life-saver` 就有全套。实现走 bundled provider
（`packages/plugin/src/skills/index.ts`，`assets/skills/<name>/SKILL.md` 进 `files`），rank 用 600，比用户级 400 低，
所以本机存过同名 skill 的人照旧用自己那份。
同一版还做了一次凭据清理：三个 skill 里写死的库地址/账号/口令全部改成环境变量（四个必填、无默认值，
缺一个退出码 2），`zentao-extract` 里过期的源码路径也改到当前仓库位置。仓库是 public，这些值本来就不该出现。


## 开发

```bash
pnpm build      # 按依赖序：core 出 tsc + d.ts，插件出宿主 ESM + esbuild 客户端 bundle
pnpm typecheck  # pnpm -r：core 一份、插件宿主 + 客户端各一份
pnpm lint       # eslint：客户端 JSX 与各包的 scripts/test（.ts 交给 tsc，不重复上一道闸）
pnpm test       # pnpm -r：core 114 条 + 插件 106 条
```

单包操作加 `--filter`：`pnpm --filter life-saver-core test`、`pnpm --filter dsh-life-saver build`。
测试是**跑构建产物**的（`import ../lib/x.js`），所以两个包的 `test` 都挂了 `pretest: pnpm build`，
改源码后直接 `pnpm test` 即可，不会测到旧产物。插件侧的测试通过包名 `life-saver-core/*` 取 core，
不写跨包相对路径。

三道闸各管一段，谁都别撤（都踩过坑）：

- **客户端类型检查**：`packages/plugin/src/client/index.jsx` 不进 `tsconfig.json`（那是给 Node 侧的），由 `tsconfig.client.json` 单独 `allowJs + checkJs`，`noImplicitAny: false`（JSX 里到处是隐式 any，开起来噪声太大）。设这道闸的直接原因：0.8.0 里 `TargetCard` 引用了 `repos.map` 作用域外的 `repo` / `repoIndex`，构建和既有测试都发现不了，运行时抛 `ReferenceError` 被插槽边界吞掉，表现成「配置页整页空白」；`tsc` 30 秒就能报出来。
- **eslint**：只覆盖「没别的闸门」的文件（客户端 JSX、脚本、测试），规则刻意窄（`no-undef`、`no-unused-vars`、`no-empty`、`react-hooks`），不追求风格统一。
- **配置键对齐**（`test/config-keys.test.mjs`）：客户端 `FIELDS` 是硬编码数组，配置 schema 在 `packages/core/src/config.ts`，两边靠人肉同步；一边加了键另一边没跟上，症状是「页面上没入口」或「填了不保存」，两边都不报错。这条测试读源码文本把两边对齐。

测试覆盖的边界（改这些地方前先看测试）：

- `test/discovery.test.mjs`：结构自探索——探测结果按部署指纹缓存、换指纹即丢弃、失败不续期、TTL 边界、覆盖层（`db.keywords` / `http.skin`）优先于探测、库结构四例（有/无 `keywords`、有/无 `projectstory`、表都找不到）、三套皮肤命中与全空页、feature-aware SQL 文本与参数个数、`zentao_status` 的「未确认」文案
- `test/config-keys.test.mjs`：配置键对齐——`FIELDS` 里的路径都得在 schema 里存在、schema 里每个键都得有入口、`kind`/`section` 只用品类里已有的值、路径不重复
- `test/bridge-contract.test.mjs`：桥接路由与写工具的对外承诺——`config-describe` 原样摊开宿主那一行（含 `found:false`）、`config-set` 的往返与 `revision` 前进、六种非法提交在碰到宿主前就被拒、版本冲突翻成 `config-conflict`、设置服务没就绪说人话、只认本机/同源 POST、`zentao_bug_op` 不认任务动作且把合法动作写进报错

- `test/smoke.test.mjs`：宿主注册了哪八个工具、哪个技能 provider（三个禅道 skill 的 name/rank/资源目录/正文，以及资产缺失时只跳过自己）、九条路由（含 `config-set` 的 ops 校验与错误透传、`test` 的草稿覆盖）、请求体解码（GBK 字节不静默变乱码）、配置页产物形状
- `test/client-render.test.mjs`：配置页在加载/不可用/就绪/只读四种状态下都能渲染；保存走 `/config-set` 且把宿主原话显示出来；测试连接把未保存的草稿一起送出
- `test/render.test.mjs`：模型读到的 markdown 长什么样（图片不重复、未下载附件留锚点、brief 折叠、HTTP 正文的「## 重现步骤」不重复套标题）
- `test/db-abort.test.mjs`：连不上库时「停止」能在亚秒级生效，且后台连接失败不会崩宿主
- `test/http-e2e.test.mjs`：起一个假禅道（`refreshRandom` → 二次 md5 登录 → `zin=1` 页面 → 附件下载），把「登录换 cookie → 解析字段/正文/备注 → 附件落盘」整条链真跑一遍；同时锁住「cookie 复用」「会话被踢后重登一次」「预算为 0 只给清单不下载」「密码错报禅道原话」「登录必须带 refreshRandom 的会话 cookie」「正文内嵌图按字节头补扩展名落盘」六个行为
- `test/write-reply.test.mjs`：写操作回包判定——只认 `result === "success"`/`true`，`{"result":"fail","message":{…}}` 必须算失败（曾经把失败当成功）、`message` 是对象/数组要摊平、会话过期要抛出而非当业务失败、`<html>…<script>location.reload()</script>` 这种老入口回包要认成成功（曾经把成功报成失败）、同形态里的 `alert('…')` 要算业务失败
- `test/worklog.test.mjs`：工时统计口径——合计/按对象/按天三者自洽、`kind` 过滤、0 工时行保留、漏项单列不混进合计、空区间不报错、日期校验挡掉 `2026-13-01` 这种「形状对但日子不存在」的输入（`BETWEEN` 不会报错，只会静默查出空结果）
- `test/write-guards.test.mjs`：写操作前置护栏——`write.enabled=false` 直接拒绝、kind 与动作不能串味（`task` 不给 `resolve`）、动作枚举与 `zt_bug.resolution` 真实值对齐、非法 id 在连库前就报错
- `test/http-write-e2e.test.mjs`：HTTP 写线端到端（假禅道）——读快照 → 取 uid → 提交 → 回读快照，`consumed` 是「旧+本次」、完成后指派回创建人、校验失败变 `write-rejected`、工时为 0 要警告
- `test/db-write.test.mjs`：DB 写线七张表——`finish` 逐表断言（task 状态/指派回创建人、effort 用本次增量、action 名、actionrecent 同 id、history 每字段一行且带中文显示名、notify 收件人、kanban 卡片挪列），`recordworkhour` 只加不覆盖且不发通知、`comment` 不碰业务字段、DB 层自己也校验状态、不存在报 `not-found`
- `test/parse-new-skin.test.mjs`：biz 版新皮肤的详情页（无 `<title>`、`.detail-section` 正文、历史面板是 JS 对象字面量、`指派给` 里人和时间挤一格）解析回归
- `test/normalize.test.mjs`：两条通道的口径归一——页面 `status-xxx` class 变机器码、人员中文名反查回账号、反查不到就不伪造、中文/机器码互转字典（含旧文案「结束」）、`userPairs` 两层 JSON 解析与坏回包、页面内联样式表不能被当成状态数据
- `test/http-payload.test.mjs`：HTTP 写的表单载荷与表单默认值回填（离线断言，因为这条线没有沙箱）——`readFormDefaults` 要从页面里读出 `status/assignedTo/type/pri/deadline` 这类控件当前值（正是 `bug confirm` 被打坏的那几列），`uid` 与 JS 拼串占位值、附件控件不回填；`recordworkhour` 必须带数组下标、`finish` 的 `currentConsumed` 与 `consumed` 两个都给、`close` 不带 status、`activate` 必须给 left、BUG 日志四个数组字段齐全、`resolve` 的 fixed/duplicate 必填项
- `test/git-submodule.test.mjs`：父子模块仓库真建临时 git 仓库来跑——子模块指针漂移不算父仓库脏、脏的子模块原样不动只报告、干净的子模块跟着父仓库快进、游离头没单独配分支时跟随父仓库分支、配了分支就切过去、配的分支不存在则原样不动并提示改配置、单仓库不多出子模块字段
- `test/session-launcher.test.mjs`：开新会话的调用契约——dryRun 不建会话、没发提示词就不改名（`create → session.create`）、发了提示词则 `create → session.create → session.prompt → session.rename` 顺序固定、`session.create` 只给 `workspaceId`、`session.prompt` 的第二个参数（signal）不能是 undefined、agent 自主调用受 `agentAutoStart` 约束、匹配不上只列候选、同路径工作区复用不重建；以及「同编号回旧会话」的六种判定（回到旧会话且不建不改名、别的目录不接管、标题改过仍认而 `#59670` 不认、规范前缀优先且取最新、开关关掉就新建、排除自己）；还有分支链进提示词的两条（序号清单只列配了分支的仓库、没配就整段不出现）；以及父子模块进提示词（有父子模块说明、子模块数量、同一条链的 cherry-pick 交代）
- `test/targets.test.mjs`：目标表解析——`branches` 有序且 `[0]` 就是改动落点、老写法 `branch` 折成单元素链、两者同时出现以 `branches` 为准、重复分支去重保序、没配分支不瞎猜、链里混了非字符串丢坏值保好值；子模块分支的键值对/数组两种写法、值的三种形态（单分支/逗号链/数组）、模糊匹配（全路径/末尾/任意一段/子串，多命中取键最长）、没配时不报错

产物形状由 DSH 决定，别自己发明：

- `lib/index.js`：ESM，`export const name` + `export function apply(ctx)`
- `lib/client.js`：`window.__ModuleLoader__.load({ id, factory: (require) => … })`，只 `require` react 系列，其余全部打进来
- `cordis.patch.yml`：`- insert:` 列表，行 id 决定配置页 key（`<包名>#<行 id>`）

## 发布（GitHub Actions）

两个 workflow 各管一段：

| 文件 | 什么时候跑 | 干什么 |
|---|---|---|
| `.github/workflows/ci.yml` | 推到 `main`、每个 PR、手动 | `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm -r typecheck` → `pnpm lint` → `pnpm test`（220 条） |
| `.github/workflows/release.yml` | 推 `v*` tag，或手动填版本号 | 改 manifest 版本 → 断言三个 manifest 一致 → 同一套构建与测试 → 先发 `life-saver-core`，确认能从 npm 查到之后再发 `dsh-life-saver` |

几条硬约定：

1. **版本号只有一个来源**：tag（或手动输入的 version）。manifest 由 `scripts/apply-version.mjs` 现场改，**不提交回仓**——所以 git 里的 `0.8.1` 与 npm 上的 `0.9.0` 允许差一行。
2. **依赖靠 `workspace:*` 自动钉住**：`pnpm publish` 会把它改写成精确版本。已实测：打出来的 `dsh-life-saver-0.8.1.tgz` 里 `dependencies` 就是 `{"life-saver-core":"0.8.1"}`，不需要额外脚本。
3. **先 core 后壳**：壳钉的是同版本 core，core 没上就是 `ETARGET`。所以发布步骤是「发 core → 轮询 `npm view` 直到查得到（最多 2 分钟）→ 发壳」。
4. **幂等**：`npm view <name>@<ver>` 已经有值就跳过，失败路径绝不 `npm unpublish`。重跑同一个 tag 是安全的。
5. **provenance**：`--provenance` 要 `id-token: write` 与 public 仓，npm 页上会显示「由这个 commit 构建」。
6. **不需要跨仓凭证**：每个仓只用自己那一个 `NPM_TOKEN` secret。MCP 那个仓（`life-saver-mcp`）用「拉」的方式——它的 release 先断言 `npm view life-saver-core@<ver>` 有值，再发自己。

本地干跑（不推 tag、不碰 npm）：

```bash
node scripts/apply-version.mjs 0.9.0     # 只改三个 manifest
pnpm --filter life-saver-core pack       # 看 tarball 里到底有什么
pnpm --filter dsh-life-saver pack        # 依赖是否已从 workspace:* 变成 0.9.0
git checkout -- package.json packages/*/package.json   # 干跑完记得还原
```

## 验证状态

| 环节 | 怎么验的 | 结果 |
|---|---|---|
| 构建 / 类型 / 风格 | `pnpm build`、`pnpm -r typecheck`、`pnpm lint` | 全部通过：core 出 `lib/*.js` + `*.d.ts`，插件出宿主 ESM 与客户端 bundle |
| 测试 | `pnpm test` | 220 条全绿（core 114 / 插件 106） |
| 打包 | `pnpm --filter life-saver-core pack` 后在空目录 `npm i <tgz>` | 通过：包名导入、深层导入（`life-saver-core/channels/write.js`）、`.d.ts` 类型解析、配置 schema 都能用 |
| 装进宿主 | junction 到 `~/.dsh/profiles/desktop/node_modules/dsh-life-saver`（→ `packages/plugin`）+ `cordis.patch.yml` 的 `- insert:` 行 | 重启后 `zentao_status`/`zentao_read`/`zentao_search` 出现在工具清单 |
| 桥接协议 | 对 `http://127.0.0.1:<port>/api/dsh-life-saver/{test,credentials-status}` 发 POST | 200，返回真实 `mode`/`missing`/`probe` 与三把凭据状态 |
| 只读库 + SFTP | 连内网真库（`zentao.example.com:3306`，库名 `zentao`）读实体并落盘附件 | 通过；期间修掉 `zt_story.project` 不存在与附件目录拼错两个真 bug |
| HTTP 页面 | 假禅道端到端（见 `test/http-e2e.test.mjs`） | 通过：登录换 cookie → `zin` 页面解析 → 附件落盘 → 会话失效重登 |
| HTTP 真机 | 用真实账号登录后读 bug 5968 / task 2042 / story 1383 | 通过：标题、正文、备注、内嵌截图（按字节头补 `.png`）全部落位；期间修掉「登录要带第一步的会话 cookie」这个真 bug |
| mode 切换 | 插件页切 `db`/`http`/`auto`，观察 `zentao_status` 的通道与 `数据源` 行 | 通过：切换后工具下一次调用即按新通道取数 |
| 分支链 | 真机 `POST /session-probe`（task 1875）看生成的提示词 | 通过：三个仓库按 `1. develop/v2.6.2-demo-wg` 形式列清单，并写死「只改序号 1、按链 cherry-pick、不要跳序号」；开工时仓库被切到序号 1 分支再快进，其余分支不碰 |
| 父子模块 | 真机 `POST /session-probe`（task 1875，园区物管v2） | 通过：`server`（14 子模块）/`web`（1 子模块）被测成「父仓库自身干净」（旧版本会因 ` M acme-autonomy` 指针漂移永远判脏）；脏的 4 个子模块标 `skipped` 原样不动，干净的子模块各自快进；提示词里带子模块摘要与 cherry-pick 交代 |
| 子模块分支 | `test/git-submodule.test.mjs` 三条 + 真机 `POST /session-probe`（task 1875） | 通过：没配 `submodules` 时游离头子模块被判定「跟随父仓库分支」（`targetFrom: parent`）；配了 `{match, branches}` 就切到配置的分支（`switched`）并进提示词的「子模块分支」段；配的分支不存在时原样不动、只提示改配置 |
| 同编号复用 | 假宿主跑 `test/session-launcher.test.mjs` 的六种判定 | 通过：同工作区按编号命中并只发提示词、别处同编号只提示不接管、`#59670` 不误认、规范前缀优先、开关关掉照常新建、排除自身 |
| 开新会话 | 真机 `POST /session-probe`、`/session-start`（bug 5967 / task 1875） | 通过：命中「园区物管v2」、复用已登记工作区、标题写成 `BUG #5967 …`、会话落进该工作区的侧栏、首条提示词发出去并跑完一轮（会话日志里能看到 `turn/end: completed`）。期间修掉「宿主 `prompt(request, signal)` 的 signal 不可省」这个真 bug |
| 工时统计 | 真机连生产库查 zhangsan / 2026-10-26~11-01 | 通过：48.3 小时 / 34 条工时 / 32 个对象组 / 7 条漏项，按天 10.1+11+9.9+9.1+8.2。期间修掉「本库没有 `zt_execution` 表（要沿 `zt_project.parent` 爬）」与「`zt_story` 没有 `execution` 列」两个真 bug |
| DB 写线 | 克隆库 `zentao_probe`（`CREATE TABLE LIKE` + `REPLACE INTO SELECT` 整库 250 张表）跑 task 八动作 + bug 四动作 | 通过：每次都写全 task/bug + effort + action + actionrecent + history + notify + kanban，`zt_history` 用中文显示名、通知文案与禅道原字一致。期间修掉「`read` 是保留字要反引号」这个真 bug |
| HTTP 写线 | 真机对 task 903 发**必然被拒**的请求（完成时间早于开始时间、不存在的编号、空备注） | 通过：三种都正确报 `write-rejected`/`write`。期间修掉一个**严重** bug——`{"result":"fail","message":{"finishedDate":[…]}}` 曾被判成成功（`result` 是字符串 `"fail"`、`message` 是对象），现在只认 `result === "success"` 或 `true` |
| HTTP 写线（真机 13 动作） | 用户批准「写完立刻按快照回滚」后，在 task 2042 与 bug 5968 上真跑 8 个任务动作 + 5 个 BUG 动作，再按快照整表回滚 | 通过：13 步全部 `保存成功`，库内 task 状态/工时/指派、effort、action、actionrecent、history、notify、看板卡片都符合预期；回滚后逐表比对无差异。期间修掉三个真 bug——`confirmBug` 入口是 `f=confirm`（`f=confirmBug` 返回 0 字节）、数日志条数不能数 `effortID` 链接（biz 版详情页没有）、`activate` 不回填 `assignedTo` 会被清空 |
| 表单默认值回填 | 真机跑 bug `confirm` 看 `zt_history` | 通过：修之前会写出 `pri 1→3`、`type` 清空、`deadline` 清空、`assignedTo` 清空四条脏变更；改成一「先 GET 表单取每个控件当前值、再盖我们的字段」后，历史里只剩 `confirmed 0→1` 一条，与真实库 60 条 `bugconfirmed` 的形态一致 |
| 写护栏 | 真机逐条试 `status-mismatch`（对 doing 的任务 start、对 done 的任务 pause）与 `not-owner`（动别人名下的 2042） | 通过：都按预期拒绝并给出允许状态/打开 `write.allowOthers` 的提示 |
| DB 线等价（父任务汇总 / 需求阶段 / 索引） | 克隆库 `zentao_probe2`（pymysql 按 `SHOW CREATE TABLE` + `INSERT ... SELECT` 只复 task 2147 + 父 1947 与周边 23 张表）跑 start → recordworkhour → finish | 通过：子任务 `done/consumed 6.00/left 0.00/指回 openedBy`；父任务 1947 汇总成 `estimate 8.00 / consumed 6.00 / left 0.00` 并转 `done`；动作顺序 `task started → parent started → effort created → recordestimate → effort created → task finished → parent finished`；每个对象只留一行 `zt_searchindex`（id 复用）、`zt_searchdict` 98 行、effort 动作无 `zt_actionproduct`、父任务动作无通知。期间修掉两个真 bug——父任务「只汇总变了状态没变」被误报成「什么都没变」；空日期被写成 `0000-00-00 00:00:00`（本库约定是 `NULL`，会多出假 history 行） |
| BUG 日志工时 | 克隆库 `zentao_probe` 连记两条（1.5h + 0.5h） | 通过：`zt_effort` 两行（left=0、product/project/execution 照抄 BUG 行）、`zt_action` 两条 `recordestimate`（`read=1`、extra=本次数值）、`zt_history` 单行且是**累计值**（`0→1.5`、`1.5→2`）、`zt_actionproduct` 两行、`zt_actionrecent` 两行、**不发通知**；`zt_bug` 只更新 `lastEdited*` |
| 通道口径归一 | 真机同时读 task 2042 / bug 5968 的 `db` 与 `http` 两条通道 | 通过：HTTP 侧 `status` 仍是中文、「指派给」仍是中文名，同时 `codes` 给出 `doing`/`zhangsan`；DB 侧本来就是机器码。期间修掉一个**阻断性** bug——护栏拿机器码比中文，`write.mode=http`（默认值）下所有写操作都被自家护栏误杀 |

也就是说：装载、协议、双通道、配置页、工时统计、两条写线都已在真实环境跑过；凭据只存在宿主的凭据中心，配置文件里没有明文密码。
