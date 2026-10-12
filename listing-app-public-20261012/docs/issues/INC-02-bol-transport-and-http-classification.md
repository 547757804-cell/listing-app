# INC-02｜BOL transport与HTTP错误分类

| 字段 | 内容 |
|---|---|
| 模块 | BOL Retailer Adapter / dependency state |
| 首末时间 | 历史讨论提及多次；原始attempt时间未公开 |
| 症状 | ECONNRESET、HTTP 415、404、429、5xx需采用不同恢复行为 |
| 影响 | 错误依赖等待、确定性请求自动重发、原始status/body丢失 |
| 根因 | 通用错误码不能说明是否收到HTTP response；某次历史请求的实际response情况为ROOT_CAUSE_UNVERIFIED |
| 修复合同 | 无HTTP响应→network wait；4xx→client/business错误；429→Retry-After；5xx→upstream wait且保留HTTP_5XX |
| 代码 | app/bol_retailer_client.mjs、app/bol_api_readiness.mjs、app/bol_core.mjs |
| 测试 | test/api_adapters.test.mjs；SOP08独立分类模块未完全公开 |
| 验证等级 | 离线分类实现可见；历史status/body不能从本仓库复原 |
| 复发风险 | 若adapter只保存mapped error，原始诊断字段会丢失 |
| 建议 | 保存method/endpoint/safe params/时间/error class/HTTP status/safe headers/body/request ID；transport失败明确status=null |

## 验收

注入no-response、415、429、500 fixtures。分别检查task分类、readiness不得重发确定性4xx、外部请求数为0。
