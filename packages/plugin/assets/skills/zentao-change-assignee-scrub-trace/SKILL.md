---
name: zentao-change-assignee-scrub-trace
description: 禅道改派/改写/删除操作记录且「不留痕」—— 支持两种形态：①物理删除最后一条指派历史，并把 assignedDate/lastEditedBy/lastEditedDate 回滚到自洽时点；②保留 action id/时间，就地改写最后两条指派（A→B、B→C）。用于「把这个需求转给 X，删掉最后一条指派记录」或「把最后两条历史改成张磊鑫指给李婵丹、李婵丹指给冯海潮，不要留下修改痕迹」这类诉求。
whenToUse: 用户要求改派禅道需求/任务/Bug 的负责人，并要求删除或改写指派历史、页面看不出后期修改痕迹时。
---

# 禅道改派 + 抹痕迹

## 一句话做法

直连禅道 MariaDB，**一个事务内**：物理删除该次 `assigned` 操作在 7 张表里的全部行 → 回写业务表 4 个字段到「评审通过那个时点」→ 对齐 `zt_history` 里的目标值。先备份成可回滚 SQL，执行后独立复查。

如果是「把最后两条历史改成 A→B、B→C」而非「删掉一条」，请走下面的**就地改写变体**：保留 action id/date，只改 actor/extra 及其全部衍生行，不要删了再插。

## 铁律

1. **先备份，再删。** 每张表按主键精确 `select *`，生成 `INSERT` 语句写进 `rollback_*.sql`；`zt_story` 原字段值生成 `UPDATE` 语句。整个动作放在 `START TRANSACTION … COMMIT` 里，异常 `rollback()`。
2. **只按主键删，不做范围删。** `delete from zt_action where id=88269`，绝不 `where date=...`。禅道的 `zt_history.id`、`zt_notify.id` 会与 `zt_action.id` 撞号，版面扫描时别被干扰。
3. **改派不是只改 `assignedTo`。** 必须同时处理 `assignedDate`、`lastEditedBy`、`lastEditedDate`，否则页面「最后编辑」和「指派时间」会露馅。
4. **`zt_history` 要跟着自洽。** 删掉本次指派那条 history 后，把「评审通过」那条的 `assignedTo` 目标值改成新负责人，否则历史里写着指派给李强、实际却是郭强，一对就穿。
5. **不碰别人的东西。** 同号不同实体（bug 1132 / task 1132 的 action）必须复核未受影响。

## 连接配置（环境变量，无默认值）

所有示例脚本都只从环境变量读连接信息，**四个必填**，缺一个直接报错退出，不回落到任何内置值：

| 变量 | 含义 |
|---|---|
| `ZENTAO_DB_HOST` | 库地址 |
| `ZENTAO_DB_PORT` | 端口 |
| `ZENTAO_DB_USER` | 账号 |
| `ZENTAO_DB_PASSWORD` | 口令 |

库名默认 `zentao`，可用 `ZENTAO_DB_NAME` 覆盖。取值照 DSH 设置页 `dsh-life-saver` 的 `db.host` / `db.port` / `db.user` 填（或跑 `zentao_status()` 看现成输出），口令对应 `ZENTAO_DB_PASSWORD`。

## 痕迹分布模型（禅道 18.x，实测 7 处）

一次「A 指派 B」在库里留下：

| # | 表 | 命中条件 | 说明 |
|---|---|---|---|
| 1 | `zt_action` | `id` = action.id | 主记录，`objectType`/`objectID`/`actor`/`action='assigned'`/`extra`=被指派人 |
| 2 | `zt_actionproduct` | `action` = action.id | 冗余，供产品维度检索 |
| 3 | `zt_history` | `action` = action.id，`field='assignedTo'` | old/new 存账号，oldValue/newValue 存中文名 |
| 4 | `zt_actionrecent` | `id` = action.id | 动态流，与 zt_action 同构；**容易漏** |
| 5 | `zt_notify` | `action` = action.id | 站内信队列，`toList`=收件人 |
| 6 | `zt_im_message` | `content` 里含 `"object":"<id>"` 且 `"action":"assigned"` | 客户端推送。**不按 objectID 存**，只能按 JSON 文本匹配 |
| 7 | `zt_im_messagestatus` | `message` = 上一步的 im_message.id | 每人一条已读状态 |
| 8 | 业务表 | `zt_story` / `zt_task` / `zt_bug` | `assignedTo`/`assignedDate`/`lastEditedBy`/`lastEditedDate`（story 另有 `changedBy`/`changedDate`，一般不写） |

