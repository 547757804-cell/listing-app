# 05｜关键词与 Boloo 系统

## 搜索量事实与 SKU 决策分离

搜索量是可按查询身份共享的客观事实。产品相关性、核心词/属性词分类、TOP20顺序、UP/HOLD/DOWN和其他业务权重不可共享。

## 精确查询身份

boloo_keyword_volume_library_runtime.mjs 的身份包括 keyword_exact、marketplace、language、metric、query_date。完全相同身份当日可返回 HIT_TODAY；历史结果为 HISTORY，不应冒充当日结果。空格、词序、单复数或拼写不同均是不同字符串。官方指标字段由实现中的荷兰语常量定义。

## 查库→MISS→记录流程

~~~mermaid
flowchart LR
  C[候选 exact strings] --> D[全批 exact 去重]
  D --> I[按市场/语言/指标/日期查库]
  I -->|HIT_TODAY| R[复用真实量与source ref]
  I -->|HISTORY| M[历史项，不冒充今日结果]
  I -->|MISS| B[Boloo查询]
  B --> V{结果状态}
  V -->|正值| P[PASS写库]
  V -->|零值有效| Z[ZERO_VALID写库]
  V -->|失败/阻塞| F[FAILED/BLOCKED不当搜索量]
  P --> S[分发至SKU独立决策]
  Z --> S
  R --> S
~~~

boloo_volume_library.mjs 可从已持久化来源构建快照，随后保存、加载和查询。历史记录只有市场/语言/指标/source identity完整时才可正式复用。

## SOP05–07

- SOP05 建立SKU专属候选池。
- SOP06 按exact string查询library，只有MISS进入实际Boloo operation。
- boloo_volume_format.mjs 负责展示值与结构化数值转换/一致性检查。
- listing_sop07_top20.mjs 生成正式TOP20并执行独立QA。

## 批量缓存隔离

多个SKU可合并同一exact query的“搜索量事实”请求并分发结果；相关性和排序各SKU独立。跨SKU结果必须保留独立SKU artifact及evidence refs。

## 故障与恢复

WebView2 Pane READY不等于查询完成。SOP06 child要有operation identity、response evidence和parent mapping。timeout后不能仅因pane恢复就重派；需要operation recovery evidence和circuit判断。

## 指标与限制

建议记录查询总数、HIT_TODAY、HISTORY、MISS、ZERO_VALID、实际Boloo调用、缓存节省调用数、每operation分阶段耗时、parse与parent mapping及recovery count。公开快照不含运行数据库，不能给出项目级命中率或平均耗时。

相关代码：boloo_keyword_volume_library_runtime.mjs、boloo_volume_library.mjs、boloo_volume_format.mjs、listing_sop06_operation_circuit.mjs、listing_sop06_boloo_bridge.mjs、boloo_web_provider.mjs。
