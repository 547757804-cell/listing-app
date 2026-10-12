import { TASK_AUTO_MUTATION_ENABLED, assertBusinessDispatchEnabled } from './runtime_mode.mjs';

/** Provider-isolated concurrency pools. Limits can change while the service is running. */
export class AiWorkerPool {
  constructor(limits = {}) {
    this.limits = new Map();
    this.active = new Map();
    this.queues = new Map();
    this.configure(limits);
  }

  configure(limits = {}) {
    for (const [provider, rawLimit] of Object.entries(limits)) {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 1;
      this.limits.set(provider, limit);
      this.active.set(provider, this.active.get(provider) || 0);
      this.queues.set(provider, this.queues.get(provider) || []);
      this.#drain(provider);
    }
  }

  async run(provider, work, dispatchContext = {}) {
    assertBusinessDispatchEnabled('AI Worker Pool dispatch', dispatchContext);
    if (!this.limits.has(provider)) this.configure({ [provider]: 1 });
    // A validated acceptance manual-Continue scope is intentionally narrower
    // than global dispatch. Execute its provider work inline under the same
    // per-provider concurrency limit; the normal scheduler remains disabled.
    // assertBusinessDispatchEnabled only permits this branch while the exact
    // SKU/dataRoot AsyncLocalStorage scope is active.
    if (!TASK_AUTO_MUTATION_ENABLED) {
      const active = this.active.get(provider) || 0;
      const limit = this.limits.get(provider) || 1;
      if (active >= limit) {
        throw Object.assign(new Error('Provider worker capacity is unavailable for this scoped manual action.'), {
          code: 'AI_WORKER_CAPACITY_UNAVAILABLE', provider,
        });
      }
      this.active.set(provider, active + 1);
      try { return await work(); }
      finally { this.active.set(provider, Math.max(0, (this.active.get(provider) || 1) - 1)); }
    }
    await new Promise((resolve, reject) => {
      this.queues.get(provider).push({ resolve, reject });
      this.#drain(provider);
    });
    try { return await work(); }
    finally {
      this.active.set(provider, Math.max(0, (this.active.get(provider) || 1) - 1));
      this.#drain(provider);
    }
  }

  activeCount(provider) { return this.active.get(provider) || 0; }
  queueCount(provider) { return this.queues.get(provider)?.length || 0; }

  #drain(provider) {
    if (!TASK_AUTO_MUTATION_ENABLED) return;
    const queue = this.queues.get(provider) || [];
    const limit = this.limits.get(provider) || 1;
    while (queue.length && (this.active.get(provider) || 0) < limit) {
      this.active.set(provider, (this.active.get(provider) || 0) + 1);
      queue.shift().resolve();
    }
  }
}
