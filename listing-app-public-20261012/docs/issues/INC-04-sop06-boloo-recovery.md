# INC-04｜SOP06 Boloo timeout、重复执行与checkpoint

| 字段 | 内容 |
|---|---|
| 模块 | Boloo WebView2 operation / SOP06 child task |
| 首末时间 | 历史多次讨论；原始DB时间未公开 |
| 症状 | timeout后pane恢复触发相同查询；显示数字与结构化值不匹配；child结果未稳定链接parent/library |
| 影响 | 外部请求重复、父任务不完成、数字记录错误或任务等待 |
| 根因 | 流程跨Pane operation、child、parent和library；若checkpoint非原子，会留下部分提交。所有历史故障是否同因无法证明 |
| 修复组件 | exact operation key/circuit、recovery evidence、数字规范化和checkpoint reconciliation |
| 代码 | app/listing_sop06_operation_circuit.mjs、app/boloo_volume_format.mjs、app/boloo_keyword_volume_library_runtime.mjs、app/bol_core.mjs |
| 测试 | SOP06 operation circuit、transactional resume、parent-child reconciliation |
| 验证等级 | 测试源码可见；本次未重放真实Boloo会话 |
| 剩余风险 | locale展示格式变化、Bridge在任务状态commit前退出 |
| 建议验收 | 已成功精确词不再查询；结果可链接parent/library；无lease child只经reconcile后重入队 |

WebProvider源码中默认operation timeout是配置值，不是实测耗时分布。
