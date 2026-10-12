# Listing App

面向 BOL 商品 Listing 研究与内容生产的工作台源码快照。系统围绕商品事实、市场关键词、竞品证据、结构化分析、Listing 生成和逐阶段 QA 组织工作流。

> 这是从内部项目筛选、脱敏后的公开源码快照。运行配置、密钥、数据库、真实 SKU 记录、商品证据、固定 SOP 原文、验收日志、用户数据和编译产物均不包含在仓库中。源代码中的历史验收标识已替换为合成标识。没有附带开源许可证；公开展示不授予复制、修改或再分发许可。

## 目录

- app：任务状态、BOL API 与页面来源、关键词库、AI 路由、证据解析、执行器和 QA。
- scripts：基于已持久化证据构建/规范化 SOP 输入包的工具。
- infra：隔离验收 Runtime、Supervisor、健康检查、备份和网络诊断脚本。
- ui_shell：工作台及 BOL/Amazon 页面采集壳源代码；不含二进制依赖与浏览器 Profile。
- test：离线合同、状态机、证据和运行策略测试。
- docs：业务逻辑、系统设计、SOP、历史故障、性能瓶颈和开发路线。

## 核心原则

1. 每一步以正式 artifact、输入版本和 Stage QA 形成可追溯链；仅有 DONE 不代表 PASS。
2. 未确认的商品事实保持 UNKNOWN，竞品事实不能写成自有事实。
3. 证据引用必须能够解析到真实 artifact、真实数据层和真实字段。
4. 搜索量事实可按精确词共享；SKU相关性、关键词排序和业务权重各 SKU 独立。
5. AI Provider 成功结果可作为恢复中间 checkpoint，但不能替代正式 SOP artifact 或 Stage QA。
6. Acceptance Runtime 与 Production Runtime 必须隔离；本仓库不含真实部署配置或密钥。

## 文档索引

### 业务流程和规则

- [02｜完整业务流程](docs/02-完整业务流程.md)
- [03｜Listing SOP01–17详解](docs/03-Listing-SOP01-17完整详解.md)
- [04｜独立竞品调研系统](docs/04-独立竞品调研系统.md)
- [05｜关键词与Boloo系统](docs/05-关键词与Boloo系统.md)
- [06｜竞品分析业务逻辑](docs/06-竞品分析业务逻辑.md)

### 架构和执行机制

- [01｜系统总体架构](docs/01-系统总体架构.md)
- [07｜AI模型调度](docs/07-AI模型调度系统.md)
- [08｜数据库和数据结构](docs/08-数据库和数据结构.md)
- [09｜Evidence与版本锁](docs/09-Evidence与版本锁.md)
- [10｜状态机与QA](docs/10-状态机及QA系统.md)
- [11｜Runtime与自动化](docs/11-Runtime与自动化架构.md)
- [12｜外部API集成](docs/12-外部API集成.md)
- [13｜Excel与ERP输出](docs/13-Excel与ERP输出.md)
- [14｜异常处理和恢复](docs/14-异常处理和恢复机制.md)
- [15｜本地安装部署](docs/15-本地安装部署指南.md)
- [17｜开发协作](docs/17-开发协作指南.md)

### 历史复盘、性能与路线

- [16｜开发进度和验收状态](docs/16-当前开发进度和验收状态.md)
- [18｜卡顿、超时与性能瓶颈](docs/18-卡顿超时与性能瓶颈深度分析.md)
- [19｜历史故障与根因总表](docs/19-历史故障与根因总表.md)
- [独立问题档案索引](docs/issues/README.md)
- [20｜重复踩坑与错误假设](docs/20-重复踩坑与错误假设.md)
- [21｜技术债务及重构建议](docs/21-技术债务及重构建议.md)
- [22｜下一阶段开发路线图](docs/22-下一阶段开发路线图.md)
- [业务逻辑总览](docs/BUSINESS_LOGIC.md)
- [公开快照范围](docs/PUBLICATION_SCOPE.md)

## 运行说明

此快照不含运行所需的数据根、DPAPI凭据、Provider配置、浏览器登录Profile或生产级配置。部署者必须依据组织授权配置依赖；不要将密钥、数据库或商品证据提交到仓库。

源码以 Node.js ES modules、PowerShell 和 C# 为主。离线测试使用 Node.js 内置测试运行器；请在隔离测试数据根执行，禁止连接真实Provider、BOL/Amazon或生产Runtime。当前快照不包含完整package manifest/lockfile和全部私有SOP源文件，因此不能视为一键可运行部署包。

## 证据与验证等级

- REAL_PASS：正式输入、目标运行环境、正式artifact和Stage QA均可追溯。
- OFFLINE_PASS：指定离线fixture/test通过，不代表真实Provider或SKU通过。
- UNVERIFIED：缺少当前有效证据。
- BLOCKED：已确认阻塞且未完成目标门禁。

公开副本不携带内部运行数据库和原始日志；历史技术档案会明确将证据不足的根因标为 ROOT_CAUSE_UNVERIFIED。

## 发布边界

公开副本排除.env、Provider配置、Cookie、OAuth凭据、SQLite、任务artifact、运行日志、模板Excel、固定SOP Word原文、其他项目历史代码和编译二进制。部分一次性Provider探针、凭据导入入口、在线E2E测试、SKU专用启动工具也未发布。仓库只包含部分SOP08相关源码；固定SOP/模板原文及部分内部模块不在当前快照中，详见公开范围说明。

没有LICENSE文件。公开可浏览不代表授权复制、修改、商业使用或再分发。
