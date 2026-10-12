import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  deriveRuntimePolicy, isRuntimeRequestAllowed, isManualContinueScopeAllowed,
  createManualProviderProbeContext, createManualProviderProbeClaim, MANUAL_PROVIDER_PROBE_TYPES,
} from '../app/runtime_mode.mjs';
import { buildBolooPaneBridgeRequest, resolveBolooPaneBridgePaths } from '../app/boloo_web_provider.mjs';

const acceptanceBase = {
  BOL_RUNTIME_MODE: 'NORMAL',
  BOL_ACCEPTANCE_MODE: '1',
  BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181',
  BOL_ACCEPTANCE_PORT: '4181',
};
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');

test('acceptance HOLD keeps every automatic execution flag disabled', () => {
  const policy = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(policy.acceptance_mode, true);
  assert.equal(policy.acceptance_hold, true);
  assert.equal(policy.watcher_mode, 'LOCAL_AGGREGATE_ONLY');
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(policy[key], false, key);
  }
});

test('acceptance HOLD admits one explicitly authorized BOL readiness probe without enabling task work', () => {
  const env = { ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' };
  const held = deriveRuntimePolicy(env);
  const endpoint = '/api/integrations/bol/readiness-check';
  const probeType = MANUAL_PROVIDER_PROBE_TYPES.BOL_READINESS;
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held }), false);

  const unauthenticated = createManualProviderProbeContext({ env, method: 'POST', pathname: endpoint, probeType });
  assert.equal(unauthenticated.reason_code, 'MANUAL_PROVIDER_PROBE_AUTH_REQUIRED');
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held, manualProviderProbeContext: unauthenticated }), false);

  const wrongType = createManualProviderProbeContext({
    env, method: 'POST', pathname: endpoint,
    headers: { 'x-bol-manual-provider-probe': 'authorized' }, probeType: 'UNRELATED_PROBE',
  });
  assert.equal(wrongType.reason_code, 'MANUAL_PROVIDER_PROBE_TYPE_NOT_ALLOWED');
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held, manualProviderProbeContext: wrongType }), false);

  const authorized = createManualProviderProbeContext({
    env, method: 'POST', pathname: endpoint,
    headers: { 'x-bol-manual-provider-probe': 'authorized' }, probeType,
  });
  assert.equal(authorized.authorized, true);
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held, manualProviderProbeContext: authorized }), true);
  for (const key of ['sku_execution_lease', 'listing_step_dispatch', 'dependency_resume', 'task_auto_mutation']) {
    assert.equal(authorized[key], false, key);
  }
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(held[key], false, key);
  }

  const claim = createManualProviderProbeClaim({ endpoint, probeType });
  assert.equal(claim(unauthenticated), false);
  assert.equal(claim(authorized), true);
  assert.equal(claim(authorized), false, 'one runtime permits only one BOL readiness refresh');
});

test('acceptance HOLD admits only the explicit SYNTHETIC_ACCEPTANCE_05 Qwen SOP10 recovery probe context', () => {
  const env = { ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' };
  const endpoint = '/api/integrations/ai/qwen-sop10-recovery-probe';
  const headers = { 'x-bol-manual-provider-probe': 'authorized' };
  const probeType = MANUAL_PROVIDER_PROBE_TYPES.QWEN_SOP10_RECOVERY;
  const held = deriveRuntimePolicy(env);
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held }), false);

  const authorized = createManualProviderProbeContext({ env, method: 'POST', pathname: endpoint, headers, probeType });
  assert.equal(authorized.authorized, true);
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held, manualProviderProbeContext: authorized }), true);
  for (const key of ['sku_execution_lease', 'listing_step_dispatch', 'dependency_resume', 'task_auto_mutation']) {
    assert.equal(authorized[key], false, key);
  }
  assert.equal(createManualProviderProbeContext({ env, method: 'POST', pathname: endpoint, headers, probeType: 'UNLISTED' }).authorized, false);
  const productionEnv = { ...env, BOL_ACCEPTANCE_MODE: '0', BOL_RUNTIME_ENVIRONMENT: 'PRODUCTION_4180', BOL_ACCEPTANCE_PORT: '4180' };
  assert.equal(createManualProviderProbeContext({ env: productionEnv, method: 'POST', pathname: endpoint, headers, probeType }).authorized, false);
  const claim = createManualProviderProbeClaim({ endpoint, probeType });
  assert.equal(claim(authorized), true);
  assert.equal(claim(authorized), false, 'the manual Qwen recovery probe can be claimed once per runtime');
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(held[key], false, key);
  }
});

