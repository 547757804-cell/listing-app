import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');
const coreUrl = new URL('../app/bol_core.mjs', import.meta.url).href;
const acceptanceEnv = {
  BOL_RUNTIME_MODE: 'NORMAL',
  BOL_RUNTIME_ENVIRONMENT: 'ACCEPTANCE_4181',
  BOL_ACCEPTANCE_MODE: '1',
  BOL_ACCEPTANCE_PORT: '4181',
  BOL_ACCEPTANCE_HOLD: '1',
  BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED: '0',
};

async function makeFixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'listing-hold-readonly-task-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataRoot, 'products'), { recursive: true });
  return dataRoot;
}

function runHeldRead(dataRoot, sku) {
  const script = `import { getTask } from ${JSON.stringify(coreUrl)};\nconst task = await getTask(process.env.TEST_DATA_ROOT, ${JSON.stringify(sku)});\nconsole.log(JSON.stringify(task && { sku: task.sku, revision: task.revision, status: task.status, current_step: task.current_step }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...acceptanceEnv, TEST_DATA_ROOT: dataRoot },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

test('HOLD task detail reads the current SQLite task through a read-only connection', async t => {
  const dataRoot = await makeFixture(t);
  const sku = 'HOLD-READ-001';
  const payload = { sku, id: sku, revision: 17, status: 'ERROR', current_step: 'LISTING_SOP_08' };
  const databaseFile = path.join(dataRoot, 'bol.sqlite3');
  const db = new DatabaseSync(databaseFile);
  db.exec('CREATE TABLE products (sku TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT, current_step TEXT, payload TEXT NOT NULL)');
  db.prepare('INSERT INTO products (sku, revision, status, current_step, payload) VALUES (?, ?, ?, ?, ?)')
    .run(sku, payload.revision, payload.status, payload.current_step, JSON.stringify(payload));
  db.close();
  const before = createHash('sha256').update(await fs.readFile(databaseFile)).digest('hex');

  assert.deepEqual(runHeldRead(dataRoot, sku), { sku, revision: 17, status: 'ERROR', current_step: 'LISTING_SOP_08' });

  const after = createHash('sha256').update(await fs.readFile(databaseFile)).digest('hex');
  assert.equal(after, before, 'read-only task detail lookup must not mutate SQLite');
});

test('HOLD task detail falls back to the committed task file when no database exists', async t => {
  const dataRoot = await makeFixture(t);
  const sku = 'HOLD-FILE-002';
  const payload = { sku, id: sku, revision: 3, status: 'PAUSED', current_step: 'LISTING_SOP_04' };
  await fs.writeFile(path.join(dataRoot, 'products', `${sku}.json`), JSON.stringify(payload), 'utf8');

  assert.deepEqual(runHeldRead(dataRoot, sku), { sku, revision: 3, status: 'PAUSED', current_step: 'LISTING_SOP_04' });
  await assert.rejects(fs.access(path.join(dataRoot, 'bol.sqlite3')), error => error.code === 'ENOENT');
});
