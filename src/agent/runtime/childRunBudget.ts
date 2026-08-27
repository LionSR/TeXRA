/**
 * One child-run concurrency budget per session: the cap on concurrently live
 * native child model conversations. Design and rulings (what is budgeted,
 * what inherits, why the child-run loop is the single acquisition boundary):
 * `docs/proposals/2026-08-15-child-run-concurrency-budget.md`.
 *
 * Root runs, agent-CLI children, and in-band children (which run while their
 * parent is blocked awaiting them, so physical concurrency is unchanged)
 * never acquire. Acquisition queues rather than rejects: a launch beyond the
 * budget starts as soon as a slot frees, and a queued turn cancelled before
 * its slot never starts fresh model work.
 */
import PQueue from 'p-queue';

import {
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  ChildRunConcurrencyBudgetSchema,
} from '@shared/schemas';
import { getValidatedConfig } from '@utils/config/configUtils';

import type { SessionHandle } from './SessionHandle';

const budgets = new WeakMap<SessionHandle, PQueue>();

function readConfiguredChildRunBudget(): number {
  return getValidatedConfig(
    CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
    ChildRunConcurrencyBudgetSchema,
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
  );
}

/**
 * The session's shared child-run budget, created at the configured value on
 * first call and re-pinned to it on every later call. A mid-session settings
 * change therefore takes effect on the next call to `childRunBudgetFor` (the
 * next child-run launch for that session); existing loops sharing that queue
 * then pick up the new limit on their subsequent turns, without replacing
 * queued work.
 */
export function childRunBudgetFor(session: SessionHandle): PQueue {
  const configured = readConfiguredChildRunBudget();
  const existing = budgets.get(session);
  if (existing) {
    existing.concurrency = configured;
    return existing;
  }
  const queue = new PQueue({ concurrency: configured });
  budgets.set(session, queue);
  return queue;
}
