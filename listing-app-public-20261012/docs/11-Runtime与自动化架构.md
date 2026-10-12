# 11｜Runtime 与自动化架构

## 运行组成

公开源快照含本地 Node Server、PowerShell Supervisor、health/preflight脚本、桌面壳与页面Bridge。目标是隔离的acceptance runtime，Server通过环境识别模式、端口、dataRoot和HOLD。仓库不含真实环境配置或已编译产物。

~~~mermaid
flowchart LR
  SUP[Supervisor] -->|启动/身份核验| NODE[Node Server]
  WATCH[Watcher/Health loop] -->|HTTP health| NODE
  NODE --> POLICY[Effective Runtime Policy]
  NODE --> ROOT[dataRoot / marker]
  NODE --> DB[(SQLite)]
  NODE --> BRIDGE[WebView2 Bridge]
  BRIDGE --> BROWSER[页面探针/WebView2]
  SUP -->|仅确认身份后重启/收尾| NODE
~~~

图表示组件职责关系，不证明某次运行中Supervisor/Watcher仍在运行。

## Runtime身份

健康核验需要将以下信息相互对上：实际进程PID/启动时间、命令行或身份marker、监听端口、HTTP health响应、runtime模式、acceptance标志、dataRoot和lock owner。PID文件或旧Runtime Lock本身不是进程存在证明。HTTP 200不必然说明进程加载了目标新代码，需结合启动时间/build marker。

## Effective Policy

runtime_mode.mjs集中计算runtime policy；HOLD=true应禁止dispatch、自动dependency resume和task auto-mutation。health与Supervisor必须读取同一个effective policy，避免原始环境设置与缓存状态矛盾。任何身份或策略不一致应fail closed。

## Windows与桌面会话

PowerShell/Node进程的用户、session和交互桌面影响WebView2目标窗口。无窗口handle、另一Session中的窗口或Bridge inbox/outbox不一致时，服务可能正常而页面读数不可用。公开快照不含可验证的当前Windows session状态。

## WebView2/Bridge

Bridge request需有request id、operation、响应路径、超时和operation evidence。Pane READY/心跳仅代表基础连接；Page Read成功还需URL/identity匹配、DOM数据可读、字段状态与evidence refs持久化。页面展示出来不代表字段可追溯。

## 进程恢复建议

受控流程：HOLD → 检查无active lease → 核实锁与实际进程身份 → 读取最新source/build → 有界重启 → 直连health并核对dataRoot/marker/version → 本地preflight → 仅由明确Continue开始业务。不要仅按旧PID杀进程或因health旧快照重复重启。

## 相关代码

infra/acceptance_runtime_supervisor.ps1、infra/runtime_health_core.ps1、infra/runtime_preflight.ps1、infra/start_bol_acceptance.ps1、infra/recover_bol.ps1、app/runtime_mode.mjs、app/bol_server.mjs。
