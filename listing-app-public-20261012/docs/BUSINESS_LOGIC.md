# Listing App 业务逻辑说明

本文说明 Listing App 的业务对象、SOP 执行关系、证据语义和恢复策略。它是对程序行为的工程化概述，不替代组织内部获批的固定 Listing SOP，也不复制该 SOP 的完整规则文本。若程序实现与正式 SOP 冲突，正式 SOP 和显式 QA 合同优先。

## 1. 系统目标与边界

Listing App 将一个 SKU 从经验证的商品输入，逐步转换为可审阅的 Listing 内容包。系统以 SKU 为隔离单位，串联商品事实、市场关键词、竞品资料、AI 分析、文案生成、Stage QA 与最终内容检查。成功的终点是形成可追溯、可验收的内容包；上传、发布、ERP 提交和采购属于不同的外部业务动作，不能因为 Listing 流程完成而自动发生。

基本边界：

- **自有产品事实是唯一产品事实来源。** 竞品页面、竞品 API、Amazon 参考商品和 AI 推断都不能补写自有产品事实。
- **来源事实并列保存。** 页面值、API 值、SOP 业务分类分别处于独立数据层；冲突被保留并交给后续步骤处理，不静默覆盖。
- **步骤完成有严格含义。** Executor 返回、状态变为 `DONE` 或写出临时结果都不能代替 artifact 持久化和 Stage QA PASS。
- **运行环境必须隔离。** Acceptance 与 Production 使用不同端口、数据根、控制策略与运行身份；本公开快照不携带任何实际部署身份或访问凭据。

## 2. 核心业务对象

### SKU Task

一个任务代表一个 SKU 的 Listing 生命周期，至少有任务身份、当前步骤、最后成功步骤、恢复点、状态、修订号、输入/输出版本引用、QA 结果和错误/等待信息。任务修订号用于并发保护。修改状态或决策时应使用“读取当前 revision → 以 expected revision 写入”的 CAS 语义，避免旧页面或并发 Worker 覆盖较新的状态。

### Artifact / Version

每个 SOP 的正式输出是独立版本化 artifact。版本身份绑定 SKU、步骤、输入版本、输出内容及必要的执行元数据。后续 SOP 读取上游正式版本，而不是临时工作区文件、测试产物或“看起来最新”的同名文件。

### Evidence Reference

证据引用应能解析到具体 artifact、数据层和字段。仅仅在文本里找到一个引用字符串，不能证明证据存在。严格解析至少确认：artifact/version 存在、SKU 对应、layer 合法、字段路径真实可读、版本/哈希匹配且没有过期；任何一项不成立都应返回相应的缺失、无效、过期或版本不匹配状态。

### Execution Lease

Lease 将一个 SKU、步骤、输入版本和 execution 绑定到唯一 Worker。Acquire 必须原子执行。活跃且新鲜的 lease 阻止重复派发；stale lease 需要先确认 owner/heartbeat，再恢复。PASS、失败、等待、取消等终态必须释放或按协议转移 lease。重复 dispatcher 只记录抑制事件，不改变业务任务状态，也不重复调用 Provider。

## 3. SOP01–SOP17 业务流程

下表说明每一步在全链中的职责。具体字段、门槛、文案结构和固定 QA 以内部正式 SOP 及当前代码合同为准。

