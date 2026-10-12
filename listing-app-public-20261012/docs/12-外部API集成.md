# 12｜外部 API 集成

## BOL Retailer API

bol_retailer_client.mjs实现AdapterError、凭据读取入口、client调用和相关商品业务函数；bol_api_readiness.mjs进行readiness检查。正式错误应保留method、endpoint、safe params、request ID、started/finished、error class/code、transport code、HTTP status、safe response headers/body、adapter message和mapped business error。

错误分类必须看真实response_received与status：

- 无HTTP response：网络/TLS/timeout/transport等待，status=null。
- 4xx：确定性客户端/业务请求问题，不得伪装network waiting。
- 429：rate limit，遵循Retry-After。
- 5xx：上游服务错误，保留HTTP_5XX语义。

健康探针PASS不保证后续业务请求成功。

## Product List、Placement、Offers、Ratings

不同endpoint的业务能力和错误映射不同，不能把一个endpoint的header或request格式补丁推广到其他endpoint。Offers可用于其接口公开的offers字段，Ratings用于其返回的rating统计；二者不提供用户评论正文、真实销量或购买理由。Product List提供搜索发现候选，不等于正式竞品；Placement是商品投放/分类能力，not found不能自动等同于SOP08竞品池失败。

## Boloo

集成方式含WebProvider/Bridge与MCP client。关键词library缓存搜索量客观事实。查询结果需要对照网页展示值并解析数值；ZERO_VALID和异常状态分开保存。

## Amazon页面/Keepa

页面探针与API数据是不同来源。Amazon页面可能随登录、配送地址、币种、个性化页面变化。Amazon.de商品主页面证据需验证ASIN identity；非目标配送地区/非本地币种上下文不能用于目标市场本地价格比较。评论样本和全量评论状态要分开。

当前公开快照未包含完整Keepa client/密钥/真实结果；不能据此宣称Keepa端到端能力已验证。

## 连接诊断

区分DNS、proxy TCP、HTTP CONNECT、TLS、发送完成、等待响应首字节、HTTP status、JSON解析和业务schema。localhost健康检查要绕过代理；远端路径需记录实际Transport与代理是否生效。

## 隐私和日志

绝不记录Authorization、cookie、API key、完整请求prompt、页面session或未经审查的response body。错误正文须限长并做敏感字段清理。
