import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./bol_network_route_tls_diagnostic.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

assert.match(source, /readOption\('--data-root'\)/, 'diagnostic requires an explicit data root');
assert.match(source, /DATA_ROOT_ARGUMENT_REQUIRED/, 'missing data root fails closed');
assert.match(source, /DATA_ROOT_OUTSIDE_ACCEPTANCE_ROOT/, 'data root is confined to acceptance roots');
assert.doesNotMatch(source, /SYNTHETIC_ACCEPTANCE_10-competitor-auto|SYNTHETIC-SKU-LEGACY-10/, 'diagnostic has no SYNTHETIC_ACCEPTANCE_10 data-root identity');
assert.match(source, /const targetHosts = \['login\.bol\.com'\]/, 'only the authorized login host is probed');
assert.doesNotMatch(source, /api\.bol\.com|readiness-check|readiness-on-tls-pass/, 'diagnostic cannot probe BOL API or trigger readiness');
for (const field of [
  'acceptance_hold !== true',
  'business_dispatch_enabled !== false',
  'dependency_resume_enabled !== false',
  'background_provider_probe_enabled !== false',
  'task_auto_mutation_enabled !== false',
]) assert.ok(source.includes(field), `HOLD safety guard exists: ${field}`);
assert.match(source, /TRANSPORT_DIAGNOSTIC_ONLY/, 'diagnostic records that no readiness probe ran');

process.stdout.write('BOL_LOGIN_ROUTE_DIAGNOSTIC_SCOPE_OFFLINE=PASS; external_requests=0\n');
