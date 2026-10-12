# INC-03｜SOP04 seed和关联词收敛

| 字段 | 内容 |
|---|---|
| 模块 | SOP04 |
| 首末时间 | SKU运行原始事件不完整，精确时间未知 |
| 症状 | 搜索同词返回不同商品方向；关联词不足后进入人工等待或凑词 |
| 影响 | 搜索方向偏离Facts、exact query被改写、阶段停滞 |
| 根因机制 | 平台同词结果不代表与自有Facts相关；seed必须基于确认事实和SOP03 exact候选 |
| 修复 | seed selector依据Facts选核心本体词；多seed串行补齐，只接收相关exact strings |
| 代码 | app/listing_sop04_seed_selector.mjs、app/listing_sop04_related_terms.mjs、app/bol_core.mjs |
| 测试 | 当前快照含策略模块；没有公开展示所有SOP04运行case |
| 验证等级 | 代码可见；真实SKU完整query结果未随仓库 |
| 剩余风险 | 多义词和搜索引擎排序变化 |
| 建议验收 | 保存seed选择理由、adopt/reject evidence；不可翻译、改写或自行造词 |

错误假设：搜索平台返回的同词候选都与SKU相关；必须用任意词凑到目标数。
