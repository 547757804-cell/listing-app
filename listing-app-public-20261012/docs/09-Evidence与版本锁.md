# 09｜Evidence 与版本锁

## 概念

- Source evidence：API字段、页面DOM/截图引用、工作簿单元格或商品文件。
- PAGE_FACTS / API_FACTS：按来源分层规范化的字段及其原始状态。
- Bundle：把独立层按身份和版本汇总供后续消费；bundle本身不裁决冲突。
- SOP artifact：执行器产物，引用输入versions/SHA和结论证据refs。
- Evidence Resolver：验证引用能否到达真实artifact、layer及具体field/pointer。
- Input version lock：执行时锁定上游version、reference和SHA。

~~~mermaid
flowchart LR
  S[Source evidence] --> L[PAGE_FACTS / API_FACTS]
  L --> B[Versioned evidence bundle]
  B --> I[Executor input version lock]
  I --> R[Strict Evidence Resolver]
  R -->|artifact + layer + pointer + version/SHA valid| V[Readable evidence]
  R -->|missing / stale / mismatch| X[Reject or mark unavailable]
  V --> A[Formal SOP artifact with refs]
~~~

Resolver必须实际读取artifact与pointer；引用字符串本身不能产生`EXISTS`。

## 严格解析

listing_evidence_resolver.mjs公开版本为V2。解析应确认artifact/manifest真实存在、SKU/dataRoot正确、layer合法、pointer可读、version/SHA匹配并检查stale。状态包括EXISTS、MISSING、INVALID_LAYER、STALE、VERSION_MISMATCH、MALFORMED_REF等。字符串命中、相似路径、正文中出现ID或placeholder不能证明证据存在。

## SOP09输入包

listing_competitor_analysis_executor.mjs根据task、expected versions和dataRoot加载正式输入。version不匹配会拒绝。引用必须位于dataRoot内。SOP09 input bundle通常组合SOP08 pool、Product Facts/关键词输入、BOL Page/API Bundle、Amazon Page Bundle及各自refs。完整清单应按当前SKU合同读取，不能照搬其他SKU的身份或边界。

## 分层与冲突

PAGE_FACTS、BOL_API_FACTS、SOP08_CONTEXT、SOP03_LOCAL_SOURCE、Amazon PAGE_FACTS、Amazon本地context互不覆写。原始source conflict并列保存；后续分析不能无证据裁决。

## Manifest

建议包含artifact type/version、时间、输入版本refs、SHA256、evidence refs和执行合同/Provider provenance。若原artifact缺失、hash不符或只剩旧字符串，resolver应标缺失/无法验证，不能自动寻找相似文件。

## 历史兼容

Legacy alias仅可在old→replacement有manifest/event/hash严谨证据时建立，且最终仍要解析至真实artifact。新旧步骤名字相似不是兼容证据。

交叉引用：[07-AI模型调度系统](07-AI模型调度系统.md)、[10-状态机及QA系统](10-状态机及QA系统.md)、[19-历史故障与根因总表](19-历史故障与根因总表.md)。