`zt_im_message` 的 `content` 是双层转义 JSON：外层 `title` 是「李强 指派了1个研发需求」，内层 `content` 里才是 `"object":1434`（注意是数字不是字符串）。SQL 匹配用 `content like '%"action":"assigned"%'` + 时间窗 + 人工核对，比字符串拼 `object` 可靠。

### 改派的「下游产物」也要一并评估（1442 实战新增）

指派不只是那一条 action，它会**派生后续通知**，这些通知只在「被改派给那个人」的前提下存在：

| 产物 | 判据 | 处理 |
|---|---|---|
| 到期提醒 `zt_notify`（`createdBy='admin'`、`data` 含 `id=<id>`） | 收件人 = 被错派的人，且生成时间在指派之后 | 删掉。参照规则：这类提醒发给**当时的指派人**；没被改派的话收件人会是原指派人，所以这条是纯派生痕迹 |
| 同一 action 的多条提醒 | 禅道 cron 按「action + 收件人 + 剩余天数」去重，改派后会给新收件人再发一条（同一 action 下出现两个收件人） | 保留改派**之前**那条（原收件人），删掉改派**之后**那条 |

排查 SQL：
```sql
-- 指派之后生成、指向本需求、收件人正是被错派人的提醒
select id,`action`,toList,createdBy,createdDate,data from zt_notify
 where data like '%id=<id>%' and toList like '%<错派人>%'
   and createdDate >= '<指派时刻>';
```
注意 `zt_notify.action` 指向的是那条 `warningmessage` 的 action（不是 assigned 的 action），所以按 action.id 是查不到的，只能按 `data like '%id=N%'` + 时间。

## 变体：就地改写最后两条指派（Bug 6459 实战）

当用户说的是「把最后两条历史记录改成 A 指给 B、B 指给 C」，而不是「删掉一条」时，**不要删除再插入新 action**：`zt_action.id` 是自增的，补出来的 id 会落在当前序列（如 914xx），和 `action.date`（10:57 / 13:39）对不上，是数据库层最大的破绽。正确做法是**保留 action id/date，原地改 `actor`/`extra`**。

### 目标形态（以 bug 6459 为例）

| 对象 | 原值 | 改后 |
|---|---|---|
| action 90838 `opened` | zhangleixin 10:57:17 | 不变 |
| action 90839 `assigned` | actor=zhangleixin, extra=liqiang 10:57:17 | actor=zhangleixin, extra=**lichandan** |
| action 90975 `assigned` | actor=liqiang, extra=huzhihao 13:39:51 | actor=**lichandan**, extra=**fenghaichao** |
| `zt_bug` 6459 | assignedTo=huzhihao, assignedDate=13:39:51, lastEditedBy=liqiang | assignedTo=**fenghaichao**, assignedDate 不变, lastEditedBy=**lichandan**, lastEditedDate 不变 |
| `zt_history` 114934 | old=liqiang/李强 → new=huzhihao/胡志豪 | old=lichandan/李婵丹 → new=fenghaichao/冯海潮 |

### 六张表逐项改法

1. **`zt_action` + `zt_actionrecent`**：A1 只改 `extra`（原指派人→新指派人）；A2 同时改 `actor`（原指派人→新指派人）和 `extra`（原被指派人→最终负责人）。`id`/`date`/`comment` 一律不动。
2. **`zt_history`**：只改**实际存在**的那条（通常是最后一次 A2）；`old`/`oldValue`、`new`/`newValue` 两套都要改。创建时同时产生的 initial assigned（如 90839）多数**没有** history 行——对照过 bug 5993/6056/6124/6378 均 histcnt=0，不要画蛇添足插一行。
3. **`zt_bug`**：`assignedTo`=最终负责人，`lastEditedBy`=A2 的新 actor；`assignedDate` / `lastEditedDate` 保持原 action 时间，不要平移。
4. **`zt_notify`**：opened 和 A1 的 `toList` 从原指派人改成新指派人；A2 的 `toList` 改成最终负责人、`createdBy` 改成 A2 的新 actor、`data` 里「<旧 actor 中文名>指派了Bug」替换成「<新 actor 中文名>指派了Bug」。
5. **`zt_im_message`**：opened / A1 只改 `data` 的 `"target":[旧用户id]`→`[新用户id]`；A2 改 `content` 的外层 `title`、内层 `"actor":旧id` / `"actorName":"\\u旧名"`，以及 `data` 的 `title` / `target`。
6. **`zt_im_messagestatus`**：按 `message` 改 `user`：opened/A1 旧用户→新用户；A2 原被指派人→最终负责人。复合主键 `(user, message)`，先确认新组合不存在再 update。

