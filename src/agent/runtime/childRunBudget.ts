import * as os from 'node:os';
import { Effect } from 'effect';
/**
 * One child-run concurrency budget per session: the cap on concurrently live
 * native child model conversations, one semaphore held by the session's runs
 * (`RunRegistry.childRunBudget`). Design and rulings (what is budgeted,
 * what inherits, why the child-run loop is the single acquisition boundary):
 * `.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`.
 *
 * Root runs, agent-CLI children, and in-band children (which run while their
 * parent is blocked awaiting them, so physical concurrency is unchanged)
 * never acquire. Acquisition queues rather than rejects: a launch beyond the
 * budget starts as soon as a slot frees, and a queued turn cancelled before
 * its slot never starts fresh model work.
 */

import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
} from '@shared/schemas';
import { readSettingFrom } from '@utils/config/platformSettings';

import type { RunRegistry } from './runRegistry';
import type { SessionHandle } from './SessionHandle';

/**
 * The configured budget with the `auto` sentinel resolved to this machine's
 * core count, clamped to the schema range. Model conversations are network
 * bound, so the core count is a floor for useful parallelism rather than a
 * ceiling — which is why the setting stays overridable up to `max`. This is
 * the one host-side owner of the number: the session's semaphore below and
 * the workflow engine's per-run semaphore (`workflowScriptStrategy`) both
 * read it here. Resolved host-side because `src/shared` is loaded by the settings
 * webview and must stay free of `node:os`.
 */
export const resolveChildRunConcurrencyBudget = Effect.fn(
  'resolveChildRunConcurrencyBudget',
)(function* (stores: SettingsStores) {
  const configured = yield* readSettingFrom<number>(
    stores,
    CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  );
  if (configured !== CHILD_RUN_CONCURRENCY_BUDGET_SETTING.auto) {
    return configured;
  }
  return Math.min(
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max,
    Math.max(1, os.availableParallelism()),
  );
});

/**
 * The session's shared child-run budget at the configured value, read in the
 * session's scope: the session's runs hold the one semaphore
 * (`RunRegistry.childRunBudget`) and re-pin it here on every launch.
 */
export const childRunBudgetFor = Effect.fn('childRunBudgetFor')(function* (
  session: SessionHandle,
  runs: RunRegistry,
) {
  return yield* runs.childRunBudget(
    yield* resolveChildRunConcurrencyBudget(session.roots),
  );
});