test('production cannot enter the acceptance-only manual BOL readiness probe context', () => {
  const env = { ...acceptanceBase, BOL_ACCEPTANCE_MODE: '0', BOL_RUNTIME_ENVIRONMENT: 'PRODUCTION_4180', BOL_ACCEPTANCE_PORT: '4180', BOL_ACCEPTANCE_HOLD: '1' };
  const endpoint = '/api/integrations/bol/readiness-check';
  const context = createManualProviderProbeContext({
    env, method: 'POST', pathname: endpoint,
    headers: { 'x-bol-manual-provider-probe': 'authorized' },
    probeType: MANUAL_PROVIDER_PROBE_TYPES.BOL_READINESS,
  });
  assert.equal(context.authorized, false);
  assert.equal(context.reason_code, 'MANUAL_PROBE_ACCEPTANCE_4181_REQUIRED');
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: deriveRuntimePolicy(env), manualProviderProbeContext: context }), true,
    'the normal production endpoint keeps its established behavior; acceptance manual context is still denied');
});

test('SOP07 cached QA recovery has a dedicated HOLD route without opening generic task actions', () => {
  const held = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SYNTHETIC-SKU-LEGACY-05/sop07-cached-qa-revalidation', { runtimePolicy: held }), true);
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SYNTHETIC-SKU-UNLISTED-09/action', { runtimePolicy: held }), false);
  const production = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_MODE: '0', BOL_RUNTIME_ENVIRONMENT: 'PRODUCTION_4180', BOL_ACCEPTANCE_PORT: '4180', BOL_ACCEPTANCE_HOLD: '0' });
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SYNTHETIC-SKU-LEGACY-05/sop07-cached-qa-revalidation', { runtimePolicy: production }), true);
  // Production isolation is enforced by the dedicated HTTP route before it calls core.
  assert.equal(production.acceptance_mode, false);
});

test('SOP09 local input-bundle registration is admitted only for NORMAL acceptance HOLD', () => {
  const endpoint = '/api/tasks/SYNTHETIC-SKU-LEGACY-05/sop09-input-bundle-registration';
  const held = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held }), true);
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(held[key], false, key);
  }

  const readinessOnly = deriveRuntimePolicy({ ...acceptanceBase, BOL_RUNTIME_MODE: 'READINESS_ONLY', BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: readinessOnly }), false);

  const production = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_MODE: '0',
    BOL_RUNTIME_ENVIRONMENT: 'PRODUCTION_4180', BOL_ACCEPTANCE_PORT: '4180', BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(production.acceptance_mode, false);
  // The general production route path is not widened by the acceptance-only
  // exception; its handler independently rejects non-acceptance data roots.
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: production }), true);
});

test('SOP09 cached QA revalidation is a local acceptance-HOLD control only', () => {
  const endpoint = '/api/tasks/SYNTHETIC-SKU-LEGACY-05/sop09-cached-qa-revalidation';
  const held = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: held }), true);
  const readinessOnly = deriveRuntimePolicy({ ...acceptanceBase, BOL_RUNTIME_MODE: 'READINESS_ONLY', BOL_ACCEPTANCE_HOLD: '1' });
  assert.equal(isRuntimeRequestAllowed('POST', endpoint, { runtimePolicy: readinessOnly }), false);
});

test('manual-continue latch disables background task work while the explicit action route remains admitted', () => {
  const policy = deriveRuntimePolicy({ ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '0', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1' });
  assert.equal(policy.acceptance_hold, false);
  assert.equal(policy.manual_continue_required, true);
  assert.equal(policy.watcher_mode, 'LOCAL_AGGREGATE_ONLY');
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(policy[key], false, key);
  }
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SKU-1/action', { runtimePolicy: policy }), true);
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SKU-1/listing/sop03/boloo-extractors', { runtimePolicy: policy }), true);
});

test('NORMAL acceptance permits only the exact latched SKU in an explicit manual-Continue scope', () => {
  const env = { ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '0', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1' };
  const policy = { ...deriveRuntimePolicy(env), manual_continue_sku: 'SYNTHETIC-SKU-LEGACY-05' };
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: policy, env, action: 'continue',
    sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: true }), true);
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SYNTHETIC-SKU-LEGACY-05/action', { runtimePolicy: policy }), true);
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: policy, env, action: 'sop06-pane-resume',
    sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: true }), true);
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: policy, env, action: 'pause',
    sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: true }), true);
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(policy[key], false, key);
  }
  assert.equal(policy.watcher_mode, 'LOCAL_AGGREGATE_ONLY');
});

