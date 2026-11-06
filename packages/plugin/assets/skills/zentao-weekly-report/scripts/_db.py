# -*- coding: utf-8 -*-
"""禅道库连接参数：只从环境变量读，不写死任何地址或口令，也没有任何默认值。

四个必填，缺一个就报错退出（退出码 2），不回落到任何内置值：
    ZENTAO_DB_HOST      库地址
    ZENTAO_DB_PORT      端口
    ZENTAO_DB_USER      账号
    ZENTAO_DB_PASSWORD  口令
    ZENTAO_DB_NAME      库名（可选，默认 zentao）

地址/端口/账号从 DSH 设置页的 dsh-life-saver 插件配置里取（`db.host` / `db.port` /
`db.user`，或 `zentao_status()` 的输出），口令在凭据中心或 `ZENTAO_DB_PASSWORD`。
"""
import os
import sys

REQUIRED = ('ZENTAO_DB_HOST', 'ZENTAO_DB_PORT', 'ZENTAO_DB_USER', 'ZENTAO_DB_PASSWORD')


def _missing():
    return [k for k in REQUIRED if not os.environ.get(k)]


def require():
    """校验必填变量，缺了就打印人话并退出码 2。"""
    missing = _missing()
    if missing:
        sys.stderr.write(
            '禅道库连接参数缺失：%s\n'
            '本脚本不内置任何连接信息，请先设置环境变量（示例）：\n'
            '  export ZENTAO_DB_HOST=<host> ZENTAO_DB_PORT=<port> \\\n'
            '         ZENTAO_DB_USER=<user> ZENTAO_DB_PASSWORD=<password>\n'
            'PowerShell:\n'
            '  $env:ZENTAO_DB_HOST="<host>"; $env:ZENTAO_DB_PORT="<port>"\n'
            '  $env:ZENTAO_DB_USER="<user>"; $env:ZENTAO_DB_PASSWORD="<password>"\n'
            % ', '.join(missing)
        )
        raise SystemExit(2)


def params(dict_cursor=False):
    """返回 pymysql.connect 的参数；dict_cursor=True 时带 DictCursor。"""
    require()
    options = dict(
        host=os.environ['ZENTAO_DB_HOST'],
        port=int(os.environ['ZENTAO_DB_PORT']),
        user=os.environ['ZENTAO_DB_USER'],
        password=os.environ['ZENTAO_DB_PASSWORD'],
        database=os.environ.get('ZENTAO_DB_NAME') or 'zentao',
        charset='utf8mb4',
    )
    if dict_cursor:
        import pymysql
        options['cursorclass'] = pymysql.cursors.DictCursor
    return options


def connect(dict_cursor=False):
    """直连并返回 connection。"""
    import pymysql
    return pymysql.connect(**params(dict_cursor=dict_cursor))


if __name__ == '__main__':
    require()
    print('ok: %s:%s/%s as %s' % (
        os.environ['ZENTAO_DB_HOST'],
        os.environ['ZENTAO_DB_PORT'],
        os.environ.get('ZENTAO_DB_NAME') or 'zentao',
        os.environ['ZENTAO_DB_USER'],
    ))
