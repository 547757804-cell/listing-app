import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDisplayedVolume, matchesDisplayedVolume } from '../app/boloo_volume_format.mjs';
import { rearmSop06PaneChildAfterReadiness } from '../app/bol_core.mjs';

function child({ status = 'PAUSED', subtaskStatus = 'NOT_STARTED', attemptCount = 0, requestIds = [], history = [], result = null } = {}) {
  return {
    sku: 'BCHILD-S06-SYNTH', status, waiting_dependency_key: null,
    provider_child_task: {
      parent_sku: 'SYNTH-SKU', parent_sop_step: 'LISTING_SOP_06',
      task_type: 'KEYWORD_EXPLORER', exact_string: 'kerstboom',
    },
    boloo: { required_subtasks: [{
      provider_source: 'keyword_explorer', query_text: 'kerstboom', status: subtaskStatus,
      attempt_count: attemptCount, request_ids: [...requestIds], history: structuredClone(history), result,
    }] },
  };
}

test('official page value 10,934 canonicalizes to the numeric search volume 10934', () => {
  assert.equal(parseDisplayedVolume('10,934'), 10934);
  assert.equal(matchesDisplayedVolume('10,934', 10934), true);
  assert.equal(matchesDisplayedVolume('10,934', 10.934), false);
});

test('a paused child with no attempt or result is requeued without changing exact query identity', () => {
  const task = child();
  assert.equal(rearmSop06PaneChildAfterReadiness(task, '2026-10-09T10:00:00.000Z', { activeLeaseCount: 0 }), true);
  assert.equal(task.status, 'RUNNING');
  assert.equal(task.boloo.required_subtasks[0].status, 'NOT_STARTED');
  assert.equal(task.boloo.required_subtasks[0].query_text, 'kerstboom');
});

test('a paused attempted child without a result requires exact operation recovery authorization', () => {
  const attempted = child({ subtaskStatus: 'PENDING_RECHECK', attemptCount: 1, requestIds: ['REQ-1'],
    history: [{ status: 'ERROR', request_id: 'REQ-1' }] });
  assert.equal(rearmSop06PaneChildAfterReadiness(attempted, undefined, { activeLeaseCount: 0 }), false);
  assert.equal(attempted.status, 'PAUSED');

  assert.equal(rearmSop06PaneChildAfterReadiness(attempted, '2026-10-09T10:01:00.000Z', {
    activeLeaseCount: 0, operationRecoveryAuthorized: true,
  }), true);
  assert.equal(attempted.status, 'RUNNING');
  assert.equal(attempted.boloo.required_subtasks[0].status, 'PENDING_RECHECK');
  assert.equal(attempted.boloo.required_subtasks[0].history.length, 1);
});

test('an orphaned RUNNING child without a lease is reconciled; an active lease prevents requeue', () => {
  const orphaned = child({ status: 'RUNNING', subtaskStatus: 'RUNNING' });
  assert.equal(rearmSop06PaneChildAfterReadiness(orphaned, '2026-10-09T10:02:00.000Z', { activeLeaseCount: 0 }), true);
  assert.equal(orphaned.boloo.required_subtasks[0].status, 'NOT_STARTED');

  const leased = child({ status: 'PAUSED' });
  assert.equal(rearmSop06PaneChildAfterReadiness(leased, undefined, { activeLeaseCount: 1 }), false);
  assert.equal(leased.status, 'PAUSED');
});

test('a valid child result is not requeued or overwritten', () => {
  const success = child({ status: 'PAUSED', subtaskStatus: 'PASS', result: { status: 'PASS' } });
  assert.equal(rearmSop06PaneChildAfterReadiness(success, undefined, { activeLeaseCount: 0, operationRecoveryAuthorized: true }), false);
  assert.equal(success.status, 'PAUSED');
  assert.equal(success.boloo.required_subtasks[0].result.status, 'PASS');
});
