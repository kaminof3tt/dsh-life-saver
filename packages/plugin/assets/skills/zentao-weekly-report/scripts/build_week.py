# -*- coding: utf-8 -*-
"""按公司模板生成「研发部周工作总结 / 下周计划」xlsx。

用法：
    python build_week.py spec.json

spec.json 结构（week 数组里每一项 = 一行）：
{
  "src":  "D:\\Document\\公司\\研发-后端-胡志豪.xlsx",          // 模板，只读不改
  "dst":  "D:\\Document\\公司\\研发-后端-胡志豪_20261026-20261030.xlsx",
  "owner": "胡志豪",
  "eff_from": "2026-10-24", "eff_to": "2026-10-30",            // 取工时的日期窗口
  "week_title": "研发部2026.10.26 至 2026.10.30 工作总结",
  "plan_title": "研发部2026.11.02 至 2026.11.06 工作计划",
  "week": [["YQ","bug",5902,"排查定位后转姜学哲提交修复",1], ...],
  "plan": [["YQ","bug",4207,"存量缺陷",0,"2026-11-02","2026-11-02",2], ...],
  "noeff_date": {"4262":"2026-10-26"}                          // 可选：无工时但有动作的 bug 的日期
}

week 每项：[项目键, 类型, 禅道ID, 备注, 进度]
plan 每项：[项目键, 类型, 禅道ID, 备注, 进度, 开始, 结束, 工时]

要点：
- 工作内容一律从库里的 zt_bug.title / zt_task.name / zt_story.title 现取，绝不手写（手写一定会被用户抓到与禅道原文不一致）。
- 开始/结束/完成时长从 zt_effort 现算；库里没有工时的，走 noeff_date 兜底。
- 模板第 3 行是样式源；数据从第 3 行开始写，写完删掉多余的模板行。
"""
import math, shutil, io, sys, json, datetime as dt
from copy import copy
import pymysql, openpyxl
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
import _db

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DB = _db.params()

# 项目键 -> (项目名称, 分支名称)
PROJ = {
    'YQ':  ('园区物管', 'develop/v2.6.2-yuanqu-wg'),
    'SZH': ('苏住房',   'develop/v2.6.2-suzhufang-dev'),
    'KS':  ('昆山物管', 'suzhou-kunshan-dev-v1.39.4'),
    'WX':  ('无锡三资', 'develop/v2.6.2-wuxisanzi'),
    'TC':  ('太仓物管', 'suzhou-taicang-wuguan-dev-v1.26'),
    'TX':  ('泰兴物管', 'develop/v2.6.2-taixing'),
    'YQ0': ('园区V0',   'dev'),
    'HS2': ('惠山物管', 'develop/v2.6.2-huishan'),
    'HS1': ('惠山物管V1', 'dev'),
}

TITLE_SQL = {
    'bug':   'SELECT title FROM zt_bug WHERE id=%s',
    'task':  'SELECT name  FROM zt_task WHERE id=%s',
    'story': 'SELECT title FROM zt_story WHERE id=%s',
}
TYPE_OF = {'bug': 'BUG修复', 'task': '功能开发', 'story': '功能开发'}


def disp_len(s):
    return sum(2 if ord(c) > 127 else 1 for c in str(s))


