---
name: zentao-change-assignee-scrub-trace
description: 禅道改派/删除操作记录且「不留痕」—— 把某条指派改到别人名下、物理删除指派历史、并把 assignedDate/lastEditedBy/lastEditedDate 回滚到自洽时点，使页面看不出后期改动。用于「把这个需求转给 X，删掉最后一条指派的历史记录，不要看出后期修改痕迹」这类诉求。
whenToUse: 用户要求改派禅道需求/任务/Bug 的负责人，同时要求删掉指派历史、不留修改痕迹时。
---

# 禅道改派 + 抹痕迹

## 一句话做法

直连禅道 MariaDB，**一个事务内**：物理删除该次 `assigned` 操作在 7 张表里的全部行 → 回写业务表 4 个字段到「评审通过那个时点」→ 对齐 `zt_history` 里的目标值。先备份成可回滚 SQL，执行后独立复查。

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

完整可跑样例：`D:\workspace2\zentao\_cleanup_1434.py`（需求 1434，含 history 对齐）与 `_cleanup_1132.py`（需求 1132，无对齐）；对应的独立复查脚本 `_verify_1434.py` / `_verify_1132.py`。

## 复查清单

- [ ] 业务表的操作记录条数减少 1，最后一条是预期的 `reviewpassed`（不是那条 `assigned`）
- [ ] 7 处命中全部 `count(*) = 0`
- [ ] 再扫「该 actor 在本对象上的操作」「oldValue→newValue 的中文名组合」「窗口内 IM」「该 actor 关于本对象的新通知」，全空
- [ ] 业务表 4 字段是新值，且与同产品正常需求的形态一致
- [ ] `zt_history` 里 `assignedTo` 那条的 newValue 已是新负责人中文名
- [ ] 同号的 bug/task 的 action 行数不变（未误伤）
- [ ] 时间窗内相邻 `zt_im_message` 行还在（删的是单条不是区间）
- [ ] `rollback_*.sql` 已生成且条数对得上

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
