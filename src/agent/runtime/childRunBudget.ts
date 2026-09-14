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
import * as os from 'node:os';

import {
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  ChildRunConcurrencyBudgetSchema,
} from '@shared/schemas';
import { getValidatedConfig } from '@utils/config/configUtils';

import { runInSession } from './RunContext';
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
export function resolveChildRunConcurrencyBudget(): number {
  const configured = getValidatedConfig(
    CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
    ChildRunConcurrencyBudgetSchema,
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
  );
  if (configured !== CHILD_RUN_CONCURRENCY_BUDGET_SETTING.auto) {
    return configured;
  }
  return Math.min(
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.max,
    Math.max(1, os.availableParallelism()),
  );
}

/**
 * The session's shared child-run budget at the configured value, read in the
 * session's scope: the session's runs hold the one semaphore
 * (`RunRegistry.childRunBudget`) and re-pin it here on every launch.
 */
export function childRunBudgetFor(session: SessionHandle, runs: RunRegistry) {
  return runs.childRunBudget(
    runInSession(session, resolveChildRunConcurrencyBudget),
  );
}
