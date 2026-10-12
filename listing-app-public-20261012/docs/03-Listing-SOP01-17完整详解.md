# 03｜Listing SOP01–17 完整详解

## 依据与限制

编号、标签和输出类型取自 app/bol_core.mjs 的 LISTING_SOP_STEPS。细节来自当前公开源文件、执行器名称与 Schema；固定 SOP 原文未公开，因此没有把源代码外推成完整规则。每一步真实运行状态须读取 task artifact/event，本文件不推断任何当前 SKU 状态。

## 步骤总览

| Step | 代码标签 | 主要输入 | 目标输出 | 主要门禁 |
|---|---|---|---|---|
| 01 | 读取自有资料 | SKU 源资料 | product_master_snapshot | 来源可追溯、字段可解析 |
| 02 | 确认真实产品事实 | Master、图片/文件/来源证据 | product_fact_confirmation | 未确认信息保持 UNKNOWN |
| 03 | BOL/Amazon/Boloo 竞品关键词挖掘 | Facts、候选源 | keyword_source_discovery | 自有本地来源与竞品数据分层 |
| 04 | 验证 5–7 个 BOL 关联/联想词 | SOP02 Facts、SOP03 exact terms | bol_keywords | 相关性、exact string 不变 |
| 05 | 建候选池并筛约20个精确字符串 | SOP03/SOP04 词源、Facts | keyword_candidate_pool | 每个 SKU 独立相关性与顺序 |
| 06 | 逐词查 Boloo 月均搜索量 | exact strings、keyword library | boloo_keywords | exact identity；ZERO_VALID有效；失败不伪装 |
| 07 | 形成正式 TOP20 | 候选及真实 volume | top20 | 不编造 volume；SKU权重独立 |
| 08 | 建立有效竞品池 | existing 候选与证据 | listing_competitor_pool | existing 完成后算池；补充按序收敛 |
| 09 | 深度分析竞品与评论 | SOP08 pool、BOL/Amazon bundles | listing_competitor_analysis | 来源语义与置信边界保留 |
| 10 | 买家洞察 | SOP09 结构化证据 | buyer_insights | 结论带 evidence refs/confidence |
| 11 | 我方与竞品对照 | SOP02 Facts、SOP09、SOP10 | own_competitor_comparison | UNKNOWN可用；不足证据不臆断 |
| 12 | 竞争卖点矩阵 | SOP10/SOP11/关键词证据 | selling_matrix | 来源引用可解析 |
| 13 | 展示权重 | TOP20及前序分析 | display_weighting | 固定决策类别；禁废弃评分字段 |
| 14 | 最终标题 | Facts、关键词、分析结果 | title | title_nl Schema 230–260字符 |
| 15 | 五个产品专属信息锚点 | Facts、标题、矩阵 | anchors | 五条且事实专属 |
| 16 | 描述/包装/属性/中文 | Facts、锚点、关键词 | description | 荷兰语描述 Schema 2500–2800字符 |
| 17 | 最终 QA 并交给表格填充 | 全链 artifact 与 QA | final_qa | 版本、Facts、引用、语义和错误检查 |

## SOP01–02：输入与事实基线

SOP01 负责读入来源；excel_source_adapter.mjs 将工作簿行解析为结构化报告和来源字段。SOP02 是事实确认边界；后续生成从 SOP02 锁定输入读取，而不是把模型输出当作事实来源。UNKNOWN需保持未确认，图片或文本推测不能自动升级为产品事实。

## SOP03–07：词源、搜索量与 TOP20

SOP03 可组合产品事实、竞品来源、BOL词源、Amazon本地来源候选和Boloo发现候选。实现明确将 Amazon local source 输出为 candidate-only，不得当自有事实。SOP04 seed selector 基于已确认 Facts；词筛选应保留字符串。SOP05 建 SKU 专属候选池；SOP06 先查 keyword library，MISS才进入 Boloo；SOP07 用独立 builder/QA 形成正式 TOP20。

## SOP08–09：竞品池与深度证据

SOP08 代码编排调用既有候选评估、去重、局部 evidence mapper、分类和补充计划。市场未知字段不能猜价格、销量、评分或近期活跃。SOP09 executor 从锁定版本读取输入，产出分层分析、evidence refs、source completeness、conflicts、unavailable fields和confidence，并核对manifest/SHA/ref。

## SOP10–13：分析组

- SOP10输出观测到的卖点、痛点、购买原因和可能原因，带 evidence/confidence；不生成自有事实。
- SOP11比较自有与竞品事实，支持 advantage/equal/disadvantage/unknown；结论引用由resolver验证。
- SOP12建立竞争卖点矩阵；若来源引用错位，只能修正到真实来源或降级结论，不得造路径。
- SOP13按固定规则做展示权重决定；代码含废弃分数键检查，不能恢复旧数学评分体系。

## SOP14–16：生成组

当前 Schema 明确规定 title_nl 为230–260字符、description_nl为2500–2800字符。这是代码约束，不表示真实生成每次达标。SOP14 prompt与Schema必须一致；不达长度时应失败/受控修订，不可堆词。SOP15产生5个产品专属锚点。SOP16组合事实、包装、属性和双语输出；UNKNOWN不应进入买家可见文案。

## SOP17：Final QA

执行器构造 deterministic evidence pack 并要求语义QA字段。QA应以锁定Facts、版本和真实 refs 检查内容，不以模型自报PASS为准。Final QA不代表上传已获批准。

## 版本与恢复

输入携带version/reference/SHA，产物有artifact version；上游变化会影响stale。AI partial是单Provider checkpoint，不是正式SOP artifact；只在完全匹配SKU、step、输入、provider、model、prompt/schema和adapter identity时可复用。

公开副本没有内部原始数据库、完整任务事件和原文SOP。历史案例见 [19](19-历史故障与根因总表.md)，请结合各项验证等级阅读。
