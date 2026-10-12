import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSop06QueryResumeAction } from '../app/listing_sop06_boloo_bridge.mjs';

const evidenceRef = 'D:/acceptance/evidence/keyword_explorer-request-1.json';

function passedChild() {
  return {
    status: 'WAITING_DISCOVERY_INPUT',
    boloo: { required_subtasks: [{
      status: 'PASS',
      query_text: 'kerstboom',
      result: {
        status: 'PASS', query_text: 'kerstboom', request_id: 'request-2',
        result: { search_volume: 10934 },
        evidence: { dom_evidence_ref: { reference: evidenceRef } },
      },
    }] },
  };
}

function matchingParent() {
  return {
    exact_string: 'kerstboom', status: 'PASS', qa_status: 'PASS', result_version: 'SOP06-QUERY-2',
    provider_request_id: 'request-2', volume: 10934,
    evidence_refs_result: [{ persisted: true, matches_request: true, reference: evidenceRef }],
  };
}

test('does not reuse a PASS parent row whose request, volume, and evidence disagree with a PASS child', () => {
  const parent = {
    ...matchingParent(), provider_request_id: 'request-1', volume: null,
    evidence_refs_result: [{ persisted: true, matches_request: false, reference: 'old-evidence.json' }],
  };
  assert.equal(decideSop06QueryResumeAction(parent, passedChild()), 'SYNC_CHILD_RESULT');
});

test('reuses a fully matching parent row without rerunning its exact query', () => {
  assert.equal(decideSop06QueryResumeAction(matchingParent(), passedChild()), 'REUSE_PARENT');
});

test('routes an unstarted child to the provider only when there is no successful child result to synchronize', () => {
  const child = { status: 'RUNNING', boloo: { required_subtasks: [{ status: 'NOT_STARTED', query_text: 'kralen' }] } };
  assert.equal(decideSop06QueryResumeAction({ exact_string: 'kralen', status: 'NOT_STARTED' }, child), 'RUN_PROVIDER');
});

test('does not re-dispatch an attempted child without exact operation recovery authorization', () => {
  const child = { status: 'RUNNING', boloo: { required_subtasks: [{
    status: 'RUNNING', query_text: 'kralen', attempt_count: 3, request_ids: ['REQ-1', 'REQ-2', 'REQ-3'],
    history: [{ status: 'ERROR', request_id: 'REQ-3' }], result: null,
  }] } };
  const parent = { exact_string: 'kralen', status: 'PENDING_RECHECK' };
  assert.equal(decideSop06QueryResumeAction(parent, child), 'BLOCKED');
  assert.equal(decideSop06QueryResumeAction(parent, child, { operationRecoveryAuthorized: true }), 'RUN_PROVIDER');
});