test('manual Continue carries one exact-SKU dispatch permit into the AI Router without enabling global dispatch', () => {
  const dataRoot = 'D:/SYNTHETIC_BOL_ROOT/BOL数据/验收E2E/SYNTHETIC_ACCEPTANCE_05_FIXTURE';
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { setAcceptanceHold, getEffectiveRuntimePolicy, withAcceptanceManualContinueDispatchScope, assertBusinessDispatchEnabled } from './app/runtime_mode.mjs';
    const sku='SYNTHETIC-SKU-LEGACY-05', dataRoot=process.env.BOL_ACCEPTANCE_DATA_ROOT;
    setAcceptanceHold(false, { manualContinueRequired:true, manualContinueSku:sku });
    assert.equal(getEffectiveRuntimePolicy().business_dispatch_enabled, false);
    assert.throws(()=>assertBusinessDispatchEnabled('outside',{sku,dataRoot}), {code:'MANUAL_CONTINUE_SCOPE_REQUIRED'});
    await withAcceptanceManualContinueDispatchScope({sku,dataRoot,action:'continue'}, async()=>{
      assert.doesNotThrow(()=>assertBusinessDispatchEnabled('AI Router dispatch',{sku,dataRoot}));
      assert.doesNotThrow(()=>assertBusinessDispatchEnabled('AI Provider invocation',{sku,dataRoot}));
      assert.throws(()=>assertBusinessDispatchEnabled('wrong SKU',{sku:'SY01-LB00238',dataRoot}), {code:'MANUAL_CONTINUE_SCOPE_REQUIRED'});
      assert.throws(()=>assertBusinessDispatchEnabled('wrong root',{sku,dataRoot:dataRoot+'-other'}), {code:'MANUAL_CONTINUE_SCOPE_REQUIRED'});
      await Promise.resolve();
      assert.doesNotThrow(()=>assertBusinessDispatchEnabled('async Router dispatch',{sku,dataRoot}));
    });
    const policy=getEffectiveRuntimePolicy();
    for (const key of ['business_dispatch_enabled','dependency_resume_enabled','background_provider_probe_enabled','task_auto_mutation_enabled']) assert.equal(policy[key],false,key);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, BOL_RUNTIME_MODE: 'NORMAL', BOL_ACCEPTANCE_MODE: '1',
      BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181', BOL_ACCEPTANCE_PORT: '4181',
      BOL_ACCEPTANCE_HOLD: '0', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1',
      BOL_ACCEPTANCE_DATA_ROOT: dataRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('manual Continue reaches the provider worker pool only inside the exact SKU scope', () => {
  const dataRoot = 'D:/SYNTHETIC_BOL_ROOT/BOL数据/验收E2E/SYNTHETIC_ACCEPTANCE_05_FIXTURE';
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { AiWorkerPool } from './app/ai_worker_pool.mjs';
    import { setAcceptanceHold, getEffectiveRuntimePolicy, withAcceptanceManualContinueDispatchScope } from './app/runtime_mode.mjs';
    const sku='SYNTHETIC-SKU-LEGACY-05', dataRoot=process.env.BOL_ACCEPTANCE_DATA_ROOT;
    const pool=new AiWorkerPool({QWEN:1});
    setAcceptanceHold(false, { manualContinueRequired:true, manualContinueSku:sku });
    assert.equal(getEffectiveRuntimePolicy().business_dispatch_enabled, false);
    let calls=0;
    await assert.rejects(pool.run('QWEN',async()=>{calls++;},{sku,dataRoot}), {code:'MANUAL_CONTINUE_SCOPE_REQUIRED'});
    await withAcceptanceManualContinueDispatchScope({sku,dataRoot,action:'continue'}, async()=>{
      assert.equal(await pool.run('QWEN',async()=>{
        calls++;
        assert.equal(pool.activeCount('QWEN'),1);
        await Promise.resolve();
        return 'completed';
      },{sku,dataRoot}), 'completed');
      await assert.rejects(pool.run('QWEN',async()=>{calls++;},{sku:'SY01-LB00238',dataRoot}), {code:'MANUAL_CONTINUE_SCOPE_REQUIRED'});
    });
    assert.equal(calls,1);
    assert.equal(pool.activeCount('QWEN'),0);
    assert.equal(pool.queueCount('QWEN'),0);
    const policy=getEffectiveRuntimePolicy();
    for (const key of ['business_dispatch_enabled','dependency_resume_enabled','background_provider_probe_enabled','task_auto_mutation_enabled']) assert.equal(policy[key],false,key);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, BOL_RUNTIME_MODE: 'NORMAL', BOL_ACCEPTANCE_MODE: '1',
      BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181', BOL_ACCEPTANCE_PORT: '4181',
      BOL_ACCEPTANCE_HOLD: '0', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1',
      BOL_ACCEPTANCE_DATA_ROOT: dataRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('manual-Continue scope rejects READINESS_ONLY, wrong SKU, and non-acceptance data roots', () => {
  const acceptanceEnv = { ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '0', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1' };
  const acceptancePolicy = { ...deriveRuntimePolicy(acceptanceEnv), manual_continue_sku: 'SYNTHETIC-SKU-LEGACY-05' };
  const readinessEnv = { ...acceptanceEnv, BOL_RUNTIME_MODE: 'READINESS_ONLY' };
  const readinessPolicy = { ...deriveRuntimePolicy(readinessEnv), manual_continue_sku: 'SYNTHETIC-SKU-LEGACY-05' };
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: readinessPolicy, env: readinessEnv,
    action: 'continue', sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: true }), false);
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: acceptancePolicy, env: acceptanceEnv,
    action: 'continue', sku: 'SY01-LB00233', acceptanceDataRoot: true }), false);
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: acceptancePolicy, env: acceptanceEnv,
    action: 'continue', sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: false }), false);
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: acceptancePolicy, env: acceptanceEnv,
    action: 'pause', sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: false }), false);
  assert.equal(isRuntimeRequestAllowed('POST', '/api/tasks/SY01-LB00233/action', { runtimePolicy: acceptancePolicy }), false);
});

