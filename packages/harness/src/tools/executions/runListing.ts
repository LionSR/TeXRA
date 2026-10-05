/**
 * The /executions listing: every run in the session, most recent first,
 * each marked with where it stands relative to the caller and how much
 * input it has not read yet. Any listed tool-use run can be messaged
 * (tmux's `list-sessions`).
 */

// Third-party imports
import { Effect, SubscriptionRef } from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId, RunRelation } from '@shared/schemas';
import { runRelation } from '@shared/session/runRelation';
import type { RunView } from '@shared/session/sessionView';
import { executed } from '@tools/core/result';

// Local file imports
import { formatListingLine } from '../executionFormatters';
import { formatPaginationHint, paginateToolListing } from '../formatting';

/** What a listed run is to the caller, in the caller's words. */
const RELATION_NOUN: Record<Exclude<RunRelation, 'peer'>, string> = {
  parent: 'orchestrator',
  child: 'subagent',
  ancestor: 'upstream orchestrator',
  descendant: 'downstream subagent',
  sibling: 'sibling',
};

export const listRuns = Effect.fn('ExecutionsTool.listRuns')(function* (
  session: SessionHandle,
  caller: RunId | undefined,
  offset: number,
  limit: number,
) {
  // One cold fold of the log's listing tier: every run's identity, model,
  // description, parentage and status, already decided. Nothing per row.
  const view = yield* session.readView([]);
  const entries = [...view.runs.values()].toSorted(
    (left, right) =>
      right.launchedAt - left.launchedAt || right.createdAt - left.createdAt,
  );

  if (entries.length === 0) {
    return executed('No run history found.');
  }

  // Unread input is the live fold's: the listing tier carries no follow-ups.
  const { queuedFollowUps } = SubscriptionRef.getUnsafe(session.view);
  const parentOf = (id: RunId) => view.runs.get(id)?.parentId;
  const relationTo = (run: RunView): string | undefined => {
    if (caller === undefined) return undefined;
    if (run.id === caller) return '(you)';
    const relation = runRelation(run.id, caller, parentOf);
    return relation === 'peer'
      ? undefined
      : `(your ${RELATION_NOUN[relation]})`;
  };
  const marks = (run: RunView): string => {
    const unread = queuedFollowUps.get(run.id)?.length ?? 0;
    return [relationTo(run), unread > 0 ? `unread=${unread}` : undefined]
      .filter((mark) => mark !== undefined)
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
