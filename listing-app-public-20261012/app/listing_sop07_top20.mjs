import crypto from 'node:crypto';

const forbiddenKeys = new Set(['volume_score', 'relevance_score', 'final_score', 'final_keyword_score', 'log_normalization']);

function collectForbiddenKeys(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) found.push(key);
    collectForbiddenKeys(child, found);
  }
  return found;
}

function failure(code, message) {
  return { code, message, pass: false };
}

function pass(code, message) {
  return { code, message, pass: true };
}

/** Build the deterministic SOP07 output from already sealed SOP05/SOP06 artifacts. */
export function buildListingSop07Top20({
  sku,
  sop05,
  sop06,
  confirmedProductFactsVersion,
  sop03ArtifactVersion,
  sop04ArtifactVersion,
  createdAt = new Date().toISOString(),
}) {
  const checks = [];
  const active = Array.isArray(sop05?.candidates)
    ? sop05.candidates.filter(candidate => candidate?.status === 'ACTIVE' && candidate?.eligibility_status === 'ELIGIBLE_FOR_SOP06')
    : [];
  const results = Array.isArray(sop06?.results) ? sop06.results : [];

  checks.push(sop05?.artifact_type === 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL'
    && sop05?.sop_step_id === 'LISTING_SOP_05' && sop05?.status === 'PASS' && sop05?.qa_status === 'PASS'
    ? pass('SOP05_FORMAL_PASS', 'SOP05正式候选池及Stage QA均为PASS。')
    : failure('SOP05_NOT_PASS', 'SOP05正式候选池不存在或未通过Stage QA。'));
  checks.push(sop06?.artifact_type === 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES'
    && sop06?.sop_step_id === 'LISTING_SOP_06' && sop06?.status === 'PASS' && sop06?.qa_status === 'PASS'
    ? pass('SOP06_FORMAL_PASS', 'SOP06正式查询结果及Stage QA均为PASS。')
    : failure('SOP06_NOT_PASS', 'SOP06正式查询结果不存在或未通过Stage QA。'));
  checks.push(sop05?.sku === sku && sop06?.sku === sku
    ? pass('SKU_MATCH', 'SOP05、SOP06与当前SKU一致。')
    : failure('SKU_MISMATCH', 'SOP05或SOP06归属SKU与当前任务不一致。'));
  checks.push(Number(sop05?.input_versions?.confirmed_product_facts_version) === Number(confirmedProductFactsVersion)
    && Number(sop06?.confirmed_product_facts_version) === Number(confirmedProductFactsVersion)
    ? pass('FACTS_VERSION_MATCH', 'SOP05、SOP06均引用当前确认事实版本。')
    : failure('FACTS_VERSION_MISMATCH', 'SOP05或SOP06引用的事实版本不是当前版本。'));
  checks.push(String(sop05?.input_versions?.sop03_artifact_version) === String(sop03ArtifactVersion)
    && String(sop06?.sop03_artifact_version) === String(sop03ArtifactVersion)
    && String(sop05?.input_versions?.sop04_artifact_version) === String(sop04ArtifactVersion)
    && String(sop06?.sop04_artifact_version) === String(sop04ArtifactVersion)
    ? pass('SOP03_SOP04_VERSION_MATCH', 'SOP03与SOP04来源版本在候选池和查询结果中一致。')
    : failure('SOP03_SOP04_VERSION_MISMATCH', 'SOP05/SOP06的SOP03或SOP04来源版本不一致。'));
  checks.push(String(sop06?.sop05_version) === String(sop05?.version)
    ? pass('SOP05_SOP06_LINK_MATCH', 'SOP06查询结果引用当前正式SOP05版本。')
    : failure('SOP05_SOP06_LINK_MISMATCH', 'SOP06查询结果引用的SOP05版本不匹配。'));
  checks.push(active.length > 0 && Number(sop05?.selected_for_sop06_count) === active.length
    ? pass('ELIGIBLE_INPUT_COUNT_VALID', `SOP05通过事实相关性门禁的${active.length}个exact strings全部进入SOP07；数量不足20时按实际合法数量收口。`)
    : failure('SOP05_ELIGIBLE_COUNT_INVALID', `SOP05合格候选为${active.length}个，或selected_for_sop06_count与实际数量不一致。`));
  checks.push(new Set(active.map(candidate => candidate.exact_string)).size === active.length
    && active.every(candidate => typeof candidate.exact_string === 'string' && candidate.exact_string.length > 0)
    ? pass('EXACT_STRING_UNIQUE', 'SOP05 exact strings唯一且原样保留。')
    : failure('EXACT_STRING_INVALID', 'SOP05 exact string为空或重复。'));
  checks.push(results.length === active.length && new Set(results.map(result => result?.exact_string)).size === results.length
    ? pass('SOP06_RESULTS_COMPLETE', `SOP06含${results.length}条唯一exact string查询结果，与SOP05合格候选数量一致。`)
    : failure('SOP06_RESULT_COUNT_INVALID', `SOP06结果数为${results.length}，应与${active.length}个合格候选一致，且不得重复exact string。`));

  const candidateByExact = new Map(active.map(candidate => [candidate.exact_string, candidate]));
  const resultByExact = new Map(results.map(result => [result.exact_string, result]));
  const exactSetMatches = active.length === results.length && active.every(candidate => resultByExact.has(candidate.exact_string));
  checks.push(exactSetMatches
    ? pass('SOP05_SOP06_EXACT_SET_MATCH', 'SOP05合格集合与SOP06已查询集合完全相同。')
    : failure('SOP05_SOP06_EXACT_SET_MISMATCH', 'SOP05与SOP06 exact string集合不一致。'));

  const rows = active.map((candidate, index) => {
    const result = resultByExact.get(candidate.exact_string);
    const sourceCategories = [...new Set((candidate.sources || []).map(source => source?.category).filter(value => typeof value === 'string' && value))];
    const category = candidate.keyword_category ?? candidate.category ?? (sourceCategories.length === 1 ? sourceCategories[0] : null);
    const volume = result?.volume;
    return {
      _stable_sop05_order: Number.isFinite(Number(candidate.ordinal)) ? Number(candidate.ordinal) : index + 1,
      exact_string: candidate.exact_string,
      boloo_search_volume: volume,
      demand_status: volume === 0 ? 'ZERO_VALID' : 'POSITIVE',
      keyword_category: category,
      sop05_provenance: {
        candidate_id: candidate.candidate_id || null,
        ordinal: candidate.ordinal ?? index + 1,
        status: candidate.status,
        eligibility_status: candidate.eligibility_status,
        selection_reason: candidate.selection_reason || null,
        sources: structuredClone(candidate.sources || []),
        source_refs: structuredClone(candidate.source_refs || []),
        evidence_refs: structuredClone(candidate.evidence_refs || []),
      },
      sop06_result_version: result?.result_version || null,
      sop06_evidence_version: sop06?.version || null,
      sop06_request_id: result?.provider_request_id || null,
      sop06_queried_at: result?.queried_at || null,
      provider_method: result?.provider_method || null,
      sop06_evidence_refs: structuredClone(result?.evidence_refs_result || []),
      facts_eligibility: {
        status: candidate.eligibility_status,
        facts_version: confirmedProductFactsVersion,
        source_facts_version_refs: [...new Set((candidate.sources || []).map(source => source?.facts_version).filter(value => value != null))],
      },
      source_versions: {
        facts: confirmedProductFactsVersion,
        sop03: sop03ArtifactVersion,
        sop04: sop04ArtifactVersion,
        sop05: sop05?.version,
        sop06: sop06?.version,
      },
      selected_top20: false,
    };
  });

  const invalidVolumeRows = rows.filter(row => !Number.isFinite(row.boloo_search_volume) || row.boloo_search_volume < 0);
  checks.push(invalidVolumeRows.length === 0
    ? pass('OFFICIAL_VOLUME_VALID', `${rows.length}个候选均有非负正式Boloo月均搜索量，0值保留为合法结果。`)
    : failure('OFFICIAL_VOLUME_INVALID', `${invalidVolumeRows.length}个词缺少有效正式月均搜索量。`));
  const invalidResultRows = rows.filter(row => {
    const result = resultByExact.get(row.exact_string);
    return result?.status !== 'PASS' || result?.qa_status !== 'PASS' || result?.provider_method !== 'BOLOO_OFFICIAL_WEB'
      || !result?.provider_request_id || !result?.result_version || !Array.isArray(result?.evidence_refs_result)
      || result.evidence_refs_result.length === 0 || result.evidence_refs_result.some(ref => ref?.persisted !== true || ref?.matches_request !== true);
  });
  checks.push(invalidResultRows.length === 0
    ? pass('SOP06_RESULT_EVIDENCE_VALID', '每条月均搜索量均有正式Provider、request和持久化匹配证据。')
    : failure('SOP06_EVIDENCE_INVALID', `${invalidResultRows.length}条SOP06结果的Provider状态、QA或evidence引用不完整。`));

  rows.sort((left, right) => right.boloo_search_volume - left.boloo_search_volume || left._stable_sop05_order - right._stable_sop05_order);
  rows.forEach((row, index) => { row.rank = index + 1; delete row._stable_sop05_order; });
  const selectedRows = rows.slice(0, 20).map(row => ({ ...row, selected_top20: true }));
  const overflowRows = rows.slice(20).map(row => ({
    exact_string: row.exact_string,
    rank: row.rank,
    boloo_search_volume: row.boloo_search_volume,
    reason: 'RANKED_BELOW_TOP20_BY_OFFICIAL_MONTHLY_VOLUME',
  }));
  const selection = {
    target_count: 20,
    actual_count: selectedRows.length,
    evaluated_candidate_count: rows.length,
    status: selectedRows.length < 20 ? 'BELOW_TARGET_ALL_ELIGIBLE_CANDIDATES_USED' : 'TARGET_REACHED',
    reason: selectedRows.length < 20 ? 'ONLY_ELIGIBLE_CANDIDATES_AVAILABLE; NO_TERMS_INVENTED' : null,
  };
  const forbidden = collectForbiddenKeys({ selectedRows, overflowRows });
  checks.push(forbidden.length === 0
    ? pass('NO_INVENTED_SCORING', '输出不含数值相关性分、搜索量分、综合分或对数标准化字段。')
    : failure('FORBIDDEN_SCORING_FIELDS', `输出含禁止字段：${[...new Set(forbidden)].join(', ')}。`));

  const failed = checks.filter(check => !check.pass);
  const digestPayload = {
    sku,
    input_versions: { facts: confirmedProductFactsVersion, sop03: sop03ArtifactVersion, sop04: sop04ArtifactVersion, sop05: sop05?.version, sop06: sop06?.version },
    rows: rows.map(row => ({ rank: row.rank, exact_string: row.exact_string, boloo_search_volume: row.boloo_search_volume, sop06_result_version: row.sop06_result_version })),
    selection,
    overflow: overflowRows,
  };
  const version = `SOP07-${crypto.createHash('sha256').update(JSON.stringify(digestPayload), 'utf8').digest('hex').slice(0, 20)}`;
  const artifact = {
    schema_version: 1,
    artifact_type: 'LISTING_SOP_07_TOP20',
    sop_step_id: 'LISTING_SOP_07',
    sku,
    version,
    status: 'DONE_PENDING_QA',
    qa_status: 'NOT_RUN',
    ordering: 'initial_market_demand_order',
    ordering_rule: '正式Boloo月均搜索量降序；完全相同的搜索量保持SOP05稳定顺序，仅用于确定展示顺序。',
    input_versions: digestPayload.input_versions,
    target_count: 20,
    item_count: selectedRows.length,
    evaluated_candidate_count: rows.length,
    selection,
    records: selectedRows,
    not_selected_candidates: overflowRows,
    evidence: {
      sop05_artifact_type: sop05?.artifact_type || null,
      sop06_artifact_type: sop06?.artifact_type || null,
      sop05_candidate_count: active.length,
      sop06_result_count: results.length,
      selected_terms: selectedRows.map(row => ({ query_text: row.exact_string, search_volume: row.boloo_search_volume, demand_status: row.demand_status, rank: row.rank })),
      no_external_requests: true,
    },
    qa: { status: 'NOT_RUN', preflight_checks: checks, checked_at: createdAt },
    created_at: createdAt,
  };
  return { artifact, checks, passed: failed.length === 0, failure_count: failed.length, candidateByExact };
}

