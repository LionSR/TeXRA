import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

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
 * child roster. It is derived from the fold beside each row — the parent's
 * `childIds` and each child's own `RunView` — and written when that
 * derivation changes, so it needs no second channel and no ordering
 * machinery: the roster a line reports is the state the fold held when the
 * preceding row went out.
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
): () => Promise<void> {
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
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  /** The roster last written per parent, so an unchanged one writes no line. */
  const writtenRosters = new Map<RunId, string>();
  const emitRosters = (): void => {
    const view = SubscriptionRef.getUnsafe(session.view);
    for (const [runId, run] of view.runs) {
      // A parent whose roster emptied still owes its closing line; one that
      // never had a child owes nothing.
      if (run.childIds.length === 0 && !writtenRosters.has(runId)) continue;
      const children: Array<ReturnType<typeof childRow>> = [];
      for (const childId of run.childIds) {
        const child = view.runs.get(childId);
        // A live child only: the roster reports who is still going, and a
        // child that ended keeps its own `run.end` line.
        if (child === undefined || isTerminalOutcomePhase(child.status))
          continue;
        children.push(childRow(child));
      }
      const wire = JSON.stringify(children);
      if (writtenRosters.get(runId) === wire) continue;
      writtenRosters.set(runId, wire);
      emit('run.children', { runId, children });
    }
  };

  const settleIfDrained = (): void => {
    if (stopAt === undefined || delivered < stopAt) return;
    emitRosters();
    resolveDrained();
  };
  const passed = (commit: number): void => {
    delivered = Math.max(delivered, commit);
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
        emitRosters();
        passed(event.commit);
      }),
    ),
  );
  const coordinateFiber = runtime.runFork(
    Stream.runForEach(SubscriptionRef.changes(drainedTo), (commit) =>
      Effect.sync(() => passed(commit)),
    ),
  );

  return async () => {
    if (stopAt !== undefined) return drained;
    stopAt = session.now();
    settleIfDrained();
    await drained;
    runtime.runFork(Fiber.interrupt(fiber));
    runtime.runFork(Fiber.interrupt(coordinateFiber));
  };
}