| 步骤 | 业务职责 | 主要输入 | 正式输出/放行条件 |
|---|---|---|---|
| SOP01 | 导入并识别本 SKU 的源表行，验证来源文件和商品身份，建立任务起点 | 被选中的 SKU 源行、导入来源 | 可追溯的任务/导入结果；不能混入其他 SKU |
| SOP02 | 建立自有商品事实记录，区分已确认、未知与存在冲突的字段 | 源工作簿和可信事实证据 | 版本化 Product Facts；未知值不得猜测 |
| SOP03 | 收集/整理市场搜索候选或来源发现数据 | 当前 SKU 事实、市场来源 | 候选词与来源引用；保留 exact string |
| SOP04 | 选择核心种子并获取相关/联想词，依事实相关性筛选 | SOP02 事实、SOP03 exact 候选、Search Terms 结果 | 合格 related terms 和决策来源；低于目标数时可按既定多 seed 规则继续，不用不相关词凑数 |
| SOP05 | 构造并整理关键词候选池 | SOP03/SOP04 候选和事实相关性 | 去重后的候选集合及分类依据 |
| SOP06 | 获取或复用精确词的市场搜索量 | exact strings、市场/语言/指标/日期身份、关键词库、Boloo 来源 | 每个词的正式数值或有效 ZERO_VALID；记录 HIT/MISS、查询来源与证据 |
| SOP07 | 根据本 SKU 输入形成正式 TOP20 市场词集合 | SOP06 量值、候选分类、SKU Facts | 保留 exact string 的 TOP20 版本及定性业务处理状态；不能用已废弃数值公式替代固定规则 |
| SOP08 | 评估现有竞品并在需要时顺序补充发现，形成正式竞品池 | 已有候选、页面/API/本地证据、SOP07 合法 discovery seeds | A/B/C 或未充分证明的分类、实际可用池、置信度和 Stage QA |
| SOP09 | 对正式竞品和参考商品做结构化深度分析 | SOP08 正式池、BOL PAGE/API Facts、Amazon Facts、SOP08 上下文 | 可追溯的竞品/评论证据分析；不提前做后续步骤的最终决策 |
| SOP10 | 提炼观察到的购买理由、卖点、痛点和竞品表现解释 | SOP09 深度证据 | 结构化 Buyer Insights 与证据引用 |
| SOP11 | 对比自有商品与竞品，逐项记录优势、持平、劣势或未知 | SOP02 自有事实、SOP09/SOP10 | Own-vs-competitor Comparison；不足以证明时使用 UNKNOWN |
| SOP12 | 将市场观察与自有事实组织成竞争卖点矩阵 | TOP20、SOP10、SOP11 | Selling Point Matrix；来源和自有/竞品身份清晰 |
| SOP13 | 对关键词和卖点作升权、保持、降权等定性展示处理 | SOP12 矩阵、TOP20 | Qualitative Display Weighting；禁止恢复已废弃的 60/40 或其他数学评分方案 |
| SOP14 | 按固定结构生成最终荷兰语标题 | 商品事实、卖点矩阵、关键词展示处理 | 标题与对应翻译、事实和证据引用；长度和结构由正式 QA 验收 |
| SOP15 | 形成固定数量的产品专属信息锚点及双语表达 | SOP02、SOP12–14 | 五个不同职责的锚点，NL/ZH 内容一一对应且只用确认事实 |
| SOP16 | 形成完整荷兰语描述、包装内容、属性和中文对照 | SOP02、SOP12–15 | 目标长度范围内的 NL 描述、包装/属性和完整 ZH 对照；未知属性不补写 |
| SOP17 | 对全链版本、证据、事实和最终买家文案执行终检 | SOP02、SOP07–16 版本及 QA 状态 | Final QA 报告；所有硬门禁通过后才标记正式 PASS |

### 阶段分工

- **SOP08 是竞品池建立阶段；SOP09 是深度分析阶段。** 两者互不替代。
- **SOP10–13 是分析与权重阶段。** SOP10 观察市场，SOP11 与自有事实比较，SOP12 汇总，SOP13 定性决定展示权重。
- **SOP14–16 是内容生成阶段。** 只允许将确认的自有事实写入买家可见内容；竞品用于有限的参考和表达分析，不是产品规格来源。
- **SOP17 是终检阶段。** 检查输入链、QA、STALE、开放业务错误、事实一致性、证据完整性和内容语义，不接受“跳过步骤后补 PASS”。

## 4. 关键词与搜索量逻辑

### Exact-string identity

关键词搜索量库保存客观市场观测，不保存 SKU 的业务判断。缓存身份至少包括：

- `keyword_exact`：原始精确字符串，空格、词序、单复数不同即视为不同词；
- `marketplace`：例如 BOL NL；
- `language`：例如 `nl-NL`；
- `metric`：被查询的具体搜索量指标；
- `query_date`：正式查询日期。

只有身份全部一致且是当前日期的有效记录，才可作为今日命中。过去日期的记录可作为历史参考，不自动冒充当天观测。市场或语言不同的记录相互隔离。

### 结果语义

- 正数值是可复用的搜索量事实。
- `ZERO_VALID` 表示查询成功且确认结果为零，是有效结果，可以缓存。
- `FAILED`、`BLOCKED`、超时或无响应只表示操作失败，不能被映射成零搜索量。
- 多 SKU 批次可以按 exact string 去重，共享的是搜索量事实；核心词/属性词分类、TOP20 顺序、SKU 相关性和 UP/HOLD/DOWN 决策仍按各 SKU 分开计算。

### Seed 与相关词

