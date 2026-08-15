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

import type { SessionHandle } from './SessionHandle';

/**
 * High enough that deliberate double-digit concurrent fan-out never queues,
 * low enough to stop a runaway recursive fan-out from opening unbounded
 * model conversations. The user-facing setting is recorded follow-up work.
 */
export const DEFAULT_CHILD_RUN_BUDGET = 16;

const budgets = new WeakMap<SessionHandle, PQueue>();

/**
 * The session's shared child-run budget. Passing `concurrency` re-pins the
 * live queue's limit — the seam a future user-facing setting (and today's
 * tests) adjust the budget through without replacing queued work.
 */
export function childRunBudgetFor(
  session: SessionHandle,
  concurrency?: number,
): PQueue {
  let queue = budgets.get(session);
  if (!queue) {
    queue = new PQueue({
      concurrency: concurrency ?? DEFAULT_CHILD_RUN_BUDGET,
    });
    budgets.set(session, queue);
  } else if (concurrency !== undefined) {
    queue.concurrency = concurrency;
  }
  return queue;
}
