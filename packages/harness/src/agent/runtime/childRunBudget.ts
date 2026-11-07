import * as os from 'node:os';
import { Context, Effect, Semaphore } from 'effect';
/**
 * One child-run concurrency budget per session: the cap on concurrently live
 * native child model conversations, one semaphore the session layer
 * provides ({@link ChildRunBudget}). Design and rulings (what is budgeted,
 * what inherits):
 * `.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`.
 *
 * Root runs, process children, and awaited children (which run while their
 * parent is blocked awaiting them, so physical concurrency is unchanged)
 * never acquire; a run's awaited calls are bounded by its own semaphore of
 * the same size (`AgentRun.awaitedCalls`). Acquisition queues rather than
 * rejects: a launch beyond the budget starts as soon as a slot frees, and a
 * queued run cancelled before its slot never starts model work.
 */

import { Settings, type SettingsStores } from '@shared/config/settings';
import {
  CHILD_RUN_CONCURRENCY_BUDGET_RANGE,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
} from '@shared/state/stateSettings';

/**
 * The configured budget with the `auto` sentinel resolved to this machine's
 * core count, clamped to the schema range. Model conversations are network
 * bound, so the core count is a floor for useful parallelism rather than a
 * ceiling, which is why the setting stays overridable up to `max`. This is
 * the one host-side owner of the number: the session layer sizes its
 * semaphore here. Resolved host-side because `src/shared` is loaded by the
 * settings webview and must stay free of `node:os`.
 */
export const resolveChildRunConcurrencyBudget = Effect.fn(
  'resolveChildRunConcurrencyBudget',
)(function* (stores: SettingsStores) {
  const configured = yield* Settings.get(
    stores,
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  );
  if (configured !== CHILD_RUN_CONCURRENCY_BUDGET_RANGE.auto) {
    return configured;
  }
  return Math.min(
    CHILD_RUN_CONCURRENCY_BUDGET_RANGE.max,
    Math.max(1, os.availableParallelism()),
  );
});

/**
 * The session's child-run budget: the permits background children of the
 * session's runs take around their loops, one each, so a swarm of
 * delegations runs at most this many model conversations at once. The
 * session layer sizes it from the setting at open
 * (`resolveChildRunConcurrencyBudget`); with none provided, it is
 * unlimited.
 */
export const ChildRunBudget = Context.Reference<Semaphore.Semaphore>(
  '@texra-ai/harness/session/ChildRunBudget',
  { defaultValue: () => Semaphore.makeUnsafe(Number.MAX_SAFE_INTEGER) },
);
