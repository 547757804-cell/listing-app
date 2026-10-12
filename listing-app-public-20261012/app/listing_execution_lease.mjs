import crypto from 'node:crypto';
import os from 'node:os';

const ACTIVE_STATE = 'RUNNING';
const TERMINAL_STATES = new Set([
  'PASS', 'FAILED', 'WAITING_DEPENDENCY', 'WAITING_CONFIRMATION', 'WAITING_DECISION', 'WAITING_PROVIDER_INPUT', 'PAUSED', 'CANCELLED',
]);
const STALE_AFTER_MS = 45_000;
const activeExecutionIds = new Set();

export function ensureListingExecutionLeaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_execution_leases (
      lease_id TEXT PRIMARY KEY,
      sku_id TEXT NOT NULL,
      step TEXT NOT NULL,
      input_version TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      owner_worker TEXT NOT NULL,
      state TEXT NOT NULL,
      result_state TEXT,
      ended_at TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      last_recovery_at TEXT
    );
    CREATE INDEX IF NOT EXISTS listing_execution_lease_lookup
      ON listing_execution_leases(sku_id, step, input_version, state, heartbeat_at);
  `);
}

export function makeListingExecutionInputVersion(inputVersionRefs, dependencies = []) {
  const payload = JSON.stringify({ input_version_refs: inputVersionRefs || [], dependencies: dependencies || [] });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function currentListingWorkerId() {
  return JSON.stringify({ host: os.hostname(), pid: process.pid, worker: 'listing-executor' });
}

function workerIsAlive(ownerWorker) {
  try {
    const parsed = JSON.parse(ownerWorker);
    if (parsed.host !== os.hostname() || !Number.isInteger(Number(parsed.pid))) return false;
    const pid = Number(parsed.pid);
    if (pid === process.pid) return activeExecutionIds.has(parsed.execution_id);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function activateListingExecution(executionId) {
  activeExecutionIds.add(executionId);
}

export function deactivateListingExecution(executionId) {
  activeExecutionIds.delete(executionId);
}

export function buildDuplicateDispatchSuppression({ task, step, inputVersion, lease, code = 'NOOP_ALREADY_RUNNING' }) {
  return {
    task,
    event_details: {
      step, input_version: inputVersion, existing_execution_id: lease?.execution_id || null,
      lease_id: lease?.lease_id || null, reason: code,
    },
  };
}

export function acquireListingExecutionLease(db, {
  skuId, step, inputVersion, executionId = crypto.randomUUID(), now = new Date(), staleAfterMs = STALE_AFTER_MS,
}) {
  if (!skuId || !step || !inputVersion) throw new TypeError('skuId, step, and inputVersion are required for an execution lease.');
  const nowIso = now.toISOString();
  const ownerWorker = currentListingWorkerId();
  db.exec('BEGIN IMMEDIATE');
  try {
    const active = db.prepare(`SELECT * FROM listing_execution_leases
      WHERE sku_id=? AND step=? AND input_version=? AND state=?
      ORDER BY started_at DESC LIMIT 1`).get(skuId, step, inputVersion, ACTIVE_STATE);
    if (active) {
      const ageMs = Math.max(0, now.getTime() - Date.parse(active.heartbeat_at));
      const stale = !Number.isFinite(ageMs) || ageMs > staleAfterMs;
      if (!stale) {
        db.exec('COMMIT');
        return { acquired: false, code: 'NOOP_ALREADY_RUNNING', lease: active };
      }
      const workerAlive = workerIsAlive(active.owner_worker);
      if (workerAlive) {
        db.exec('COMMIT');
        return { acquired: false, code: 'NOOP_ALREADY_RUNNING', lease: active, stale_heartbeat_worker_alive: true };
      }
      db.prepare(`UPDATE listing_execution_leases SET state='FAILED', result_state='STALE_WORKER_GONE', ended_at=?, recovery_count=recovery_count+1, last_recovery_at=? WHERE lease_id=? AND state=?`)
        .run(nowIso, nowIso, active.lease_id, ACTIVE_STATE);
    }
    const leaseId = crypto.randomUUID();
    const worker = JSON.stringify({ ...JSON.parse(ownerWorker), execution_id: executionId });
    db.prepare(`INSERT INTO listing_execution_leases
      (lease_id, sku_id, step, input_version, execution_id, started_at, heartbeat_at, owner_worker, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(leaseId, skuId, step, inputVersion, executionId, nowIso, nowIso, worker, ACTIVE_STATE);
    db.exec('COMMIT');
    return { acquired: true, code: 'ACQUIRED', lease: { lease_id: leaseId, sku_id: skuId, step, input_version: inputVersion, execution_id: executionId, started_at: nowIso, heartbeat_at: nowIso, owner_worker: worker, state: ACTIVE_STATE } };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

export function heartbeatListingExecutionLease(db, leaseId, now = new Date()) {
  return db.prepare(`UPDATE listing_execution_leases SET heartbeat_at=? WHERE lease_id=? AND state=?`)
    .run(now.toISOString(), leaseId, ACTIVE_STATE).changes === 1;
}

export function finishListingExecutionLease(db, leaseId, resultState, now = new Date()) {
  const state = TERMINAL_STATES.has(resultState) ? resultState : 'FAILED';
  return db.prepare(`UPDATE listing_execution_leases SET state=?, result_state=?, ended_at=?, heartbeat_at=? WHERE lease_id=? AND state=?`)
    .run(state, resultState || null, now.toISOString(), now.toISOString(), leaseId, ACTIVE_STATE).changes === 1;
}

export function listingExecutionLeaseStates() {
  return [...TERMINAL_STATES];
}
