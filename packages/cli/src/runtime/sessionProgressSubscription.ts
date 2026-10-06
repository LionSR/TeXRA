import {
  Deferred,
  Effect,
  Fiber,
  LogLevel,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { runIdentityName, type RunId } from '@shared/schemas';
import { isLiveRun, type RunView } from '@shared/session/sessionView';
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
 * It reads `log.tail(session.log.now())` directly (PRD 10.3): every event
 * above the current ordinal in commit order, never the view, so a
 * `stage.start` no surface subscribed to still becomes its line and two
 * same-type updates never collapse.
 *
 * The one record that is not an event is `run.children`, a parent's live
 * child list. It is derived from the fold — the parent's `childIds` and
 * each child's own `RunView` — on every level the fold publishes, and
 * written only when that derivation changes, so it carries no channel of its
 * own. It is ordered against the lines by the fold's own cursor: a view that
 * has folded past the tail's last written row waits for the tail, so a
 * child list never precedes a row it already reports. Like the tail, it is scoped
 * to the attach boundary: the child lists the fold holds at attach seed the
 * comparison without being written, so a resumed session does not replay
 * its earlier parents.
 *
 * Detaching drains: the tail runs to the ordinal captured at detach, so the
 * last line published before the run settled is on the wire before the
 * caller writes its result record, and the child list is derived once more from
 * the drained fold. The drain waits on the tail's own coordinate
 * (`SessionEvents.all`'s `drained`), not on the events: a transcript row the
 * store no longer holds emits nothing, and the ordinal captured at detach may
 * be exactly that row's.
 *
 * The tail, its coordinate and the child list are child fibers of the fiber that
 * attaches: the projection lives for the length of one headless run, so the
 * launch owns them, and they start before attach returns so the first commit
 * after it is already being read. The returned Effect is the detach; the
 * launch fiber's exit is the backstop that interrupts them when no detach ran.
 */
export const attachCliSessionProgressProjection = Effect.fn(
  'attachCliSessionProgressProjection',
)(function* (
  session: Pick<SessionHandle, 'log' | 'view'>,
  writeRecord: CliNdjsonProgressRecordWriter = writeNdjsonStdout,
) {
  // A `debug`-level `log` row is a diagnostic, not progress: it reaches the
  // wire only under the process's own minimum log level, which `--verbose`
  // lowers to `Debug` — the one place the CLI decides what a debug line is.
  const includeDebugLogs = yield* LogLevel.isEnabled('Debug');
  function emit(event: string, payload: unknown): void {
    writeRecord({
      kind: 'progress',
      event,
      ts: new Date().toISOString(),
      payload,
    });
  }

  /** The last commit the tail passed. */
  let delivered = session.log.now();
  /** The ordinal detach cut at; nothing above it is written. */
  let stopAt: number | undefined;
  const drained = Deferred.makeUnsafe<void>();

  /** The ordinal the projection attached at: the tail's own boundary. */
  const attachedAt = delivered;
  /** The child list last derived per parent, so an unchanged one writes no line.
   *  A fold level at or below `attachedAt` only seeds it: a resumed session's
   *  earlier parents, settled or not, are history the tail does not replay
   *  either, so only a child list a post-attach row changes is written. */
  const writtenChildren = new Map<RunId, string>();
  /** A fold ahead of the tail: its child list waits for the lines that produced
   *  it, so a child list never precedes the row it reports. */
  let childrenPending = false;
  const emitChildren = (): void => {
    const view = SubscriptionRef.getUnsafe(session.view.ref);
    childrenPending = view.cursor > delivered;
    if (childrenPending) return;
    for (const [parentRunId, run] of view.runs) {
      // A parent whose child list emptied still owes its closing line; one that
      // never had a child owes nothing.
      if (run.childIds.length === 0 && !writtenChildren.has(parentRunId))
        continue;
      const children = run.childIds.flatMap((childId) => {
        const child = view.runs.get(childId);
        // A live child only: the child list reports who is still going, and a
        // child that ended carries its outcome on its own `run.end` line.
        return child !== undefined && isLiveRun(child) ? [childRow(child)] : [];
      });
      const wire = JSON.stringify(children);
      if (writtenChildren.get(parentRunId) === wire) continue;
      writtenChildren.set(parentRunId, wire);
      if (view.cursor > attachedAt)
        emit('run.children', { runId: parentRunId, children });
    }
  };
  // Seed from the fold as it stands at attach, before any fiber can see a
  // later level: the plane's ordinal bounds the fold, so this writes nothing.
  emitChildren();

  const settleIfDrained = (): void => {
    if (stopAt === undefined || delivered < stopAt) return;
    // `stopAt` is the plane's ordinal, which no fold can be past, so the
    // child list gate is open here and the last one goes out with the drain.
    emitChildren();
    Deferred.doneUnsafe(drained, Effect.void);
  };
  const passed = (commit: number): void => {
    delivered = Math.max(delivered, commit);
    if (childrenPending) emitChildren();
    settleIfDrained();
  };

  // The tail's coordinate: set to the commit each forward read covered once
  // that read's events have all been handled below, so a value here never
  // runs ahead of an event this fiber has yet to write.
  const drainedTo = yield* SubscriptionRef.make(delivered);
  const fork = Effect.forkChild({ startImmediately: true });
  const fibers = [
    yield* fork(
      Stream.runForEach(session.log.tail(delivered, drainedTo), (event) =>
        Effect.sync(() => {
          if (stopAt !== undefined && event.commit > stopAt) return;
          const { type, ...payload } = event;
          if (includeDebugLogs || type !== 'log' || event.level !== 'debug') {
            emit(type, payload);
          }
          passed(event.commit);
        }),
      ),
    ),
    yield* fork(
      Stream.runForEach(SubscriptionRef.changes(drainedTo), (commit) =>
        Effect.sync(() => passed(commit)),
      ),
    ),
    // The child list's own source: the fold, whose every level is a candidate.
    yield* fork(
      Stream.runForEach(session.view.changes, () => Effect.sync(emitChildren)),
    ),
  ];

  return Effect.gen(function* () {
    const first = stopAt === undefined;
    if (first) {
      stopAt = session.log.now();
      settleIfDrained();
    }
    yield* Deferred.await(drained);
    if (first) yield* Fiber.interruptAll(fibers);
  });
});