export function qaListingSop07Top20({ artifact, sop05, sop06, expectedVersions }) {
  const result = buildListingSop07Top20({
    sku: artifact?.sku,
    sop05,
    sop06,
    confirmedProductFactsVersion: expectedVersions?.facts,
    sop03ArtifactVersion: expectedVersions?.sop03,
    sop04ArtifactVersion: expectedVersions?.sop04,
    createdAt: artifact?.qa?.checked_at || artifact?.created_at,
  });
  const expected = result.artifact.records;
  const actual = artifact?.records || [];
  const checks = [...result.checks];
  const sameRecords = actual.length === expected.length && actual.every((row, index) => {
    const expectedRow = expected[index];
    return row.rank === expectedRow.rank && row.exact_string === expectedRow.exact_string
      && row.boloo_search_volume === expectedRow.boloo_search_volume
      && row.demand_status === expectedRow.demand_status
      && row.sop06_result_version === expectedRow.sop06_result_version;
  });
  checks.push(sameRecords
    ? pass('TOP20_RECORDS_REPRODUCIBLE', '正式TOP20可由封板SOP05/SOP06输入逐项重建。')
    : failure('TOP20_RECORDS_MISMATCH', 'TOP20记录、精确字符串、搜索量或排序无法由封板输入重建。'));
  checks.push(artifact?.target_count === 20 && artifact?.item_count === expected.length
    && artifact?.evaluated_candidate_count === result.artifact.evaluated_candidate_count
    && JSON.stringify(artifact?.selection) === JSON.stringify(result.artifact.selection)
    && JSON.stringify(artifact?.not_selected_candidates || []) === JSON.stringify(result.artifact.not_selected_candidates)
    ? pass('TOP20_ACTUAL_COUNT_DECLARED', `正式输出${expected.length}个词，并明确记录目标20、候选数及未入选项。`)
    : failure('TOP20_ACTUAL_COUNT_MISMATCH', 'TOP20实际数量、短缺说明或未入选候选记录与正式输入不一致。'));
  checks.push(artifact?.ordering === 'initial_market_demand_order'
    ? pass('ORDERING_DECLARED', '产物明确标记initial_market_demand_order。')
    : failure('ORDERING_UNDECLARED', 'TOP20产物缺少指定市场需求初始顺序标记。'));
  checks.push(JSON.stringify(artifact?.input_versions) === JSON.stringify(result.artifact.input_versions)
    ? pass('INPUT_VERSION_REPRODUCIBLE', 'TOP20输入版本与当前SOP05/SOP06/Facts/SOP03/SOP04完全一致。')
    : failure('INPUT_VERSION_MISMATCH', 'TOP20产物引用的上游版本与当前封板输入不一致。'));
  const forbidden = collectForbiddenKeys(artifact);
  checks.push(forbidden.length === 0
    ? pass('NO_FORBIDDEN_FIELDS', 'TOP20产物不包含禁止的评分/标准化字段。')
    : failure('FORBIDDEN_SCORING_FIELDS', `TOP20产物含禁止字段：${[...new Set(forbidden)].join(', ')}。`));
  return { status: checks.every(check => check.pass) ? 'PASS' : 'FAIL', checks };
}
