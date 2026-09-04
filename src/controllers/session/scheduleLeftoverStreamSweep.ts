import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createSessionStores } from '@controllers/session/createSessionStores';
import { createLog } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('LeftoverStreamSweep');

/**
 * Long enough for a host's first paint and its first burst of run wiring to
 * land before the sweep touches storage, short enough that a leftover shell
 * does not sit in the rail for a user-visible stretch.
 */
const DEFAULT_SWEEP_DELAY_MS = 1500;

/** Sessions that already own a scheduled sweep, cancelled or not. */
const scheduledSessions = new WeakSet<SessionHandle>();

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
 * Run the session's leftover-stream sweep once, after this host's UI is up.
 *
 * The sweep reads the whole storage root, so awaiting it at bring-up put 2 to
 * 15 s in front of every host's first prompt. It owes the user nothing that
 * cannot wait a beat: it drops background shells a previous process left
 * behind and persisted state no live stream refers to. So it runs off the
 * ready path, on an unref'd timer no host awaits — a process that exits before
 * the timer fires simply leaves the work for the next launch.
 *
 * Deferring it means the sweep can overlap live runs, which the boot-only
 * version could not. The streams this process is running are therefore
 * excluded from it (see `SessionStores.sweepLeftoverStreams`), so no deletion
 * ever queues behind a live execution lane.
 *
 * At most one sweep per session: the second caller gets a cancel that does
 * nothing rather than a second pass over the executions directory.
 *
 * A leftover shell is a stream a presentation may already be showing (a
 * persisted shell hydrates with no status, so no rail filter hides it), and
 * nothing repaints a rail for a deletion the store made on its own. So each
 * swept shell is published as the `removeStream` fact every host already
 * projects; the deletion the fact triggers is a no-op on state the sweep has
 * already removed, and the applier's removal barrier makes a repeat removal on
 * the same incarnation idempotent.
 *
 * @returns A cancel for the pending sweep. Register it on session teardown; it
 *   is a no-op once the sweep has started.
 */
export function scheduleLeftoverStreamSweep(
  session: SessionHandle,
  options?: { readonly delayMs?: number },
): () => void {
  if (scheduledSessions.has(session)) return () => {};
  scheduledSessions.add(session);
  const timer = setTimeout(() => {
    void createSessionStores(session)
      .sweepLeftoverStreams({ runningStreams: runningStreams(session) })
      .then((sweptStreams) => {
        for (const streamId of sweptStreams) {
          session.events.emit({
            scope: 'session',
            event: { type: 'removeStream', payload: { streamId } },
          });
        }
      })
      .catch((error: unknown) => {
        log.warn(
          `The leftover-stream sweep did not finish: ${toErrorMessage(error)}`,
          { data: error },
        );
      });
  }, options?.delayMs ?? DEFAULT_SWEEP_DELAY_MS);
  // Never hold a host's process open for the sweep.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return () => clearTimeout(timer);
}
