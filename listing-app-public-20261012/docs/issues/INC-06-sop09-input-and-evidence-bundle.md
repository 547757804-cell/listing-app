# INC-06｜SOP09 Input Bundle与证据分层

| 字段 | 内容 |
|---|---|
| 模块 | SOP09 executor input loader |
| 首末时间 | 历史任务提到Input Bundle缺失；准确首末时间未知 |
| 症状 | SOP09缺正式bundle/version refs，或引用路径实际不存在 |
| 影响 | 无法安全执行、Stage QA失败、可能重复抓取已保存数据 |
| 根因机制 | runtime需要从dataRoot读取正式SOP08、BOL、Amazon和Facts版本；引用字符串本身不够。某次历史文件丢失原因未核验 |
| 代码 | app/listing_competitor_analysis_executor.mjs、app/sop09_bol_data_source.mjs、app/sop09_amazon_data_source.mjs |
| 验证 | resolveSop09RuntimeInputs、expected version和QA可在源码确认；真实SKU bundle不公开 |
| 剩余风险 | artifact迁移、identity错配、review scope/币种语义混淆 |
| 建议验收 | bundle逐项记录exists/version/SHA/identity；缺项明确WAITING/BLOCKED，禁止隐式联网 |

PAGE_FACTS、BOL_API_FACTS和SOP08_CONTEXT互不覆盖；Amazon页面facts也不能冒充SOP03本地候选context。