Seed 应来自已确认产品事实和正式候选 exact strings，优先选择最具体的核心商品本体词。属性、材质、场景、风格词不应抢先当作核心产品词。Search Terms 返回结果必须再经过产品事实相关性过滤；不相关结果不能为了达到数量而接受。第一 seed 的有效结果不足目标时，才能按既定顺序追加候选 seed，并在达到目标后停止。

## 5. 竞品与多源证据

### Existing 与 discovered 分流

已存在的候选商品先走 existing evaluation，不通过 Product List 重复发现。已有 URL 用于规范化、提取可识别商品 ID 并关联已有页面/API/本地证据；URL slug 不能被当成 Product List query。只有 existing evaluation 完成且可用竞品池不足时，才按 SOP07 的正搜索量核心商品词顺序进行 supplement discovery。新发现对象必须继续经过 relevance、去重、必要的 Placement 和候选分类，不能因为 Product List 返回就自动纳入正式池。

### 竞品分类与置信度

- `A_STRONG_EFFECTIVE`：具备支持强对标的充分证据。
- `B_REFERENCE`：产品直接可比或高度相似，但市场反馈证据不完整；可作有限参考，不等同 A。
- `C_WEAK_INVALID`：明确不相关、商品形态不符或有效证据显示不能作为直接比较对象。
- `UNQUALIFIED_INSUFFICIENT_EVIDENCE`：证据不足以证明直接可比；不计入可用池，也不要求人工裁定普通业务相关性。

可用主要竞品池按 A 加符合条件的 B 计算；C 与未充分证明对象不计入。候选耗尽后数量不足，应按实际池收口并标记低置信，不能硬凑数量。低置信上下文需进入后续分析，但不得让一个 B 级对象获得 A 级权重。

### 独立证据层

竞品 Evidence Bundle 分离保存：

1. `PAGE_FACTS`：网页实测内容、页面价格/图片/描述/规格、卖家、评论状态、时间和 DOM 证据引用。
2. `BOL_API_FACTS`：Offers、Ratings 等 API 响应事实及各自请求证据。
3. `SOP08_CONTEXT`：竞品类别、池置信度、SOP08 artifact 和方法上下文。

Amazon 参考资料另有页面事实与 SOP03 上下文。页面与 API 发生差异时并列保存来源与时间，不由采集层裁决。`NO_REVIEWS`、`AVAILABLE`、`UNKNOWN`、`PAGINATION_UNVERIFIED` 等状态具有不同语义；评分/评价数量不能冒充评论正文或评论全集。只有当前 SKU 的输入 context 含有某个价格地区/货币边界时，QA 才应用该边界，不把某个 SKU 的地区信息设成全局常量。

## 6. AI Router、Provider 与输出合同

常规 Listing 生成流程使用配置的主 Provider 组合（Qwen 与 DeepSeek）；GPT 是可选能力，不应因未配置 GPT 而阻塞正常流程。公开快照不包含任何 API Key、DPAPI blob 或运行时 Provider 配置。

### Provider 成功条件

Provider 的 HTTP 200 或返回 `completed` 本身不是成功。需要同时满足：

1. 返回内容真实且非空；
2. JSON/结构化解析成功；
3. 与该 SOP 的正式 schema 校验通过；
4. 结果通过业务 Stage QA 和 evidence/facts QA。

DeepSeek Listing 路径使用当前代码定义的 Responses Structured Output / JSON Schema 形式；Provider 来源、configured/requested/effective/returned model、协议、adapter、request trace、usage 和必要的推理设置应按真实返回记录。没有返回的元数据必须写明未报告，不得推断。

### Partial checkpoint

多 Provider 分别执行和落盘。对相同 SKU、SOP、输入版本、prompt/schema、模型和 adapter identity，已成功 Provider 结果可以作为 `CACHED_SUCCESS` 复用。Partial 不是正式 SOP artifact，不可单独触发 Stage QA PASS 或推进下一 SOP。某一 Provider 失败时，已成功 Provider 不应重复调用；任何相关身份变化都可能使缓存变为 stale。

### Failure barrier 与 circuit

Control-plane readiness（连通/身份层面可用）与 generation readiness（真实结构化生成能力）分离。生成超时、空内容、截断、无效 JSON/schema 或 transport failure 形成当前 generation identity 的 failure barrier。普通 health probe 不能解除该等待。重复失败达到阈值时 circuit 打开，停止自动业务派发；恢复需要失败之后、同 provider/model/协议/输入身份匹配的新 generation evidence，并且只授权对应恢复上下文。

