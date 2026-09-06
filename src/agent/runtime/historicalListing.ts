/**
 * The pre-cutover listing tier: every historical stream of a root, derived
 * from the transcript store's always-resident summary tier when a reader
 * subscribes (`SessionEventLog.memoryLayer`, `readListing`), never appended
 * to the log and never walked at graph open. The rows occupy the commit
 * space the log reserves below its first row, `HISTORICAL_COMMITS_PER_STREAM`
 * per historical stream in parents-first, older-first order, so `createdAt`
 * keeps the transcript's creation order, every log row outranks them under
 * the fold's per-key commit order, and a second replay of the same rows
 * folds nothing. Their seq is the row's 1-based position within its stream:
 * listing facts dedupe by commit, and no listing row moves `view.folded`.
 *
 * Historical means "existed when the graph opened": the membership is the
 * summary tier's key set taken once at the log's build, and a stream born
 * after that enters the view through its own `run.start` row alone. The
 * membership is what keeps the two tiers apart. A live stream's summary is
 * projected from that same row, so a replay between the projection and the
 * fold would otherwise mint it from here first, at commit 0, and its real
 * row would then land on a known stream and leave `createdAt` at 0, which
 * is a stream no renderer attached after open treats as new.
 */
import { createLog } from '@logger/logUtils';
import {
  aggregateId as qualifyAggregateId,
  USER_FOLLOW_UP_SUPPORT,
  type OwnerId,
  type SessionEvent,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import type { StreamLogStore } from '@transcript/StreamLogStore';

const log = createLog('historicalListing');

/** Whether the summary tier can list this stream: it names an execution
 *  and a category (a summary predating the mirror names neither). */
export function isHistoricalStream(
  transcripts: StreamLogStore,
  historical: ReadonlySet<StreamTabId>,
  streamId: StreamTabId,
): boolean {
  if (!historical.has(streamId)) return false;
  const meta = transcripts.getSummaryMeta(streamId);
  return meta?.executionId !== undefined && meta.agentCategory !== undefined;
}

/** The commits the log reserves per historical stream: one per listing
 *  fact a summary can carry (`run.start`, `run.config`, description). */
export const HISTORICAL_COMMITS_PER_STREAM = 3;

/**
 * The listing rows of every historical stream, parents before children and
 * older before newer, each stamped at its stream's own last write. Plain
 * code over the resident summary tier: no permit, no log row, no fiber step
 * per stream. Derived once per log, on the first read: the rows of a stream
 * the store no longer holds are dropped then, and a stream deleted later
 * leaves through its tombstone, which outranks its listing rows.
 */
export function historicalListing(
  transcripts: StreamLogStore,
  historical: ReadonlySet<StreamTabId>,
  ownerId: OwnerId,
): SessionEvent[] {
  return streamsParentsFirst(transcripts, historical).flatMap(
    (streamId, index) => {
      const drafts = historicalStream(transcripts, streamId);
      if (drafts === null) return [];
      const at = transcripts.getTimestampRange(streamId).last ?? Date.now();
      const base = index * HISTORICAL_COMMITS_PER_STREAM;
      return drafts.map(
        (draft, position): SessionEvent =>
          ({
            ...draft,
            seq: position + 1,
            commit: base + position + 1,
            ownerId,
            at,
          }) as SessionEvent,
      );
    },
  );
}

/** The summary tier's streams, parents before children and older before
 *  newer, so the fold's creation order is the transcript's: a child folded
 *  before its parent exists is re-rooted for good (PRD 5.2, `ancestors`). */
function streamsParentsFirst(
  transcripts: StreamLogStore,
  known: ReadonlySet<StreamTabId>,
): StreamTabId[] {
  // A stream deleted since the membership was taken has no summary left and
  // is not listed; the marker then folds its removal.
  let remaining = [...known]
    .filter((id) => transcripts.has(id))
    .sort(
      (a, b) =>
        (transcripts.getTimestampRange(a).first ?? 0) -
        (transcripts.getTimestampRange(b).first ?? 0),
    );
  const ordered: StreamTabId[] = [];
  const placed = new Set<StreamTabId>();
  while (remaining.length > 0) {
    const next = remaining.filter((id) => {
      const parent = transcripts.getSummaryMeta(id)?.parentStreamId;
      return !parent || !known.has(parent) || placed.has(parent);
    });
    if (next.length === 0) {
      // A parent cycle is a corrupt summary tier; import the rest as roots.
      log.warn(
        `Stream summaries form a parent cycle among ${remaining.join(', ')}; importing them as top-level streams`,
      );
      ordered.push(...remaining);
      break;
    }
    for (const id of next) placed.add(id);
    ordered.push(...next);
    remaining = remaining.filter((id) => !placed.has(id));
  }
  return ordered;
}

/**
 * Pre-cutover hydration: one historical stream's facts from the summary
 * tier alone. `run.start` carries the summary's identity (nullish where it
 * has none, contract C3), the launch facts the summary recorded, and the
 * description. The summary holds no status and no holder: a historical
 * stream's outcome is the cutover's event table, or it is not in the
 * listing; nothing here reads an execution record or a lease. A summary
 * that names no execution or no category predates the summary mirror and
 * is reported and skipped rather than given a fabricated launch fact.
 */
function historicalStream(
  transcripts: StreamLogStore,
  streamId: StreamTabId,
): SessionEventDraft[] | null {
  const meta = transcripts.getSummaryMeta(streamId);
  if (meta?.executionId === undefined) {
    log.warn(
      `Stream ${streamId} has no execution in its summary; not imported into the session view`,
    );
    return null;
  }
  if (meta.agentCategory === undefined) {
    log.warn(
      `Stream ${streamId} has no category in its summary; not imported into the session view`,
    );
    return null;
  }
  const { executionId } = meta;
  const parent = meta.parentStreamId;
  const drafts: SessionEventDraft[] = [
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('stream', streamId),
      executionId,
      identity: meta.identity ?? null,
      userFollowUpSupport:
        meta.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: meta.agentCategory,
      isRemote: false,
      worktree: null,
      parentStreamId:
        parent && transcripts.has(parent as StreamTabId) ? parent : null,
    },
  ];
  if (meta.model !== undefined || meta.command !== undefined) {
    drafts.push({
      type: 'run.config',
      aggregateId: qualifyAggregateId('stream', streamId),
      executionId,
      config: { model: meta.model, instruction: meta.command },
    });
  }
  if (meta.description) {
    drafts.push({
      type: 'updateStreamDescription',
      aggregateId: qualifyAggregateId('stream', streamId),
      description: meta.description,
    });
  }
  return drafts;
}
