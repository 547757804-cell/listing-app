# 公开快照范围

## 已纳入

- BOL Listing 核心 Node.js ES module 源码。
- 适用于 BOL 的 UI、页面采集壳源代码和离线测试源码。
- Acceptance Runtime、Supervisor、健康检查与恢复相关脚本源码。
- 现有离线合同测试源码。
- `docs/BUSINESS_LOGIC.md` 业务逻辑说明。

## 明确排除

- `.env`、API Key、令牌、DPAPI 密文、Provider 配置和网络代理配置。
- SQLite 数据库/WAL、任务状态、输入工作簿、商品 Facts、SKU/evidence artifacts、浏览器 Profile、HTTP 日志和运行报告。
- 固定 SOP Word 文档、模板 Excel、公开前的源工作簿及其他业务文件。
- `legacy_external_project` 历史项目、其他项目客户端与数据。
- `_runtime` 下 Node/WebView2 二进制、UI `bin` 目录中的 exe/dll/pdb、安装包和构建产物。
- 本地凭据导入/导出界面与一次性 Qwen/DeepSeek 真实探针脚本。

## 脱敏方式

- 原代码中的历史 acceptance SKU/product 标识被替换成合成标识，以避免将真实 SKU 和商品识别号放进公开仓库。
- 这是一份公开发布副本；原始内部工作目录没有修改。
- 文件名、目录名和代码结构只为便于浏览，不表示发布包包含了内部运行所需的数据库、配置和外部授权。

## 限制

该仓库暂不包含许可证。源码公开可见不等于授予开源许可。运行、生产使用或再分发所需的服务账号、Provider 凭据和商品数据均由使用者按其自身授权另行提供。