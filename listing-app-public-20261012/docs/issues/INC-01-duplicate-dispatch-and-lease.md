# INC-01｜Duplicate dispatch与执行租约

| 字段 | 内容 |
|---|---|
| 模块 | Listing executor / SQLite lease |
| 首次发现 | 历史任务记录提及；精确时间未由原始event log核验 |
| 最后出现 | 原始数据库未纳入公开包，最后一次出现未知 |
| 影响 | 可能重复外部请求、并发写SKU状态、执行进度不确定 |
| 根因 | 风险机制是未在相同SKU+step+input identity下原子互斥。历史是否实际存在两个worker为ROOT_CAUSE_UNVERIFIED |
| 修复 | lease记录owner、execution、started/heartbeat/state；同identity第二次dispatch抑制，只写审计 |
| 代码 | app/listing_execution_lease.mjs；app/bol_core.mjs |
| 测试证据 | 离线not-dispatched/lease合同存在；公开发布前未跑完整并发压测 |
| 验证等级 | 源码机制可见；历史REAL_PASS未独立复核 |
| 复发关系 | 与SOP06重复operation和AI retry风暴有关联，但是否同根因未证 |
| 剩余风险 | heartbeat阈值、PID复用、SQLite争用、lease close失败 |
| 建议验收 | 同key并发仅一条RUNNING lease；其余请求不改task、不发外部请求；重启恢复不产生并发worker |

## 复现

在临时SQLite库并发acquire同一SKU、step、input version。断言仅一方取得lease；另一方返回suppressed，task revision/status/step/resume_point不变。
