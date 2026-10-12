import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(APP_DIR, '..');
const DEFAULT_CONFIG_PATH = path.join(APP_DIR, 'ai_provider_config.json');
const ACCEPTANCE_DATA_ROOT = path.join(PROJECT_ROOT, 'BOL数据', '验收E2E');
const CONFIG_LEAF = path.join('integrations', 'runtime-config', 'ai_provider_config.json');

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve the provider config. An override is deliberately restricted to one
 * file below the active 4181 acceptance dataRoot; production and ordinary
 * runtimes always use the checked-in default config.
 */
export function resolveAiProviderConfigPath({ env = process.env } = {}) {
  const override = String(env.BOL_AI_PROVIDER_CONFIG_PATH || '').trim();
  if (!override) return DEFAULT_CONFIG_PATH;
  if (String(env.BOL_RUNTIME_ENVIRONMENT || '') !== 'ACCEPTANCE_4181'
      || String(env.BOL_ACCEPTANCE_MODE || '') !== '1') {
    throw Object.assign(new Error('AI_PROVIDER_CONFIG_OVERRIDE_ACCEPTANCE_ONLY'), { code: 'AI_PROVIDER_CONFIG_OVERRIDE_ACCEPTANCE_ONLY' });
  }
  const dataRoot = path.resolve(String(env.BOL_ACCEPTANCE_DATA_ROOT || ''));
  if (!isWithin(ACCEPTANCE_DATA_ROOT, dataRoot) || dataRoot === ACCEPTANCE_DATA_ROOT) {
    throw Object.assign(new Error('AI_PROVIDER_CONFIG_OVERRIDE_DATA_ROOT_INVALID'), { code: 'AI_PROVIDER_CONFIG_OVERRIDE_DATA_ROOT_INVALID' });
  }
  const expected = path.resolve(dataRoot, CONFIG_LEAF);
  const candidate = path.resolve(override);
  if (candidate.toLowerCase() !== expected.toLowerCase()) {
    throw Object.assign(new Error('AI_PROVIDER_CONFIG_OVERRIDE_PATH_INVALID'), { code: 'AI_PROVIDER_CONFIG_OVERRIDE_PATH_INVALID' });
  }
  return expected;
}

