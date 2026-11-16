/**
 * The /executions listing: every run in the session, most recent first,
 * each marked with where it stands relative to the caller and how much
 * input it has not read yet. Any listed tool-use run can be messaged
 * (tmux's `list-sessions`).
 *
 * Not `listRuns` in `@agent/storage/runListing`: that is the history list, the
 * runs a user started themselves, with their records. This one is the live
 * session's view of every run, for an agent to address.
 */

// Third-party imports
import { Effect, Predicate, SubscriptionRef } from 'effect';

// Local imports
import type { RunId } from '@shared/schemas';
import { type RunView } from '@shared/session/sessionView';
import { SessionViewAccess } from '@shared/session/runHistory';
import { executed } from '@tools/core/result';

// Local file imports
import { formatListingLine } from '../executionFormatters';
import { formatPaginationHint, paginateToolListing } from '../formatting';

/**
 * What `run` is to `caller`, in the caller's words, read from the lines
 * the view states on each run (`parentId`, `ancestors`); undefined for a
 * run on no line of the caller's and with no parent in common.
 */
function relationNoun(run: RunView, caller: RunView): string | undefined {
  if (caller.parentId === run.id) return 'orchestrator';
  if (run.parentId === caller.id) return 'subagent';
  if (caller.ancestors.some(({ id }) => id === run.id))
    return 'upstream orchestrator';
  if (run.ancestors.some(({ id }) => id === caller.id))
    return 'downstream subagent';
  return run.parentId !== null && run.parentId === caller.parentId
    ? 'sibling'
    : undefined;
}

/** The caller's session's runs, as the run asking (`caller`) relates to
 *  each. */
export const listExecutions = Effect.fn('listExecutions')(function* (
  caller: RunId | undefined,
  offset: number,
  limit: number,
) {
  const access = yield* SessionViewAccess;
  // One cold fold of the log's listing tier: every run's identity, model,
  // description, parentage and status, already decided. Nothing per row.
  const view = yield* access.read([]);
  const entries = [...view.runs.values()].toSorted(
    (left, right) =>
      right.launchedAt - left.launchedAt || right.createdAt - left.createdAt,
  );

  if (entries.length === 0) {
    return executed('No run history found.');
  }

  // Unread input is the live fold's: the listing tier carries no follow-ups.
  const live = SubscriptionRef.getUnsafe(access.ref).runs;
  const asking = caller === undefined ? undefined : view.runs.get(caller);
  const relationTo = (run: RunView): string | undefined => {
    if (run.id === caller) return '(you)';
    const noun = asking === undefined ? undefined : relationNoun(run, asking);
    return noun === undefined ? undefined : `(your ${noun})`;
  };
  const marks = (run: RunView): string => {
    const unread = live.get(run.id)?.queuedFollowUps.length ?? 0;
    return [relationTo(run), unread > 0 ? `unread=${unread}` : undefined]
      .filter(Predicate.isNotUndefined)
      .join('  ');
  };

  const { page, start, end, total } = paginateToolListing(
    entries,
    offset,
    limit,
  );

  return executed(
    `Executions (showing ${start}–${end} of ${total}, most recent first):\n\n${page.map((run) => formatListingLine(run, marks(run))).join('\n')}${formatPaginationHint(end, total)}`,
  );
});
