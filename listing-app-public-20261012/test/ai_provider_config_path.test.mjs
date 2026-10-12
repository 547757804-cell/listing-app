import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveAiProviderConfigPath } from '../app/ai_provider_config_path.mjs';

const projectRoot = path.resolve(process.cwd());
const acceptanceRoot = path.join(projectRoot, 'BOL数据', '验收E2E');
const dataRoot = path.join(acceptanceRoot, 'CONFIG_PATH_TEST');
const expectedOverride = path.join(dataRoot, 'integrations', 'runtime-config', 'ai_provider_config.json');

test('default runtimes keep using the shared default provider config', () => {
  assert.equal(resolveAiProviderConfigPath({ env: {} }), path.join(projectRoot, 'app', 'ai_provider_config.json'));
});

test('4181 may use only the active acceptance dataRoot provider config', () => {
  assert.equal(resolveAiProviderConfigPath({ env: {
    BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181',
    BOL_ACCEPTANCE_MODE: '1',
    BOL_ACCEPTANCE_DATA_ROOT: dataRoot,
    BOL_AI_PROVIDER_CONFIG_PATH: expectedOverride,
  } }), expectedOverride);
});

test('production or non-acceptance processes cannot select an override', () => {
  assert.throws(() => resolveAiProviderConfigPath({ env: {
    BOL_RUNTIME_ENVIRONMENT: 'PRODUCTION_4180',
    BOL_ACCEPTANCE_MODE: '0',
    BOL_ACCEPTANCE_DATA_ROOT: dataRoot,
    BOL_AI_PROVIDER_CONFIG_PATH: expectedOverride,
  } }), { code: 'AI_PROVIDER_CONFIG_OVERRIDE_ACCEPTANCE_ONLY' });
});

test('override path must be the exact runtime-config file under an acceptance dataRoot', () => {
  assert.throws(() => resolveAiProviderConfigPath({ env: {
    BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181',
    BOL_ACCEPTANCE_MODE: '1',
    BOL_ACCEPTANCE_DATA_ROOT: dataRoot,
    BOL_AI_PROVIDER_CONFIG_PATH: path.join(dataRoot, 'ai_provider_config.json'),
  } }), { code: 'AI_PROVIDER_CONFIG_OVERRIDE_PATH_INVALID' });
});

test('dataRoot outside the acceptance tree fails closed', () => {
  assert.throws(() => resolveAiProviderConfigPath({ env: {
    BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181',
    BOL_ACCEPTANCE_MODE: '1',
    BOL_ACCEPTANCE_DATA_ROOT: path.join(projectRoot, 'BOL数据'),
    BOL_AI_PROVIDER_CONFIG_PATH: path.join(projectRoot, 'BOL数据', 'integrations', 'runtime-config', 'ai_provider_config.json'),
  } }), { code: 'AI_PROVIDER_CONFIG_OVERRIDE_DATA_ROOT_INVALID' });
});