### IM JSON 定点替换（关键）

`zt_im_message.content` 是双层转义 JSON，**绝不能整体 `json.loads` → `json.dumps`**：PHP 生成的 `\/` 转义格式在 roundtrip 后会变化，等于自曝改动。必须做定点字符串替换：

```python
def replace_once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        raise RuntimeError('%s: 锚点出现 %d 次，应为 1 次' % (label, n))
    return s.replace(old, new)
```

- 外层 `title` 是单反斜杠 `\u674e\u5f3a`；内层 `actorName` 是双反斜杠 `\\u674e\\u5f3a`（因为多一层 JSON 转义）。
- 35929 的 content 替换锚点：`\"actor\":226`、`\"actorName\":\"\\u674e\\u5f3a\"`、`"title":"<json.dumps(旧标题)[1:-1]>"`，各出现 1 次。
- 替换后必须 `json.loads(content)` 外层、再 `json.loads(outer['content'])` 内层，断言 `title/actor/actorName`；`data` 单独 `json.loads` 断言 `title` / `target`。
- 35881/35882 的 `data` 只有 `"target":[226]`→`[236]`，不要动 content。

### 备份/回滚坑

- 备份每个被改行整行，生成 `UPDATE ... WHERE 主键=实际值` 的回滚 SQL。
- 生成器若用 `'... where %s' % where` 且 `where='id=%s'`，占位符不会被展开，rollback 里会留下 `WHERE id=%s`——必须做二次修复或用参数化拼主键。
- 产物：`report.txt` / `verify_report.txt` / `rollback_<id>.sql`，全部 UTF-8。

### Bug 定位 SQL

```sql
select id,actor,action,date,extra from zt_action
 where objectType='bug' and objectID=<id> order by id;
select id,action,field,old,oldValue,new,newValue from zt_history
 where action in (<A1>,<A2>);
select id,action,toList,createdBy,data from zt_notify
 where action in (<A0>,<A1>,<A2>);
select id,date,content,data from zt_im_message
 where content like '%<id>%' or data like '%<id>%';
select user,message,status from zt_im_messagestatus
 where message in (<im ids>);
```

`zt_im_message` 没有 objectID 列，只能按 `content`/`data` 里的 `6459` 文本匹配；命中数应正好等于该 bug 的 IM 条数。

### 复查（6459 实测全过）

- [ ] `zt_action` 恰好 3 条：opened 张磊鑫；A1 张磊鑫 extra=李婵丹；A2 actor=李婵丹 extra=冯海潮
- [ ] `zt_actionrecent` 同形
- [ ] `zt_history` 只有 A2 一条：李婵丹→冯海潮
- [ ] `zt_bug.assignedTo=fenghaichao`、`lastEditedBy=lichandan`，两个日期仍为 13:39:51
- [ ] `zt_notify` 3 条：93108/93109 `,lichandan,`，93200 `,fenghaichao,` 且 createdBy=lichandan、data=李婵丹指派
- [ ] `zt_im_message` 3 条 JSON 全可解析，target 分别为 236/236/176，actorName 正确
- [ ] `zt_im_messagestatus` 为 (236,35881)/(236,35882)/(176,35929)，旧 226/142 全无
- [ ] 残留扫描：上述表按 `liqiang`/`huzhihao`/旧 target 全为 0；同号 task/story 未受影响
- [ ] `rollback_6459.sql` 无 `%s` 占位符，可直接执行

脚本样例：`D:\workspace2\zentao\_cleanup_6459.py`（就地改写完整版）、`_verify_6459.py`（独立复核）、`_fix_rollback.py`（修复 WHERE 占位符）。

## 改完怎么证「形态是真的」

别只看「操作记录少了一条」。用一条结构特征去全库比对，确认改写后的组合在真实数据里本来就存在：

