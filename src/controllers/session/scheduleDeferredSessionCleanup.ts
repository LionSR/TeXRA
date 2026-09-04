import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createSessionStores } from '@controllers/session/createSessionStores';
import { createLog } from '@logger/logUtils';
import {
  RUN_OUTCOME,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('DeferredSessionCleanup');

/**
 * Long enough for a host's first paint and its first burst of run wiring to
 * land before the cleanup touches storage, short enough that a leftover shell
 * does not sit in the rail for a user-visible stretch.
 */
const DEFAULT_CLEANUP_DELAY_MS = 1500;

/** Streams this process is running right now, by handle or by in-flight phase. */
function runningStreams(session: SessionHandle): Set<StreamTabId> {
  const running = new Set<StreamTabId>();
  for (const handle of session.executions.getAgentHandles()) {
    running.add(handle.childStreamId);
  }
  for (const [stream, state] of session.status.getAllStreamStates()) {
    if (isInFlightPhase(state.phase)) running.add(stream);
  }
  return running;
}

/**
 * Drop the background shells a previous process left behind and the persisted
 * state no live stream refers to.
 *
 * A leftover shell is a stream a presentation may already be showing (a
 * persisted shell hydrates with no status, so no rail filter hides it), and
 * nothing repaints a rail for a deletion the store made on its own. So each
 * swept shell is published as the `removeStream` fact every host already
 * projects; the deletion the fact triggers is a no-op on state the sweep has
 * already removed, and the applier's removal barrier makes a repeat removal on
 * the same incarnation idempotent.
 */
async function sweepLeftoverStreams(session: SessionHandle): Promise<void> {
  const sweptStreams = await createSessionStores(session).sweepLeftoverStreams({
    runningStreams: runningStreams(session),
  });
  for (const streamId of sweptStreams) {
    session.events.emit({
      scope: 'session',
      event: { type: 'removeStream', payload: { streamId } },
    });
  }
}

/**
 * Close the transcript groups and streaming-text entries a host that died
 * mid-run left open, so they render as their normal ended banners instead of
 * as in-progress forever (#7276).
 *
 * This is a WRITE over a shared transcript file, so it is gated on proof that
 * no process is still producing the stream: the candidate set is bounded by
 * the always-resident summaries (streams with unfinished output that this
 * process is not running), those candidates are hydrated, and the run tuple
 * hydration leaves behind decides. An unreadable authority proves nothing and
 * a held lease says another host owns the run, so both are skipped and their
 * transcripts left exactly as their owner is writing them. A candidate with no
 * run facts at all never recorded an execution, so its unclosed transcript is
 * the only fact there is and closing it is the honest reading.
 */
async function settleOrphanedRunningOutput(
  session: SessionHandle,
): Promise<void> {
  const notRunningHere = (stream: StreamTabId): boolean =>
    !isInFlightPhase(session.status.get(stream));
  const candidates = session.transcripts
    .keys()
    .filter(
      (stream) =>
        session.transcripts.hasUnfinishedOutput(stream) &&
        notRunningHere(stream),
    );
  if (candidates.length === 0) return;
  await session.snapshots.preload(candidates);

  // Grouped by the outcome each stream is settled as — the persisted one when
  // the run finalized, CANCELLED for the interruption otherwise — because the
  // store settles one batch per status.
  const byOutcome = new Map<RunOutcome, StreamTabId[]>();
  for (const stream of candidates) {
    // Re-read after the hydration await: a run may have started meanwhile.
    if (!notRunningHere(stream)) continue;
    const run = session.snapshots.getRunPhaseFacts(stream);
    if (run?.authorityFailure !== undefined) continue;
    if (run?.lease && run.lease.status !== 'free') continue;
    const outcome = run?.outcome ?? RUN_OUTCOME.CANCELLED;
    byOutcome.set(outcome, [...(byOutcome.get(outcome) ?? []), stream]);
  }

  let settled = 0;
  for (const [outcome, streams] of byOutcome) {
    // StreamLogStore commits each settlement through its onChange channel, so
    // attached progress bridges receive dirty-entry deltas without a
    // host-specific full-view refresh.
    settled += (
      await session.transcripts.endRunningGroupsForStreams(
        streams,
        Date.now(),
        outcome,
      )
    ).length;
  }
  if (settled > 0) await session.transcripts.flush();
}

/**
 * Run this session's post-restart cleanup once, after this host's UI is up.
 *
 * Both steps read storage — the leftover-stream sweep reads the whole storage
 * root, which put 2 to 15 s in front of every host's first prompt while it was
 * awaited at bring-up — and neither owes the user anything that cannot wait a
 * beat. So they run off the ready path, on an unref'd timer no host awaits: a
 * process that exits before the timer fires simply leaves the work for the
 * next launch.
 *
 * Deferring the sweep means it can overlap live runs, which the boot-only
 * version could not. The streams this process is running are therefore
 * excluded from it (see `SessionStores.sweepLeftoverStreams`), so no deletion
 * ever queues behind a live execution lane. The settle runs after it for the
 * same reason it is gated on the run tuple: nothing should be closed on a
 * stream the sweep is about to delete or another process is still writing.
 *
 * One caller per session schedules it, once, at that host's bring-up; there
 * is no memo here that would swallow a second call, so a cancelled schedule
 * can simply be scheduled again.
 *
 * @returns A cancel for the pending cleanup. Register it on session teardown;
 *   it is a no-op once the cleanup has started.
 */
export function scheduleDeferredSessionCleanup(
  session: SessionHandle,
  options?: { readonly delayMs?: number },
): () => void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await sweepLeftoverStreams(session);
      } catch (error) {
        log.warn(
          `The leftover-stream sweep did not finish: ${toErrorMessage(error)}`,
          { data: error },
        );
      }
      try {
        await settleOrphanedRunningOutput(session);
      } catch (error) {
        log.warn(
          `Transcript output left open by an earlier process was not settled: ${toErrorMessage(error)}`,
          { data: error },
        );
      }
    })();
  }, options?.delayMs ?? DEFAULT_CLEANUP_DELAY_MS);
  // Never hold a host's process open for the cleanup.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return () => clearTimeout(timer);
}
