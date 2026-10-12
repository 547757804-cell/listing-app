import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiProviderDependencyBarrier, isProviderReadinessAfterBarrier } from '../app/ai_dependency_resume_gate.mjs';

const waitAt = '2026-10-11T11:29:26.356Z';
const readyAt = '2026-10-12T02:11:57.407Z';
const task = (overrides = {}) => ({ status: 'WAITING_DEPENDENCY', current_step: 'LISTING_SOP_10',
  updated_at: waitAt, waiting_dependency_key: 'QWEN', required_readiness_after: null, ...overrides });
const event = (overrides = {}) => ({ at: waitAt, type: 'LISTING_AI_PROVIDER_DEPENDENCY_WAITING',
  current_step: 'LISTING_SOP_10', details: { dependency: 'QWEN' }, ...overrides });

test('exact latest provider wait event recovers a legacy missing barrier', () => {
  const barrier = resolveAiProviderDependencyBarrier({ task: task(), history: [event()], dependency: 'QWEN' });
  assert.deepEqual(barrier, { at: waitAt, source: 'EXACT_CURRENT_WAIT_EVENT' });
  assert.equal(isProviderReadinessAfterBarrier(readyAt, barrier.at), true);
});

test('explicit barrier takes precedence over legacy history', () => {
  const explicit = '2026-10-12T02:12:00.000Z';
  const barrier = resolveAiProviderDependencyBarrier({ task: task({ required_readiness_after: explicit }), history: [event()], dependency: 'QWEN' });
  assert.deepEqual(barrier, { at: explicit, source: 'TASK_REQUIRED_READINESS_AFTER' });
  assert.equal(isProviderReadinessAfterBarrier(readyAt, barrier.at), false);
});

test('readiness at or before the barrier cannot resume', () => {
  assert.equal(isProviderReadinessAfterBarrier(waitAt, waitAt), false);
  assert.equal(isProviderReadinessAfterBarrier('2026-10-11T11:29:26.355Z', waitAt), false);
});

test('a later task update makes the old wait event unusable', () => {
  assert.equal(resolveAiProviderDependencyBarrier({ task: task({ updated_at: '2026-10-11T11:30:00.000Z' }), history: [event()], dependency: 'QWEN' }), null);
});

test('wrong step, dependency, or event type fails closed', () => {
  assert.equal(resolveAiProviderDependencyBarrier({ task: task({ current_step: 'LISTING_SOP_11' }), history: [event()], dependency: 'QWEN' }), null);
  assert.equal(resolveAiProviderDependencyBarrier({ task: task(), history: [event({ details: { dependency: 'DEEPSEEK' } })], dependency: 'QWEN' }), null);
  assert.equal(resolveAiProviderDependencyBarrier({ task: task(), history: [event({ type: 'TASK_CONTINUED' })], dependency: 'QWEN' }), null);
  assert.equal(resolveAiProviderDependencyBarrier({ task: task(), history: [event()], dependency: 'BOL_API' }), null);
});