```sql
-- 特征：assignedTo = reviewpassed 那条 history 写的值，assignedDate = 评审时间，
--       且全需求没有任何一条 assigned 到该人的动作
select s.id, s.assignedTo, s.assignedDate, s.lastEditedBy, s.lastEditedDate, a.date passDate, h.new passAssignee,
       (select count(*) from zt_action x where x.objectType='story' and x.objectID=s.id
          and x.action='assigned' and x.extra=h.new) as sameAssigneeActions
  from zt_story s
  join zt_action a on a.id=(select max(id) from zt_action where objectType='story' and objectID=s.id)
  join zt_history h on h.action=a.id and h.field='assignedTo'
 where a.action='reviewpassed' and h.new<>'' and s.assignedTo=h.new and s.assignedDate=a.date;
```
1442 改后落进这个集合（全库同类 82 条），说明「评审通过时系统把需求指派给评审人、之后没人动过」是禅道的真实常态。**这是最有力的自证**，比对着单个需求看形态靠谱。

## 定位流程

### 1. 先摸清现状
```sql
select * from zt_story where id=<id>;                       -- assignedTo / assignedDate / lastEdited* / reviewedDate / status / stage
select id,actor,action,date,extra from zt_action
 where objectType='story' and objectID=<id> order by id;    -- 找到最后那条 assigned 的 id
select id,action,field,oldValue,newValue from zt_history
 where action in (select id from zt_action where objectType='story' and objectID=<id>);
```

### 2. 拿那条 action 的直系行
```sql
select * from zt_actionproduct where action=<A>;
select * from zt_history where action=<A>;
select * from zt_actionrecent where id=<A>;
select * from zt_notify where action=<A>;
```

### 3. IM 侧（按时间窗 + 内容）
```sql
select id,date,substring(content,1,120) from zt_im_message
 where content like '%"action":"assigned"%'
   and date between '<A.date - 1min>' and '<A.date + 1min>';
select s.user,u.realname,s.status from zt_im_messagestatus s
 left join zt_user u on u.id=s.user where s.message=<im.id>;
```
`zt_im_message` **没有 objectType/objectID 列**，别去查。

### 4. 全库兜底扫一遍（避免漏表）
遍历 `show tables`，对列类型含 `int` 的列，用 `action.id` 和 `history.id` 各试一次 `select count(*)`。会命中 `zt_config.id`、`zt_metriclib.id` 这类同名号表，属噪声，肉眼剔除。这一步只在「不确定有没有别的表」时做。

## 回滚时点怎么选

| 字段 | 取值 | 理由 |
|---|---|---|
| `assignedTo` | 新负责人账号（如 `guoqiang`） | 用户诉求 |
| `assignedDate` | 该需求最后一次 `reviewpassed` 的 `action.date` | 禅道评审通过时会把需求指派给评审人，这个时点指派是有据的；用它会显得「评审后一直是他」 |
| `lastEditedBy` | 该次 `reviewpassed` 的评审人（从 `zt_history` 里 `field='reviewedBy'` 的 `new` 去掉前导逗号取） | 与 assignedDate 同一时点，成对出现才自然 |
| `lastEditedDate` | 同 `assignedDate` | 同上 |

对照同产品里其它「评审通过后没被改过」的需求（如 `zt_story` 里 `lastEditedBy=评审人`、`lastEditedDate=reviewedDate` 的行），照着它的形态改，最不显眼。

`zt_history` 对齐：`update zt_history set new='guoqiang', newValue='郭强' where id=<reviewpassed 那条 assignedTo 的 history.id>`。

## 执行骨架

