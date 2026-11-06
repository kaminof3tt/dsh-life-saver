# -*- coding: utf-8 -*-
"""周报 xlsx 与禅道库对账。

用法：
    python verify_week.py <xlsx> <eff_from> <eff_to> [account]

输出：
- DB 侧：(类型, ID, 工时) 集合（只统计该账号自己的 zt_effort）
- XLSX 侧：(类型, ID, 工时) 集合（Sheet1 本周表）
- 缺项（库里有、表里没有）、多项（表里有、库里没工时）、工时不一致、合计对比
- Sheet2 计划表逐行 dump

退出码非 0 表示有缺项或合计不一致。
"""
import sys, io, pymysql, openpyxl
import _db
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

path, d1, d2 = sys.argv[1], sys.argv[2], sys.argv[3]
account = sys.argv[4] if len(sys.argv) > 4 else 'huzhihao'

conn = pymysql.connect(**_db.params())
cur = conn.cursor()
cur.execute(
    "SELECT e.objectType, e.objectID, SUM(e.consumed) "
    "FROM zt_effort e JOIN zt_user u ON u.account=e.account "
    "WHERE u.account=%s AND e.date BETWEEN %s AND %s "
    "GROUP BY e.objectType, e.objectID", (account, d1, d2))
db = {(t, int(i)): float(h) for t, i, h in cur.fetchall()}

cur.execute("SELECT id FROM zt_bug")
bugs = {r[0] for r in cur.fetchall()}
cur.execute("SELECT id FROM zt_task")
tasks = {r[0] for r in cur.fetchall()}
cur.execute("SELECT id FROM zt_story")
stories = {r[0] for r in cur.fetchall()}
conn.close()

wb = openpyxl.load_workbook(path, data_only=True)
ws = wb.worksheets[0]
xl = {}
total_x = 0.0
for r in range(3, ws.max_row + 1):
    oid, typ, hrs = ws.cell(row=r, column=5).value, ws.cell(row=r, column=10).value, ws.cell(row=r, column=9).value
    if oid is None:
        continue
    oid = int(oid)
    kind = 'bug' if typ == 'BUG修复' else ('task' if oid in tasks else 'story')
    h = float(hrs or 0)
    xl[(kind, oid)] = h
    total_x += h

db_bug = sum(v for (t, _), v in db.items() if t == 'bug')
db_task = sum(v for (t, _), v in db.items() if t == 'task')
db_bug_n = sum(1 for (t, _) in db if t == 'bug')
db_task_n = sum(1 for (t, _) in db if t == 'task')
xl_bug = sum(v for (t, _), v in xl.items() if t == 'bug')
xl_task = sum(v for (t, _), v in xl.items() if t != 'bug')
xl_bug_n = sum(1 for (t, _) in xl if t == 'bug')
xl_task_n = sum(1 for (t, _) in xl if t != 'bug')

print(f'DB  : bug {db_bug_n} 个 {db_bug:.2f}h | task {db_task_n} 个 {db_task:.2f}h | 合计 {db_bug + db_task:.2f}h')
print(f'XLSX: bug {xl_bug_n} 行 {xl_bug:.2f}h | task/story {xl_task_n} 行 {xl_task:.2f}h | 合计 {xl_bug + xl_task:.2f}h')

missing = sorted(k for k in db if k not in xl)
extra = sorted(k for k in xl if k not in db)
diff = sorted((k, db[k], xl[k]) for k in db if k in xl and abs(db[k] - xl[k]) > 0.001)
print('缺项(库有表无):', missing)
print('多项(表有库无工时):', extra)
print('工时不一致:', diff)

print('--- 下周计划 ---')
ws2 = wb.worksheets[1]
plan_total = 0.0
for r in range(3, ws2.max_row + 1):
    oid = ws2.cell(row=r, column=5).value
    if oid is None:
        continue
    hrs = float(ws2.cell(row=r, column=9).value or 0)
    plan_total += hrs
    print(ws2.cell(row=r, column=1).value, ws2.cell(row=r, column=3).value, oid,
          str(ws2.cell(row=r, column=6).value)[:40],
          ws2.cell(row=r, column=7).value, ws2.cell(row=r, column=8).value, hrs,
          ws2.cell(row=r, column=11).value, ws2.cell(row=r, column=12).value)
print('计划合计', plan_total)

bad = bool(missing) or abs((db_bug + db_task) - (xl_bug + xl_task)) > 0.001 or bool(diff)
sys.exit(1 if bad else 0)
