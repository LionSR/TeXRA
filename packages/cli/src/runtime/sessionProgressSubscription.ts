import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import type { ProcessRuntime } from '@platform/processRuntime';
import { runIdentityName, type RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';
import { writeNdjsonStdout } from './logSinks';

export type CliNdjsonProgressRecordWriter = (record: CliNdjsonRecord) => void;

/**
 * One live child on the `run.children` record, from the fold's own row. The
 * status is the fold's (`RunPhase`, or `ready` before the child's
 * `run.activate` folds), not a launcher's optimistic reading of it.
 */
function childRow(child: RunView) {
  return {
    childRunId: child.id,
    agentName: runIdentityName(child.identity),
    identity: child.identity,
    status: child.status,
  };
}

/**
 * Headless CLI progress output. Every display row the session commits goes
 * out as one `kind: "progress"` record whose `event` is the row's `type` and
 * whose `payload` is the rest of the row, field names untouched: the CLI
 * contract is a versioned projection of `SessionEvent`, not a second
 * vocabulary (`contract: 2`, stamped by the NDJSON sink).
 *
 * It reads `events.all(session.now())` directly (PRD 10.3): every event
 * above the current ordinal in commit order, never the view, so a
 * `stage.start` no surface subscribed to still becomes its line and two
 * same-type updates never collapse.
 *
 * The one record that is not an event is `run.children`, a parent's live
 * child roster. It is derived from the fold — the parent's `childIds` and
 * each child's own `RunView` — on every level the fold publishes, and
 * written only when that derivation changes, so it carries no channel of its
 * own. It is ordered against the lines by the fold's own cursor: a view that
 * has folded past the tail's last written row waits for the tail, so a
 * roster never precedes a row it already reports. Like the tail, it is scoped
 * to the attach boundary: the rosters the fold holds at attach seed the
 * comparison without being written, so a resumed session does not replay
 * its earlier parents.
 *
 * Detaching drains: the tail runs to the ordinal captured at detach, so the
 * last line published before the run settled is on the wire before the
 * caller writes its result record, and the roster is derived once more from
 * the drained fold. The drain waits on the tail's own coordinate
 * (`SessionEvents.all`'s `drained`), not on the events: a transcript row the
 * store no longer holds emits nothing, and the ordinal captured at detach may
 * be exactly that row's.
 *
 * The tail and its coordinate are fibers of the process runtime the caller
 * holds: this projection lives for the length of one headless run, so it
 * takes that runtime once here rather than looking it up per fork.
 */
export function attachCliSessionProgressProjection(
  runtime: ProcessRuntime,
  session: Pick<SessionHandle, 'events' | 'now' | 'view'>,
  writeRecord: CliNdjsonProgressRecordWriter = writeNdjsonStdout,
): () => Effect.Effect<void> {
  function emit(event: string, payload: unknown): void {
    writeRecord({
      kind: 'progress',
      event,
      ts: new Date().toISOString(),
      payload,
    });
  }

  /** The last commit the tail passed. */
  let delivered = session.now();
  /** The ordinal detach cut at; nothing above it is written. */
  let stopAt: number | undefined;
  const drained = Deferred.makeUnsafe<void>();

  /** The ordinal the projection attached at: the tail's own boundary. */
  const attachedAt = delivered;
  /** The roster last derived per parent, so an unchanged one writes no line.
   *  A fold level at or below `attachedAt` only seeds it: a resumed session's
   *  earlier parents, settled or not, are history the tail does not replay
   *  either, so only a roster a post-attach row changes is written. */
  const writtenRosters = new Map<RunId, string>();
  /** A fold ahead of the tail: its roster waits for the lines that produced
   *  it, so a roster never precedes the row it reports. */
  let rosterPending = false;
  const emitRosters = (): void => {
    const view = SubscriptionRef.getUnsafe(session.view);
    rosterPending = view.cursor > delivered;
    if (rosterPending) return;
    for (const [parentRunId, run] of view.runs) {
      // A parent whose roster emptied still owes its closing line; one that
      // never had a child owes nothing.
      if (run.childIds.length === 0 && !writtenRosters.has(parentRunId))
        continue;
      const children = run.childIds.flatMap((childId) => {
        const child = view.runs.get(childId);
        // A live child only: the roster reports who is still going, and a
        // child that ended carries its outcome on its own `run.end` line.
        return child === undefined || isTerminalOutcomePhase(child.status)
          ? []
          : [childRow(child)];
      });
      const wire = JSON.stringify(children);
      if (writtenRosters.get(parentRunId) === wire) continue;
      writtenRosters.set(parentRunId, wire);
      if (view.cursor > attachedAt)
        emit('run.children', { runId: parentRunId, children });
    }
  };
  // Seed from the fold as it stands at attach, before any fiber can see a
  // later level: the plane's ordinal bounds the fold, so this writes nothing.
  emitRosters();

  const settleIfDrained = (): void => {
    if (stopAt === undefined || delivered < stopAt) return;
    // `stopAt` is the plane's ordinal, which no fold can be past, so the
    // roster gate is open here and the last one goes out with the drain.
    emitRosters();
    Deferred.doneUnsafe(drained, Effect.void);
  };
  const passed = (commit: number): void => {
    delivered = Math.max(delivered, commit);
    if (rosterPending) emitRosters();
    settleIfDrained();
  };

  // The tail's coordinate: set to the commit each forward read covered once
  // that read's events have all been handled below, so a value here never
  // runs ahead of an event this fiber has yet to write.
  const drainedTo = runtime.runSync(SubscriptionRef.make(delivered));
  const fiber = runtime.runFork(
    Stream.runForEach(session.events.all(delivered, drainedTo), (event) =>
      Effect.sync(() => {
        if (stopAt !== undefined && event.commit > stopAt) return;
        const { type, ...payload } = event;
        emit(type, payload);
        passed(event.commit);
      }),
    ),
  );
  const coordinateFiber = runtime.runFork(
    Stream.runForEach(SubscriptionRef.changes(drainedTo), (commit) =>
      Effect.sync(() => passed(commit)),
    ),
  );
  // The roster's own source: the fold, whose every level is a candidate.
  const rosterFiber = runtime.runFork(
    Stream.runForEach(SubscriptionRef.changes(session.view), () =>
      Effect.sync(emitRosters),
    ),
  );

  return () =>
    Effect.gen(function* () {
      const first = stopAt === undefined;
      if (first) {
        stopAt = session.now();
        settleIfDrained();
      }
      yield* Deferred.await(drained);
      if (!first) return;
      runtime.runFork(Fiber.interrupt(fiber));
      runtime.runFork(Fiber.interrupt(coordinateFiber));
      runtime.runFork(Fiber.interrupt(rosterFiber));
    });
}