HTTP 4xx、429、5xx 和无 HTTP 响应按不同错误类别处理；transport failure 不伪装成普通 HTTP status，确定性请求合同错误也不应被 readiness 自动重发。完整安全诊断保留状态、请求 trace、时间、有限脱敏响应信息与原始 adapter 分类。

## 7. 状态机、运行锁与恢复

任务状态表达业务执行状态，Provider readiness 表达能力状态，Runtime HOLD 表达运行策略；三者不能混为一谈。

- **RUNNING**：有实际步骤执行，应有有效 lease 和 heartbeat。
- **WAITING_DEPENDENCY**：当前步骤因其需要的外部能力或 Provider 依赖而暂停；应保留断点、输入版本、失败 barrier 和恢复条件。
- **PAUSED**：明确的操作性停点或 acceptance stop，不等同错误，也不等同人工业务决策。
- **ERROR**：只用于符合业务错误契约的真正失败；普通 provider/network dependency 不应误记为 SKU 业务错误。
- **`resume_point`**：明确指出后续接续步骤；步骤通过后在 acceptance stop gate 停止时，可以指向下一 SOP 或 `await_upload`。

所有 dispatcher 必须先判断是否有相同执行正在运行，再原子获取 lease。第二次并发请求只记录 `DUPLICATE_DISPATCH_SUPPRESSED`，不修改 SKU 的 step/status、恢复点或错误数，也不能再发 Provider 请求。

网络失败需要在失败时写入 `dependency_failed_at` 与 `required_readiness_after`。仅当该失败之后取得的新 readiness 满足时间与身份门禁时才允许恢复。带有已持久化本地证据的 SOP 可以分阶段执行：本地收敛不应无条件依赖远端 readiness；只有实际进入远端补充阶段，才检查相应 API readiness。

## 8. Stage QA 与 Final QA

Stage QA 是每个 SOP 正式写入的必要门禁。通用 QA 应读取当前 SKU context，包括 Facts 版本、竞品池置信度、评论范围、价格上下文、证据冲突、Provider provenance 和该 SKU 的未知项；不能把任何历史 SKU 的特征硬编码为全局 QA 条件。

常见硬检查：

- 所需 artifact、版本链和 evidence reference 均可读取且匹配当前 SKU；
- 所有必需输入和前置 Stage QA PASS；
- 结果 schema 与业务字段合同完整；
- 未确认事实没有进入买家可见文案；
- 竞品属性没有被写成自有属性；
- exact keyword strings 没有被擅自改写；
- 内容中的标题、锚点、描述和包装/属性语义一致；
- 不再使用已废弃的 SOP13 数值公式；
- 不存在 active lease、未完成子任务或未解决业务错误；
- 终检必须显式报告 findings，不能默认 PASS。

最终状态还需完成组织要求的内容质量检查、交付文件结构检查与视觉核验。是否进入上传动作是独立决策，不属于本流程的自动成功条件。

## 9. 输入数据保护与公开发布边界

内部运行依赖包括凭据、DPAPI 加密数据、Provider routing 配置、BOL API 配置、SQLite 数据库、网页证据、页面 DOM 引用、SKU Facts、工作簿、任务历史、运行日志、浏览器登录 Profile 和本机路径。这些数据不能放在公共仓库。

本次快照保留通用程序代码和脱敏后的文档，排除内部资料与固定 SOP 原文；在公开发布前还对验收 SKU 标识作了合成替换。该处理不是内部任务证据迁移，也不能用于重建真实商品或证明真实运行通过。

## 10. 关键术语

| 术语 | 含义 |
|---|---|
| `EXACT_STRING` | 精确保留字符形式的关键词；空格或词序不同即为不同查询身份 |
| `ZERO_VALID` | 查询成功且确认搜索量为零的有效市场结果 |
| `UNKNOWN` | 现有证据无法确定；不是默认值，也不是零值 |
| `NOT_AVAILABLE` | 当前正式数据源/接口不能提供该字段 |
| `CACHED_SUCCESS` | 与当前执行身份一致的 Provider 成功 partial 被复用 |
| `GENERATION_RECOVERY` | 满足特定 generation failure barrier、key、model、adapter 和时间门禁的窄范围恢复路由 |
| `LOW_COMPETITOR_POOL_CONFIDENCE` | 可比对象不足/证据有限的真实池状态，应由后续步骤继承 |
| `await_upload` | Listing 闭环完成后的非上传停点；不等于已发布或已提交 |