def fill_sheet(ws, rows, title_text, owner):
    """rows: [(项目名, 分支, ID, 内容, 开始, 结束, 工时, 类型, 进度, 备注), ...]"""
    ws['A1'] = title_text
    n = len(rows)
    last = ws.max_row
    tpl_style = {c: copy(ws.cell(row=3, column=c)._style) for c in range(1, 13)}
    tpl_align = {c: copy(ws.cell(row=3, column=c).alignment) for c in range(1, 13)}

    for i, rec in enumerate(rows):
        r = 3 + i
        proj, branch, oid, content, sd, ed, hrs, typ, prog, note = rec
        vals = [i + 1, owner, proj, branch, oid, content, sd, ed, hrs, typ, prog, note]
        for c, v in enumerate(vals, start=1):
            cell = ws.cell(row=r, column=c)
            cell.value = v
            cell._style = copy(tpl_style[c])

        ws.cell(row=r, column=7).number_format = 'yyyy/mm/dd'
        ws.cell(row=r, column=8).number_format = 'yyyy/mm/dd'
        ws.cell(row=r, column=11).number_format = '0%'

        # 长文本列：换行 + 垂直居中，内容列/备注列靠左
        for c in (3, 4, 6, 12):
            a = copy(tpl_align[c])
            a.wrap_text = True
            a.vertical = 'center'
            a.horizontal = 'left' if c in (6, 12) else 'center'
            ws.cell(row=r, column=c).alignment = a

        # 行高按「显示宽度 / 列宽」估算换行行数，否则 Excel 打开会压行
        lines = 1
        for c in (3, 4, 6, 12):
            w = ws.column_dimensions[get_column_letter(c)].width or 12
            lines = max(lines, math.ceil(disp_len(vals[c - 1] or '') / max(w - 1.5, 6)))
        ws.row_dimensions[r].height = 17 * lines + 5

    if last > 2 + n:                      # 抹掉模板里多出来的空行
        ws.delete_rows(3 + n, last - (2 + n))


def main():
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    src, dst, owner = spec['src'], spec['dst'], spec.get('owner', '胡志豪')

    conn = pymysql.connect(**DB)
    cur = conn.cursor()

    def title(kind, oid):
        cur.execute(TITLE_SQL[kind], (int(oid),))
        r = cur.fetchone()
        return r[0] if r else ''

    # 工时窗口内按对象聚合
    cur.execute(
        "SELECT e.objectType, e.objectID, SUM(e.consumed), MIN(e.date), MAX(e.date) "
        "FROM zt_effort e JOIN zt_user u ON u.account=e.account "
        "WHERE u.account=%s AND e.date BETWEEN %s AND %s "
        "GROUP BY e.objectType, e.objectID",
        (spec.get('account', 'huzhihao'), spec['eff_from'], spec['eff_to']))
    eff = {(t, int(i)): (float(h), d1, d2) for t, i, h, d1, d2 in cur.fetchall()}

    noeff = {int(k): dt.date.fromisoformat(v) for k, v in spec.get('noeff_date', {}).items()}

    week = []
    for pk, kind, oid, note, prog in spec['week']:
        h, d1, d2 = eff.get((kind, oid), (None, None, None))
        if h is None and oid in noeff:            # 有动作没记工时 -> 用 resolvedDate 兜底
            d1 = d2 = noeff[oid]
        proj, branch = PROJ[pk]
        week.append((proj, branch, oid, title(kind, oid), d1, d2, h, TYPE_OF[kind], prog, note))

    plan = []
    for pk, kind, oid, note, prog, sd, ed, hrs in spec['plan']:
        proj, branch = PROJ[pk]
        plan.append((proj, branch, oid, title(kind, oid),
                     dt.date.fromisoformat(sd), dt.date.fromisoformat(ed),
                     hrs, TYPE_OF[kind], prog, note))

    conn.close()                                  # 标题必须全部取完再关连接

    shutil.copyfile(src, dst)
    wb = load_workbook(dst)
    ws1, ws2 = wb.worksheets[0], wb.worksheets[1]
    ws1.column_dimensions['D'].width = 34.0       # 分支名太长，默认列宽放不下
    ws2.column_dimensions['D'].width = 34.0
    fill_sheet(ws1, week, spec['week_title'], owner)
    fill_sheet(ws2, plan, spec['plan_title'], owner)
    wb.save(dst)

    print('saved', dst)
    print('week rows', len(week), 'hours', round(sum(r[6] or 0 for r in week), 2))
    print('plan rows', len(plan), 'hours', sum(r[6] for r in plan))


if __name__ == '__main__':
    main()
