# -*- coding: utf-8 -*-
"""盘某账号在禅道的「未完成待办」全量清单，用于核对下周计划有没有漏项。

用法：
    python audit_backlog.py [account] [spec.json]

- 不带 spec.json：只打印三层待办（bug / task / story），这就是下周计划应该覆盖的集合。
- 带 spec.json：把 spec.plan 与库里的待办做差集，列出「库里有、计划里没有」的对象，
  有漏项时退出码 1。-v 参数可看已覆盖的部分。

判定口径（必须与 SKILL.md 一致）：
  未解决 bug   zt_bug.assignedTo=账号 AND deleted='0' AND status='active'
  未完成任务   zt_task.assignedTo=账号 AND deleted='0' AND status IN ('wait','doing','pause')
  未启动需求   zt_story.assignedTo=账号 AND deleted='0' AND stage='projected'
"""
import sys, io, json, pymysql
import _db

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DB = _db.params(dict_cursor=True)

# 项目 -> 周报里的项目键（用于提示，不参与判定）
PROJECT_KEY = {215: 'YQ', 129: 'YQ0', 141: 'SZH', 135: 'KS',
               146: 'TC', 10: 'TX', 193: 'HS2', 144: 'HS1'}

SEV = {1: '致命', 2: '非常严重', 3: '严重', 4: '一般'}


def main():
    account = sys.argv[1] if len(sys.argv) > 1 else 'huzhihao'
    spec_path = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].endswith('.json') else None

    conn = pymysql.connect(**DB)
    cur = conn.cursor()

    cur.execute("""SELECT b.id, b.title, b.severity, b.project, LEFT(p.name,30) pname,
                          DATE(b.openedDate) od
                   FROM zt_bug b LEFT JOIN zt_project p ON p.id=b.project
                   WHERE b.assignedTo=%s AND b.deleted='0' AND b.status='active'
                   ORDER BY b.project, b.id""", (account,))
    bugs = cur.fetchall()

    cur.execute("""SELECT t.id, t.name, t.status, t.project, LEFT(p.name,30) pname,
                          t.consumed, t.`left`, t.story
                   FROM zt_task t LEFT JOIN zt_project p ON p.id=t.project
                   WHERE t.assignedTo=%s AND t.deleted='0' AND t.status IN ('wait','doing','pause')
                   ORDER BY t.project, t.id""", (account,))
    tasks = cur.fetchall()

    cur.execute("""SELECT s.id, s.title, s.stage, s.product, LEFT(pr.name,30) prname
                   FROM zt_story s LEFT JOIN zt_product pr ON pr.id=s.product
                   WHERE s.assignedTo=%s AND s.deleted='0' AND s.stage='projected'
                   ORDER BY s.product, s.id""", (account,))
    stories = cur.fetchall()
    conn.close()

    print(f'=== 未解决 bug {len(bugs)} 个 ===')
    for b in bugs:
        sev = SEV.get(b['severity'], b['severity'])
        print(f"  {b['id']:>5} [{sev}] {b['pname']} 开于{b['od']}  {b['title'][:46]}")

    print(f'=== 未完成任务 {len(tasks)} 个 ===')
    for t in tasks:
        print(f"  {t['id']:>5} [{t['status']:>5}] {t['pname']} "
              f"已用{t['consumed']}h 剩{t['left']}h  需求{t['story']}  {t['name'][:40]}")

    print(f'=== 未启动需求 {len(stories)} 个 ===')
    for s in stories:
        print(f"  {s['id']:>5} {s['prname']}  {s['title'][:50]}")

    total_bug = len(bugs)
    print(f'\n待办合计：bug {total_bug} / task {len(tasks)} / story {len(stories)}')

    if not spec_path:
        return

    spec = json.load(open(spec_path, encoding='utf-8'))
    plan_keys = {(kind, int(oid)) for _pk, kind, oid, *_ in spec['plan']}
    # 本周表里已列出但状态尚未完结的对象（如进度 50% 的任务）也算已覆盖
    week_keys = {(kind, int(oid)) for _pk, kind, oid, *_ in spec['week']}

    def report(label, rows, kind):
        missing = [r['id'] for r in rows if (kind, int(r['id'])) not in plan_keys]
        if missing:
            print(f'[漏项] {label} 计划里缺 {len(missing)} 个: {missing}')
            for r in rows:
                if int(r['id']) in missing:
                    name = r.get('title') or r.get('name')
                    print(f"      {r['id']}  {name[:52]}")
        else:
            print(f'[OK] {label} {len(rows)} 个已全部覆盖')
        return missing

    print('--- 与计划对账 ---')
    m1 = report('未解决 bug', bugs, 'bug')
    m2 = report('未完成任务', tasks, 'task')

    # 需求只要其名下任一任务进了计划即视为覆盖（周报里通常列任务而非需求）
    covered_story = set()
    for t in tasks:
        if t['story'] and ('task', int(t['id'])) in plan_keys | week_keys:
            covered_story.add(int(t['story']))
    m3 = [s['id'] for s in stories
          if ('story', int(s['id'])) not in plan_keys
          and ('story', int(s['id'])) not in week_keys
          and int(s['id']) not in covered_story]
    if m3:
        print(f'[漏项] 未启动需求 计划里缺 {len(m3)} 个: {m3}')
        for s in stories:
            if int(s['id']) in m3:
                print(f"      {s['id']}  {s['title'][:52]}")
    else:
        print(f'[OK] 未启动需求 {len(stories)} 个已全部覆盖（含由关联任务覆盖的）')

    extra = sorted(k for k in plan_keys if k[0] == 'bug' and k[1] not in {int(b['id']) for b in bugs})
    if extra:
        print(f'[提示] 计划里这 {len(extra)} 个 bug 在库里已不是 active（可能已解决/关闭）: {extra}')

    sys.exit(1 if (m1 or m2 or m3) else 0)


if __name__ == '__main__':
    main()
