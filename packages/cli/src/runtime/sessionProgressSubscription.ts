import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { effectRuntime } from '@platform/processRuntime';
import type { ActiveChildInfo, RunId } from '@shared/schemas';
import { writeNdjsonStdout } from './logSinks';

export type CliNdjsonProgressRecordWriter = (record: CliNdjsonRecord) => void;

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
 * same-type updates never collapse. The child roster is the one line with no
 * durable event behind it: the roster is process-local registry state
 * (contract C3) and reaches this projection through the registry's
 * `onChildActivity` listener, as the `run.children` record. It is written in
 * publish order all the same: a roster observed at ordinal N follows every
 * event committed at or below N, so it waits for the tail to deliver N and
 * goes out before anything committed after it.
 *
 * Detaching drains: the tail runs to the ordinal captured at detach, so the
 * last line published before the run settled is on the wire before the
 * caller writes its result record. The drain waits on the tail's own
 * coordinate (`SessionEvents.all`'s `drained`), not on the events: a
 * transcript row the store no longer holds emits nothing, and the ordinal
 * captured at detach may be exactly that row's.
 */
export function attachCliSessionProgressProjection(
  session: Pick<SessionHandle, 'events' | 'now'> & {
    readonly runs: Pick<SessionHandle['runs'], 'onChildActivity'>;
  },
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

  /** The last commit the tail passed; rosters observed above it wait. */
  let delivered = session.now();
  /** The ordinal detach cut at; nothing above it is written. */
  let stopAt: number | undefined;
  const heldRosters: Array<{
    readonly at: number;
    readonly runId: RunId;
    readonly children: readonly ActiveChildInfo[];
  }> = [];
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  const emitRoster = (runId: RunId, children: readonly ActiveChildInfo[]) =>
    emit('run.children', { runId, children });
  const flushRosters = (upTo: number): void => {
    while (heldRosters.length > 0 && heldRosters[0]!.at <= upTo) {
      const roster = heldRosters.shift()!;
      emitRoster(roster.runId, roster.children);
    }
  };
  const settleIfDrained = (): void => {
    if (stopAt === undefined || delivered < stopAt) return;
    flushRosters(stopAt);
    resolveDrained();
  };
  const passed = (commit: number): void => {
    delivered = Math.max(delivered, commit);
    flushRosters(delivered);
    settleIfDrained();
  };

  // The tail's coordinate: set to the commit each forward read covered once
  // that read's events have all been handled below, so a value here never
  // runs ahead of an event this fiber has yet to write.
  const drainedTo = effectRuntime().runSync(SubscriptionRef.make(delivered));
  const fiber = effectRuntime().runFork(
    Stream.runForEach(session.events.all(delivered, drainedTo), (event) =>
      Effect.sync(() => {
        if (stopAt !== undefined && event.commit > stopAt) return;
        const { type, ...payload } = event;
        emit(type, payload);
        passed(event.commit);
      }),
    ),
  );
  const coordinateFiber = effectRuntime().runFork(
    Stream.runForEach(SubscriptionRef.changes(drainedTo), (commit) =>
      Effect.sync(() => passed(commit)),
    ),
  );
  const detachRosters = session.runs.onChildActivity((runId, children) => {
    const at = session.now();
    if (at <= delivered) emitRoster(runId, children);
    else heldRosters.push({ at, runId, children });
  });

  return async () => {
    if (stopAt !== undefined) return drained;
    detachRosters();
    stopAt = session.now();
    settleIfDrained();
    await drained;
    effectRuntime().runFork(Fiber.interrupt(fiber));
    effectRuntime().runFork(Fiber.interrupt(coordinateFiber));
  };
}
