# 历史问题档案索引

本档案按匿名化问题簇组织。精确首末时间、attempt ID、原始HTTP body和完整执行日志未随公开仓库发布；缺失这些证据时相应字段标为UNKNOWN/ROOT_CAUSE_UNVERIFIED。每个档案区分代码合同、离线验证与真实业务验证。

| ID | 标题 | 详细档案 | 根因可信度 |
|---|---|---|---|
| INC-01 | Duplicate dispatch与原子execution lease | [阅读](INC-01-duplicate-dispatch-and-lease.md) | 防护机制可见；历史worker数未验证 |
| INC-02 | BOL transport/HTTP分类 | [阅读](INC-02-bol-transport-and-http-classification.md) | 分类合同可见；个别历史response未知 |
| INC-03 | SOP04 seed/关联词 | [阅读](INC-03-sop04-seed-and-related-terms.md) | 策略代码存在；历史运行不完整 |
| INC-04 | SOP06 Boloo恢复 | [阅读](INC-04-sop06-boloo-recovery.md) | 修复合同可见；各历史故障同根因未证 |
| INC-05 | SOP08补充发现/耗尽收口 | [阅读](INC-05-sop08-competitor-pool-exhaustion.md) | 特定worker crash根因未知 |
| INC-06 | SOP09输入bundle/证据分层 | [阅读](INC-06-sop09-input-and-evidence-bundle.md) | loader可见；真实SKU输入未公开 |
| INC-07 | SOP10 AI timeout/empty content | [阅读](INC-07-ai-generation-timeouts-and-empty-content.md) | 状态机可见；完整历史ledger缺失 |
| INC-08 | SOP11证据引用/SOP14标题Schema | [阅读](INC-08-sop11-evidence-and-sop14-title-schema.md) | 合同可见；历史输出未公开 |
| INC-09 | Runtime身份/HOLD/Page Probe | [阅读](INC-09-runtime-identity-and-page-probe.md) | 历史系统故障ROOT_CAUSE_UNVERIFIED |
| INC-10 | Resolver假阳性/通用QA泄漏 | [阅读](INC-10-evidence-resolver-and-generic-qa.md) | 代码合同可见；本次未重跑真实旧数据 |

## 验证术语

- CONFIRMED_MECHANISM：源代码或明确evidence证明机制。
- OFFLINE_PASS：隔离测试通过，不代表真实Provider或SKU PASS。
- REAL_PASS：真实输入、正式runtime、正式artifact和Stage QA都有可追溯证据时才使用。
- ROOT_CAUSE_UNVERIFIED：缺少足以确认根因的原始日志/请求/进程证据。

详细字段和跨故障关系见 [主历史故障总表](../19-历史故障与根因总表.md)。原始日志和数据库没有随包发布，因此此索引不是完整审计导出。
