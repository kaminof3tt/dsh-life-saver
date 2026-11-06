# -*- coding: utf-8 -*-
"""禅道只读查询小工具。

用法：  python q.py <sql文件> <输出文件>
- SQL 文件里多条语句用 `;;` 分隔
- 结果写成 UTF-8 文本（Windows 控制台是 GBK，直接 print 中文会乱码，所以一律落文件）
- 连接信息只从环境变量读（见 _db.py），脚本不内置地址与口令
"""
import sys, io, pymysql
import _db

DB = _db.params(dict_cursor=True)

sql = open(sys.argv[1], encoding='utf-8-sig').read()
out = io.StringIO()
c = pymysql.connect(**DB)
with c.cursor() as cur:
    for stmt in [s for s in sql.split(';;') if s.strip()]:
        cur.execute(stmt)
        rows = cur.fetchall()
        out.write('### ' + stmt.strip().split('\n')[0][:90] + '\n')
        if not rows:
            out.write('(empty)\n')
            continue
        cols = list(rows[0].keys())
        out.write(' | '.join(cols) + '\n')
        for r in rows:
            out.write(' | '.join('' if r[k] is None else str(r[k]).replace('\n', ' ') for k in cols) + '\n')
        out.write('rows=%d\n' % len(rows))
open(sys.argv[2], 'w', encoding='utf-8').write(out.getvalue())
print('ok')