test('acceptance HOLD stays globally closed until an exact manual latch is released', () => {
  const heldEnv = { ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '1' };
  const held = deriveRuntimePolicy(heldEnv);
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: held, env: heldEnv,
    action: 'continue', sku: 'SYNTHETIC-SKU-LEGACY-05', manualContinueSku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: true }), false);
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(held[key], false, key);
  }
  const releasedEnv = { ...acceptanceBase, BOL_ACCEPTANCE_HOLD: '0', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1' };
  const released = { ...deriveRuntimePolicy(releasedEnv), manual_continue_sku: 'SYNTHETIC-SKU-LEGACY-05' };
  assert.equal(isManualContinueScopeAllowed({ runtimePolicy: released, env: releasedEnv,
    action: 'continue', sku: 'SYNTHETIC-SKU-LEGACY-05', acceptanceDataRoot: true }), true);
  for (const key of ['business_dispatch_enabled', 'dependency_resume_enabled', 'background_provider_probe_enabled', 'task_auto_mutation_enabled']) {
    assert.equal(released[key], false, key);
  }
});

test('production ignores inherited acceptance HOLD settings', () => {
  const policy = deriveRuntimePolicy({
    BOL_RUNTIME_MODE: 'NORMAL', BOL_ACCEPTANCE_MODE: '0', BOL_RUNTIME_ENVIRONMENT: 'PRODUCTION_4180',
    BOL_ACCEPTANCE_PORT: '4180', BOL_ACCEPTANCE_HOLD: '1', BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '1',
  });
  assert.equal(policy.acceptance_mode, false);
  assert.equal(policy.acceptance_hold, false);
  assert.equal(policy.manual_continue_required, false);
  assert.equal(policy.business_dispatch_enabled, true);
  assert.equal(policy.task_auto_mutation_enabled, true);
});

test('SOP06 Pane requests use the shared Owner inbox and task-scoped response contract', () => {
  const dataRoot = path.join(projectRoot, 'BOL数据', '验收E2E', 'CONTRACT_FIXTURE');
  const requestId = '01234567-89ab-cdef-0123-456789abcdef';
  const paths = resolveBolooPaneBridgePaths({ dataRoot, requestId });
  const request = buildBolooPaneBridgeRequest({
    dataRoot, requestId, responsePath: paths.responsePath,
    operation: 'keyword_explorer', attempt: 1, script: '(()=>({status:"OFFLINE_FIXTURE"}))()',
  });

  assert.equal(request.schema, 'boloo.pane.bridge-request.v1');
  assert.equal(request.data_root, dataRoot);
  assert.equal(request.response_path, paths.responsePath);
  assert.equal(request.request_id, requestId);
  assert.equal(request.operation, 'keyword_explorer');
  assert.equal(request.attempt, 1);
  assert.equal(paths.requestPath, path.join(projectRoot, 'BOL数据', 'integrations', 'boloo-pane-bridge', 'inbox', 'pane-' + requestId + '.json'));
  assert.ok(paths.responsePath.startsWith(dataRoot + path.sep));
  assert.equal(Object.hasOwn(request, 'url'), false);
});

test('legacy SYNTHETIC_ACCEPTANCE_05 Pane verifier delegates to the generic contract owner', async () => {
  const source = await fs.readFile(new URL('../ui_shell/boloo_test/verify_sample_boloo_pane.ps1', import.meta.url), 'utf8');
  assert.match(source, /infra\\verify_boloo_pane_readiness\.ps1/);
  assert.match(source, /& \$Verifier -TaskDataRoot \$TaskDataRoot -TimeoutSeconds \$TimeoutSeconds/);
  assert.doesNotMatch(source, /request\.json|response-\$requestId|operation\s*=\s*'script'|sop03-boloo\\bridge/);
});
