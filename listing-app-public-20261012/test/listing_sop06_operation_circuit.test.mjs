import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSop06OperationCircuitFailure,
  buildSop06OperationRecoveryEvidence,
  countSop06OperationFailuresAfterLastSuccess,
  operationCircuitBlocksSop06Dispatch,
} from '../app/listing_sop06_operation_circuit.mjs';

const sku = 'SYNTH-SKU-SOP06';
const exactString = 'kerstboom';
const failedAt = '2026-10-09T10:00:00.000Z';
const navFailure = (at, requestId) => ({
  status: 'ERROR',
  reason_code: 'UNKNOWN_PROVIDER_ERROR',
  request_id: requestId,
  observed_at: at,
  error: { message: 'Timed out waiting for Boloo WebView2 NavigationCompleted.' },
});

test('Pane READY on the failed process cannot authorize a SOP06 operation retry', () => {
  const history = [navFailure(failedAt, 'req-1')];
  const circuit = buildSop06OperationCircuitFailure({ sku, exactString, history, failedAt, requestId: 'req-1', reasonCode: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT',
    failedPane: { pid: 111, process_started_at: '2026-10-09T09:00:00.000Z', checked_at: '2026-10-09T09:59:00.000Z' } });
  assert.equal(circuit.failure_count, 1);
  assert.equal(circuit.state, 'WAITING_RECOVERY_EVIDENCE');
  const recovery = buildSop06OperationRecoveryEvidence({ circuit, officialWebReady: true, paneReadiness: {
    status: 'READY', bridge_status: 'READY', explorer_status: 'READY', pane_pid: 111,
    pane_process_started_at: '2026-10-09T09:00:00.000Z', checked_at: '2026-10-09T10:01:00.000Z',
  } });
  assert.equal(recovery.allowed, false);
  assert.equal(recovery.reason, 'FRESH_OPERATION_RECOVERY_EVIDENCE_REQUIRED');
});

test('a fresh Pane incarnation after the failure permits only one operation-scoped recovery', () => {
  const history = [navFailure(failedAt, 'req-1')];
  const circuit = buildSop06OperationCircuitFailure({ sku, exactString, history, failedAt, requestId: 'req-1', reasonCode: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT',
    failedPane: { pid: 111, process_started_at: '2026-10-09T09:00:00.000Z', checked_at: '2026-10-09T09:59:00.000Z' } });
  const recovery = buildSop06OperationRecoveryEvidence({ circuit, officialWebReady: true, paneReadiness: {
    status: 'READY', bridge_status: 'READY', explorer_status: 'READY', pane_pid: 222,
    pane_process_started_at: '2026-10-09T10:00:30.000Z', checked_at: '2026-10-09T10:01:00.000Z',
  } });
  assert.equal(recovery.allowed, true);
  const authorized = { ...circuit, state: 'RECOVERY_AUTHORIZED', recovery_evidence: recovery.evidence };
  assert.equal(operationCircuitBlocksSop06Dispatch(authorized, exactString, sku).blocked, false);
  assert.equal(operationCircuitBlocksSop06Dispatch({ ...authorized, state: 'RECOVERY_IN_PROGRESS' }, exactString, sku).blocked, true);
});

test('the second same-key navigation failure opens the circuit and blocks all dispatch', () => {
  const history = [navFailure(failedAt, 'req-1'), navFailure('2026-10-09T10:05:00.000Z', 'req-2')];
  assert.equal(countSop06OperationFailuresAfterLastSuccess(history, exactString), 2);
  const circuit = buildSop06OperationCircuitFailure({ sku, exactString, history,
    failedAt: '2026-10-09T10:05:00.000Z', requestId: 'req-2', reasonCode: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT' });
  assert.equal(circuit.state, 'OPEN');
  assert.equal(operationCircuitBlocksSop06Dispatch(circuit, exactString, sku).blocked, true);
});

test('a persisted success resets the operation failure count for the next operation cycle', () => {
  const history = [navFailure(failedAt, 'req-1'), {
    status: 'PASS', request_id: 'req-2', observed_at: '2026-10-09T10:02:00.000Z', query_text: exactString,
  }];
  assert.equal(countSop06OperationFailuresAfterLastSuccess(history, exactString), 0);
});