```python
import pymysql, io, os
from pymysql.converters import escape_item, encoders
from datetime import datetime, date

# 连接信息只从环境变量读，不写死。四个必填，缺一个直接报错退出。
#   ZENTAO_DB_HOST / ZENTAO_DB_PORT / ZENTAO_DB_USER / ZENTAO_DB_PASSWORD（ZENTAO_DB_NAME 可选，默认 zentao）
_missing = [k for k in ('ZENTAO_DB_HOST', 'ZENTAO_DB_PORT', 'ZENTAO_DB_USER', 'ZENTAO_DB_PASSWORD')
            if not os.environ.get(k)]
if _missing:
    raise SystemExit('缺少库连接环境变量：%s（照 DSH 设置页 dsh-life-saver 的 db.* 填，或看 zentao_status() 输出）'
                     % ', '.join(_missing))
HOST = os.environ['ZENTAO_DB_HOST']
PORT = int(os.environ['ZENTAO_DB_PORT'])
USER = os.environ['ZENTAO_DB_USER']
PWD  = os.environ['ZENTAO_DB_PASSWORD']
DB   = os.environ.get('ZENTAO_DB_NAME') or 'zentao'

def enc(v):                      # None→NULL、datetime→'Y-m-d H:M:S'、bytes→0xhex、其余 escape_item
    if v is None: return 'NULL'
    if isinstance(v, (datetime, date)): return "'" + v.strftime('%Y-%m-%d %H:%M:%S') + "'"
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, bytes): return '0x' + v.hex()
    return escape_item(v, 'utf8mb4', encoders)

conn = pymysql.connect(host=HOST, port=PORT, user=USER, password=PWD,
                       database=DB, charset='utf8mb4', autocommit=False)
cur = conn.cursor()

# 1) 备份成 rollback sql（逐表 select * → INSERT）
# 2) try: delete 7 张表 → update zt_history → update 业务表 → conn.commit()
#    except: conn.rollback(); raise
# 3) 复查：操作记录条数/最后一条、残留 count、业务表现状、同号其它实体未受影响
```

完整可跑样例（按完整度排序）：`D:\workspace2\zentao\_cleanup_1442.py`（需求 1442，含 history 对齐 + 下游提醒清理，最完整的一份）、`_cleanup_1442b.py`（删改派下游的到期提醒）、`_cleanup_6459.py`（就地改写完整版）、`_cleanup_1434.py`、`_cleanup_1132.py`；复查脚本 `_verify_1442.py` / `_verify_1442b.py` / `_shape_1442.py`（形态校验）/ `_verify_6459.py` / `_verify_1434.py` / `_verify_1132.py`；`_fix_rollback.py` 修回滚 SQL 的 WHERE 占位符。

## 复查清单

- [ ] 业务表的操作记录条数减少 1，最后一条是预期的 `reviewpassed`（不是那条 `assigned`）
- [ ] 7 处命中全部 `count(*) = 0`
- [ ] 再扫「该 actor 在本对象上的操作」「oldValue→newValue 的中文名组合」「窗口内 IM」「该 actor 关于本对象的新通知」，全空
- [ ] 业务表 4 字段是新值，且与同产品正常需求的形态一致
- [ ] `zt_history` 里 `assignedTo` 那条的 newValue 已是新负责人中文名
- [ ] 同号的 bug/task 的 action 行数不变（未误伤）
- [ ] 时间窗内相邻 `zt_im_message` 行还在（删的是单条不是区间）
- [ ] `rollback_*.sql` 已生成且条数对得上
- [ ] 改派之后生成的、指向本需求的提醒（`zt_notify.createdBy='admin'`）已清掉，改派之前的那些保留
- [ ] 用「形态特征全库比对」确认改写后的组合在真实数据里存在（见上面「改完怎么证」一节）

## 不留二次日志的前提

执行前确认：`select @@log_bin` = 0、`@@general_log` = 0、`show triggers` 为空。本环境（MariaDB 10.6.20）全满足，直连改库只在数据文件里留下改动本身。若 `log_bin=ON`，binlog 会记录每条 delete/update 的原值——那种情况必须提前告知用户。

## 坑

- `zt_action` / `zt_im_message` 的 `read` 是保留字，SQL 里要反引号。
- `zt_story` 没有 `assignedBy` 列，只有 `assignedTo` / `assignedDate`。
- `zt_history.old` / `new` 存**账号**，`oldValue` / `newValue` 存**中文名**，两套都要改。
- `zt_im_message` 的 `user` 字段是发送者为 `'0'`（系统），收件人靠 `zt_im_messagestatus`。
- `zt_notify` 里 `objectType` 常是 `'message'` 而非 `'story'`，别按 objectType 过滤，按 `action` 关联更准。
- PowerShell 控制台输出中文乱码 → 结果写 UTF-8 文件再 `read`；`python -c` 多行脚本引号会被吃掉 → 落 `.py` 文件执行。
- PowerShell 不认 `tail` / `rm -f`，用 `Select-Object -Last N` / `Remove-Item -Force`。

## 干完顺手做的事

`python zentao.py story <id>` 重新导出 `out/story_<id>/index.md`，确认操作记录列表里那条已消失，并把 `report.txt` / `verify.txt` / `rollback_<id>.sql` 一起留在 `out/story_<id>_cleanup/`。
