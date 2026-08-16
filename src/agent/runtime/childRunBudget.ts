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

/**
 * High enough that deliberate double-digit concurrent fan-out never queues,
 * low enough to stop a runaway recursive fan-out from opening unbounded
 * model conversations. The canonical value now lives in
 * `CHILD_RUN_CONCURRENCY_BUDGET_SETTING`; this re-export keeps the original
 * seam (and existing explicit-pin tests) authoritative.
 */
export const DEFAULT_CHILD_RUN_BUDGET =
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue;

const budgets = new WeakMap<SessionHandle, PQueue>();

/**
 * Queues whose limit was pinned by an explicit `concurrency` argument. Live
 * config reads must not re-pin these — the caller (today: the existing
 * explicit test seams) remains authoritative until it passes a new value.
 */
const callerPinned = new WeakSet<PQueue>();

function readConfiguredChildRunBudget(): number {
  return getValidatedConfig(
    CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
    ChildRunConcurrencyBudgetSchema,
    CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
  );
}

/**
 * The session's shared child-run budget.
 *
 * - First call: creates the queue at the configured value, or at `concurrency`
 *   when a caller explicitly pins it.
 * - Later call with `concurrency`: re-pins the live queue's limit.
 * - Later call without `concurrency`: re-reads the configured value and
 *   re-pins only queues the caller has not explicitly pinned. A mid-session
 *   settings change therefore takes effect on the next call to
 *   `childRunBudgetFor` (the next child-run launch for that session); existing
 *   loops sharing that queue then pick up the new limit on their subsequent
 *   turns, without replacing queued work or overriding an authoritative caller
 *   pin.
 */
export function childRunBudgetFor(
  session: SessionHandle,
  concurrency?: number,
): PQueue {
  const configured = readConfiguredChildRunBudget();
  let queue = budgets.get(session);
  if (!queue) {
    queue = new PQueue({
      concurrency: concurrency ?? configured,
    });
    budgets.set(session, queue);
    if (concurrency !== undefined) {
      callerPinned.add(queue);
    }
  } else if (concurrency !== undefined) {
    queue.concurrency = concurrency;
    callerPinned.add(queue);
  } else if (!callerPinned.has(queue)) {
    queue.concurrency = configured;
  }
  return queue;
}
