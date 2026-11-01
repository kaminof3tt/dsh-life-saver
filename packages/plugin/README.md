# dsh-life-saver

DeepSeek Harness 原生插件：把禅道的需求 / 任务 / BUG 直接变成 Agent 能读的内容
（正文、备注、操作记录、附件实体、关联需求），也能反过来写（开始/完成/暂停任务、
记工时、解决/关闭 BUG、加备注），并统计某人任意区间的工时。

七件工具：`zentao_read`、`zentao_search`、`zentao_status`、`zentao_workhours`、
`zentao_task_op`、`zentao_bug_op`、`zentao_session_start`。

取数与写入逻辑在 [`life-saver-core`](https://www.npmjs.com/package/life-saver-core)；
本包只做宿主接线（cordis 入口、工具注册、`/api/dsh-life-saver/*` 桥接路由、设置页）。

完整文档（安装、两条通道、写入护栏、配置项、测试清单）在仓库根目录：
<https://github.com/kaminof3tt/dsh-life-saver#readme>

## 许可

MIT
