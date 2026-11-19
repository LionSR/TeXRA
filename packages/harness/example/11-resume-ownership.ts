/**
 * Example 11 — Who holds a resumed run: its session, not the caller.
 *
 * A run is its own fiber, held by the session that launched it. A caller of
 * `session.resume` only waits for the handle; a reader of `run.result` only
 * reads. Neither leaving stops the run, and a run already resuming is never
 * activated a second time.
 *
 * 1. Starts an interactive run in a persistent session, lets it wait for
 *    input, and closes the session: a close writes no end, so the run stays
 *    resumable.
 * 2. Reopens the store and, all at once, sends the run a message (which
 *    wakes it) and resumes it twice. The run is activated once: the message
 *    is answered by one model request, and both handles are the same
 *    activation's.
 * 3. A reader that gives up waiting on `run.result` leaves the run running.
 * 4. Closes and reopens again, then interrupts a `session.resume` before it
 *    answers. The run is resumed all the same and the session holds it: a
 *    second resume gets the running activation, a message is answered once,
 *    and closing the session releases the run and its store.
 * 5. Reopens a last time: the run is still resumable, and a stop ends it
 *    `cancelled` with nothing left held.
 */
import { Effect, Fiber, Layer, Option, Stream } from 'effect';
import { Sessions, type LocalSession } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';

import { EXAMPLE_CLIENT, makeExampleWorkspace } from './_support.ts';

const { platform, requests, route } = await makeExampleWorkspace([
  { expect: 'Draft the abstract.', text: 'Drafted the abstract.' },
  { expect: 'Tighten the abstract.', text: 'Tightened the abstract.' },
  { expect: 'Add keywords.', text: 'Added keywords.' },
]);

/** One lifetime of the store's session: opened, used, and closed with the
 *  scope, as a process that exits closes it. */
const inSession = <A, E>(
  use: (session: LocalSession) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* (yield* Sessions).open(platform.roots, {
        persistent: true,
      });
      return yield* use(session);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({
          platform,
          plugins: harnessBuiltins,
          client: EXAMPLE_CLIENT,
        }).pipe(Layer.provideMerge(route.transport)),
      ),
    ),
  );

const check = (holds: boolean, what: string, seen: unknown): void => {
  if (!holds) throw new Error(`${what}: ${JSON.stringify(seen)}`);
};

type ViewedRun = NonNullable<
  ReturnType<ReturnType<LocalSession['view']['current']>['runs']['get']>
>;

/** The run as the first view that shows it `ready` does: a session's view
 *  fills in as it reads its store. */
const shown = (
  session: LocalSession,
  runId: RunId,
  ready: (run: ViewedRun) => boolean = () => true,
) =>
  Stream.runHead(
    Stream.filter(
      Stream.concat(
        Stream.succeed(session.view.current()),
        session.view.changes,
      ),
      (view) => {
        const run = view.runs.get(runId);
        return run !== undefined && ready(run);
      },
    ),
  ).pipe(
    Effect.map((view) => Option.getOrThrow(view).runs.get(runId)),
    Effect.timeout('10 seconds'),
  );

/** Resolves once the run waits for input with `turn` turns behind it. */
const waitsAtTurn = (session: LocalSession, runId: RunId, turn: number) =>
  shown(
    session,
    runId,
    (run) => run.position === 'waiting' && (run.turn ?? 0) >= turn,
  );

const heldIds = (session: LocalSession) =>
  session.held().map((run) => run.runId);

// 1. A run left waiting by a session that closed.
const runId = await inSession((session) =>
  Effect.gen(function* () {
    const run = yield* session.start({
      agent: {
        name: 'abstract_writer',
        description: 'Writes and revises an abstract.',
        prompt: 'Write what is asked, briefly.',
        tools: [],
      },
      instruction: 'Draft the abstract.',
      model: route.model,
      interactive: true,
    });
    yield* waitsAtTurn(session, run.runId, 1);
    return run.runId;
  }),
);
console.log(`[11] ${runId} waits; its session closed without ending it`);

// 2 and 3. A wake and two resumes at once; a reader that leaves.
await inSession((session) =>
  Effect.gen(function* () {
    const stored = yield* shown(session, runId);
    check(
      stored?.outcome == null,
      'the closed session ended the run',
      stored?.outcome,
    );
    const [, first, second] = yield* Effect.all(
      [
        session.request({
          kind: 'followUp.send',
          runId,
          text: 'Tighten the abstract.',
        }),
        session.resume(runId, { interactive: true }),
        session.resume(runId, { interactive: true }),
      ],
      { concurrency: 'unbounded' },
    );
    yield* waitsAtTurn(session, runId, 2);
    yield* session.drained;
    // A second activation would have sent the message's turn again, and
    // the scripted model answers a third request only to `Add keywords.`.
    check(requests.length === 2, 'model requests after the wake', requests);
    check(
      heldIds(session).join() === runId,
      'runs held after two resumes',
      heldIds(session),
    );
    console.log(
      `[11] a wake and two resumes: one activation, the message answered once (handles at commits ${first.activation} and ${second.activation})`,
    );

    // 3. Giving up the wait for a result is not a stop.
    const reader = yield* Effect.forkChild(first.result);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(reader);
    const after = session.view.current().runs.get(runId);
    check(
      session.held(runId) !== undefined && after?.outcome == null,
      'a reader that left ended the run',
      after?.outcome,
    );
    console.log('[11] a reader of run.result left; the run runs on');
  }),
);

// 4. A resume whose caller leaves before the handle comes back.
await inSession((session) =>
  Effect.gen(function* () {
    const launcher = yield* Effect.forkChild(
      session.resume(runId, { interactive: true }),
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(launcher);
    // The launch had reached the session: the run is held here, though
    // nobody holds a handle of it.
    check(
      session.held(runId) !== undefined,
      'the run of a resume whose caller left is not held',
      heldIds(session),
    );
    const joined = yield* session.resume(runId, { interactive: true });
    yield* session.request({
      kind: 'followUp.send',
      runId,
      text: 'Add keywords.',
    });
    yield* waitsAtTurn(session, runId, 3);
    yield* session.drained;
    check(requests.length === 3, 'model requests after the join', requests);
    check(
      heldIds(session).join() === runId,
      'runs held after the join',
      heldIds(session),
    );
    console.log(
      `[11] the resume's caller left: the session held the run, a second resume joined it at commit ${joined.activation}, and its message was answered once`,
    );
  }),
);

// 5. The close released the run and the store; a stop is what ends it.
await inSession((session) =>
  Effect.gen(function* () {
    const stored = yield* shown(session, runId);
    check(
      heldIds(session).length === 0 && stored?.outcome == null,
      'the run after its session closed',
      { held: heldIds(session), outcome: stored?.outcome },
    );
    const resumed = yield* session.resume(runId, { interactive: true });
    yield* session.request({ kind: 'run.stop', runId, reason: 'user' });
    const end = yield* resumed.result.pipe(Effect.timeout('10 seconds'));
    yield* session.held(runId)?.drained ?? Effect.void;
    check(
      end.outcome === 'cancelled' &&
        heldIds(session).length === 0 &&
        requests.length === 3,
      'the stopped run',
      { end, held: heldIds(session), requests: requests.length },
    );
    console.log(
      `[11] reopened and stopped: outcome=${end.outcome}, nothing held, ${requests.length} model requests in all`,
    );
  }),
);
