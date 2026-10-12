# INC-09｜Runtime身份/HOLD与Page Probe误判

| 字段 | 内容 |
|---|---|
| 模块 | Supervisor、Node、Watcher、WebView2 Bridge |
| 时间 | 历史多次报告提及；完整系统事件未取得 |
| 症状 | 旧PID/lock看似健康但服务不可用；health与HOLD策略冲突；页面可见但Page Read或evidence失败 |
| 影响 | 重启循环、错误resume、误报页面采集成功 |
| 根因机制 | PID、lock、heartbeat或HTTP200单独不足以证明正确进程/dataRoot/build与operation结果。具体Supervisor退出根因ROOT_CAUSE_UNVERIFIED |
| 代码 | infra/acceptance_runtime_supervisor.ps1、infra/runtime_health_core.ps1、app/runtime_mode.mjs、ui_shell/page probe源 |
| 验证 | effective policy/page contract可见；本次没有Windows真实进程snapshot |
| 剩余风险 | Session差异、PID复用、localhost proxy、WebView2 profile竞争 |
| 建议 | health绑定PID/启动时间/marker/dataRoot/build hash；页面QA验证identity、字段、DOM refs和持久化 |

页面显示、Pane READY和Bridge heartbeat不能替代单次Page Read与immutable evidence。
