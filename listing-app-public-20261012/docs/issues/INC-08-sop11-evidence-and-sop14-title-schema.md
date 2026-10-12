# INC-08｜SOP11引用与SOP14标题Schema

| 字段 | 内容 |
|---|---|
| 模块 | SOP11 evidence refs / SOP14 generated title |
| 首末时间 | 历史交接有记录；原始attempt/artifact不公开 |
| 症状 | SOP11两个Provider成功结果未形成正式artifact，因evidence-link QA失败；SOP14标题不符合长度Schema |
| 影响 | 阻断下游步骤并造成恢复工作 |
| 根因机制 | 错误/不存在的引用必须修到真实locked source或降级结论。当前Schema的title长度可确认；历史实际输出与计数器逐字符记录缺失，无法唯一归因 |
| 代码 | app/listing_evidence_resolver.mjs、app/listing_sop10_17_executor.mjs、app/listing_sop_json_schemas.mjs、app/sop14_title_contract.mjs |
| 测试证据 | Schema validator报告minLength/maxLength actual/expected；历史模型正文未公开 |
| 验证 | 合同源码可见；旧真实输出未复验 |
| 剩余风险 | 荷兰语自然度、字符计数语义、输出长度和模型预算需真实验证 |
| 建议 | 记录安全的trimmed字符数/Schema结果；人工审校自然表达；禁止堆关键词或放宽标准 |

禁止通过缩小固定长度、扩大Schema或直接略过QA来制造PASS。
