import { Effect, Fiber, LogLevel, Stream, SubscriptionRef } from 'effect';

import {
  type RunView,
  runIdentityName,
  type RunId,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { writeNdjsonStdout } from '../platform/logSinks';
import type { LocalSession } from '@texra-ai/harness';

/**
 * One live child on the `run.children` record, from the session view's own row. The
 * status is where the view says its loop stands (`ready` before the child's
 * `run.activate` is applied), not a launcher's optimistic reading of it.
 */
function childRow(child: RunView) {
  return {
    childRunId: child.id,
    agentName: runIdentityName(child.identity),
    identity: child.identity,
    status: child.position,
  };
}

/**
 * Headless CLI progress output. Every display row the session commits goes
 * out as one `kind: "progress"` record whose `event` is the row's `type` and
 * whose `payload` is the rest of the row, field names untouched: the CLI
 * contract is a versioned projection of `SessionRow`, not a second
 * vocabulary (`contract: 3`, stamped by the NDJSON sink).
 *
 * It reads `view.events(view.head())` directly: every event
 * above the store's head in commit order, never the view, so a
 * `stage.start` no surface subscribed to still becomes its line and two
 * same-type updates never collapse.
 *
 * The one record that is not an event is `run.children`, a parent's live
 * child list. It is derived from the session view — the parent's `childIds` and
 * each child's own `RunView` — on every level the session view publishes, and
 * written only when that derivation changes, so it carries no channel of its
 * own. It is ordered against the lines by the session view's own cursor: a view that
 * has advanced past the tail's last written row waits for the tail, so a
 * child list never precedes a row it already reports. Like the tail, it is scoped
 * to the attach boundary: the child lists the session view holds at attach seed the
 * comparison without being written, so a resumed session does not replay
 * its earlier parents.
 *
 * Detaching drains: the tail runs to the head captured at detach, so the
 * last line published before the run finished is on the wire before the
 * caller writes its result record, and the child list is derived once more
 * from the drained view. The drain waits on the tail's own coordinate
 * (`view.events`'s `drained`), not on the events: a transcript row the
 * store no longer holds emits nothing, and the ordinal captured at detach may
 * be exactly that row's. A second detach waits on the first.
 *
 * The tail, its coordinate and the child list are child fibers of the fiber that
 * attaches: the projection lives for the length of one headless run, so the
 * launch owns them, and they start before attach returns so the first commit
 * after it is already being read. The returned Effect is the detach; the
 * launch fiber's exit is the backstop that interrupts them when no detach ran.
 */
export const attachCliSessionProgressProjection = Effect.fn(
  'attachCliSessionProgressProjection',
)(function* (session: Pick<LocalSession, 'view'>) {
  // A `debug`-level `log` row is a diagnostic, not progress: it reaches the
  // wire only under the process's own minimum log level, which `--verbose`
  // lowers to `Debug` — the one place the CLI decides what a debug line is.
  const includeDebugLogs = yield* LogLevel.isEnabled('Debug');
  function emit(event: string, payload: unknown): void {
    writeNdjsonStdout({
      kind: 'progress',
      event,
      ts: new Date().toISOString(),
      payload,
    });
  }

  /** The tail's coordinate: the commit each forward read covered, set once
   *  that read's events have all been written below, so it never runs ahead
   *  of an event this fiber has yet to write. */
  const drainedTo = yield* SubscriptionRef.make(session.view.head());
  /** The ordinal the projection attached at: the tail's own boundary. */
  const attachedAt = SubscriptionRef.getUnsafe(drainedTo);
  /** The ordinal detach cut at; nothing above it is written. */
  let stopAt = Infinity;
  /** The child list last derived per parent, so an unchanged one writes no line.
   *  A session view level at or below `attachedAt` only seeds it: a resumed session's
   *  earlier parents, finished or not, are history the tail does not replay
   *  either, so only a child list a post-attach row changes is written. */
  const writtenChildren = new Map<RunId, string>();
  /** The child lists of `view`, once the tail has written every line up to
   *  its cursor (`to`), so a child list never precedes the row it reports. */
  const emitChildren = (view: SessionView, to: number): void => {
    if (view.cursor > to) return;
    for (const [parentRunId, run] of view.runs) {
      // A parent whose child list emptied still owes its closing line; one that
      // never had a child owes nothing.
      if (run.childIds.length === 0 && !writtenChildren.has(parentRunId))
        continue;
      const children = run.childIds.flatMap((childId) => {
        const child = view.runs.get(childId);
        // A live child only: the child list reports who is still going, and a
        // child that ended carries its outcome on its own `run.end` line.
        return child !== undefined && child.holder === 'here'
          ? [childRow(child)]
          : [];
      });
      const wire = JSON.stringify(children);
      if (writtenChildren.get(parentRunId) === wire) continue;
      writtenChildren.set(parentRunId, wire);
      if (view.cursor > attachedAt)
        emit('run.children', { runId: parentRunId, children });
    }
  };
  // Seed from the session view as it stands at attach, before any fiber can see a
  // later level: the store's head bounds the session view, so this writes nothing.
  emitChildren(session.view.current(), attachedAt);

  const fork = Effect.forkChild({ startImmediately: true });
  const fibers = [
    yield* fork(
      Stream.runForEach(session.view.events(attachedAt, drainedTo), (event) =>
        Effect.sync(() => {
          if (event.commit > stopAt) return;
          const { type, ...payload } = event;
          if (includeDebugLogs || type !== 'log' || event.level !== 'debug') {
            emit(type, payload);
          }
        }),
      ),
    ),
    // The child list's source: every view level, against the tail's
    // coordinate, so a level ahead of the tail waits for its lines.
    yield* fork(
      Stream.runForEach(
        Stream.zipLatest(
          session.view.changes,
          SubscriptionRef.changes(drainedTo),
        ),
        ([view, to]) => Effect.sync(() => emitChildren(view, to)),
      ),
    ),
  ];

  // The detach: cut at the store's head, wait for the tail's coordinate to
  // reach it (at once when it already has), derive the child list once more
  // from the drained view, and stop. A cut that names a pruned row, or a tail
  // already past the head, is reached through the coordinate, not an event.
  const detach = Effect.gen(function* () {
    stopAt = session.view.head();
    yield* SubscriptionRef.changes(drainedTo).pipe(
      Stream.takeUntil((to) => to >= stopAt),
      Stream.runDrain,
    );
    // `stopAt` is the store's head, which no view level can be past, so the
    // child list gate is open here and the last one goes out with the drain.
    emitChildren(session.view.current(), stopAt);
    yield* Fiber.interruptAll(fibers);
  });
  return yield* Effect.cached(detach);
});
