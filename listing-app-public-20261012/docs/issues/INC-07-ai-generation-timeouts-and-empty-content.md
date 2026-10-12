# INC-07｜AI timeout、空内容与恢复风暴

| 字段 | 内容 |
|---|---|
| 模块 | AI Adapter / Router / generation recovery |
| 首末时间 | 多批历史失败摘要；完整attempt ledger未公开 |
| 症状 | 长业务调用timeout、HTTP200但content为空/截断/Schema失败，及历史同key重复调用 |
| 影响 | 费用和时间增加、成功provider结果重复调用、没有正式artifact仍持续恢复 |
| 根因机制 | failure taxonomy必须将empty/truncated/JSON/schema纳入generation failure；历史重复dispatch具体绕行路径缺原始event，仍未独立确认 |
| 修复组件 | identity barrier、partial cache、Circuit、generation readiness及model provenance |
| 代码 | app/ai_generation_recovery.mjs、app/ai_router.mjs、app/ai_provider_adapters.mjs |
| 测试 | AI dependency gate、not-dispatched、attempt telemetry、Qwen recovery test |
| 验证 | 离线测试源码可见；本次未调用真实Provider |
| 剩余风险 | Provider响应协议会变，model/config/adapter hash变更后需拒绝旧probe |
| 建议 | 分开统计transport retry/provider attempt/SOP retry；持久化partial；持久化OPEN circuit |

历史摘要提及若干空内容调用和能力探针；来源为不同任务快照，是否重叠未知，因此不求和。
