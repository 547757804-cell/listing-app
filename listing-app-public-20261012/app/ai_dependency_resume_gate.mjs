const parseTime = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Resolve readiness-after for a provider dependency wait. */
export function resolveAiProviderDependencyBarrier({ task, history = [], dependency } = {}) {
  const explicitAt = String(task?.required_readiness_after || '');
  if (parseTime(explicitAt) !== null) return { at: explicitAt, source: 'TASK_REQUIRED_READINESS_AFTER' };

  const normalizedDependency = String(dependency || '').toUpperCase();
  if (!['QWEN', 'DEEPSEEK'].includes(normalizedDependency)
      || task?.status !== 'WAITING_DEPENDENCY'
      || String(task?.waiting_dependency_key || '').toUpperCase() !== normalizedDependency) return null;

  const latest = Array.isArray(history) ? history.at(-1) : null;
  if (!latest || !['LISTING_AI_PROVIDER_DEPENDENCY_WAITING', 'LISTING_AI_EXECUTION_WAITING'].includes(String(latest.type || ''))
      || latest.current_step !== task.current_step
      || String(latest.details?.dependency || '').toUpperCase() !== normalizedDependency) return null;

  const eventAt = String(latest.at || '');
  const eventMs = parseTime(eventAt);
  const updatedMs = parseTime(task.updated_at);
  if (eventMs === null || updatedMs === null || eventMs !== updatedMs) return null;
  return { at: eventAt, source: 'EXACT_CURRENT_WAIT_EVENT' };
}

export function isProviderReadinessAfterBarrier(checkedAt, barrierAt) {
  const checked = parseTime(checkedAt);
  const barrier = parseTime(barrierAt);
  return checked !== null && barrier !== null && checked > barrier;
}

