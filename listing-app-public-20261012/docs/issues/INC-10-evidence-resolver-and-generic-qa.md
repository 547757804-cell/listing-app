# INC-10｜Evidence Resolver假阳性与SKU专属QA泄漏

| 字段 | 内容 |
|---|---|
| 模块 | Listing Evidence Resolver / generic QA |
| 首末时间 | 历史安全复核中发现；原始事件时间未重新核验 |
| 症状 | 仅reference字符串可能被视作EXISTS；一个SKU特定条件可能影响其他SKU |
| 影响 | 没有真实证据却误PASS，或无关SKU被错误FAIL |
| 根因机制 | 字符串存在不等于artifact/layer/pointer存在；SKU特殊参数不等于CURRENT_SKU_CONTEXT |
| 修复 | Resolver V2解析真实artifact/layer/pointer/hash/stale；QA读取当前SKU context |
| 代码 | app/listing_evidence_resolver.mjs、app/listing_competitor_analysis_executor.mjs、app/listing_sop10_17_executor.mjs |
| 测试 | listing_sop09_generic_context.test.mjs及evidence/review-scope tests |
| 验证 | 源码与测试合同可见；本次未重跑历史数据库QA |
| 剩余风险 | Legacy alias可能因manifest不足重新引入假阳性 |
| 建议 | 3-SKU synthetic regression、跨SKU拒绝、SHA验真；缺失证据返回MISSING/UNKNOWN |

任何兼容层都不能降低strict resolver；无法证明历史source就标LEGACY_EVIDENCE_UNVERIFIABLE。
