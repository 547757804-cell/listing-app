# INC-05｜SOP08候选收敛与耗尽终态

| 字段 | 内容 |
|---|---|
| 模块 | SOP08 existing evaluation / supplement discovery |
| 时间 | 多次历史讨论；原始event时间未公开 |
| 症状 | existing候选未完先做supplement；query不是串行；池不足但已耗尽被误报worker failure |
| 影响 | 不必要请求、重复候选、错误失败终态或无法人工推进的等待 |
| 根因机制 | 业务低置信终态和内部executor异常不能混淆。某次worker failure stack/return缺失，故该事件ROOT_CAUSE_UNVERIFIED |
| 修复合同 | existing全部complete后才计算usable pool；逐query去重/分类；候选耗尽且无pending时LOW_COMPETITOR_POOL_CONFIDENCE正常收口 |
| 代码 | app/bol_core.mjs编排调用；SOP08独立算法模块未包含在本公开whitelist |
| 测试 | 公开快照含本地mapping与optional candidates测试；完整exhaustion测试未全部公开 |
| 验证等级 | 部分源码合同可见；正式竞品池数据未发布 |
| 剩余风险 | 竞品合格阈值需与固定SOP版本一致，不能SKU特化 |
| 建议验收 | 每个existing候选有complete标志；每batch更新A+qualifiedB；达到门槛停止；耗尽不足时生成实际池和低置信理由 |
