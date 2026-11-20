/**
 * The package's `resume` (`sessionPrograms.ts`) and the `Run` it hands
 * back, over a real store on the validation model: the run hand-off
 * scenarios of the harness 1.0 release acceptance (R14, R17).
 *
 * Failure modes:
 * - R14: a resumed child its parent's open call owns is activated on its
 *   own, or the parent twice, or the redirect is an error instead of the
 *   parent's handle; the redirect leaves a listener of its own subscribed.
 * - A labelled run's label request is left out of its result's usage or its
 *   view's, or the two disagree.
 * - A stop that reaches a launch still opening leaves the run without the
 *   stop's row or without an end; one that came before the launch is lost
 *   and the run runs.
 * - A run whose end the store refused fails its result with "ended without
 *   a stored end" and nothing of why.
 * - R17: a run whose handle was built and never handed over (its launcher
 *   interrupted after the launch answered) cannot be stopped and is not
 *   released by the session's close.
 */
import { layer } from '@effect/vitest';
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { assert, describe, expect } from 'vitest';

import { generateRunId, type RunId } from '@texra-ai/harness/schemas';
import { Sessions, type LocalSession } from '@texra-ai/harness';
import { AgentCatalog } from '@agent/index/agentCatalog';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  crashedCopy,
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { makeSessions } from '../../src/effect/sessionPrograms';

/** The model every case runs on: the validation model answers it. */
const MODEL = 'openai/gpt-5.6-sol';

/** `session` as the package hands it to an embedder (`Sessions.open`),
 *  launching under the block's session owner. */
const packageSession = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const owner = yield* SessionOwner;
    const sessions = yield* makeSessions(
      { ...owner, open: () => Effect.succeed(session) },
      yield* AgentCatalog,
      () => Effect.succeed([]),
    );
    return yield* sessions.open((yield* FakeHost).roots);
  });

/** The stored data of a `run.end` row, as far as these cases read it. */
const RunEndData = Schema.fromJsonString(
  Schema.Struct({ outcome: Schema.String }),
);

/** The stored data of a `run.stop` row. */
const RunStopData = Schema.fromJsonString(
  Schema.Struct({ reason: Schema.String }),
);

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    .map((row) => Schema.decodeUnknownSync(RunEndData)(row.data).outcome);

/** How many times the run was activated after commit `after`. */
const activationsAfter = (storage: string, runId: string, after: number) =>
  storedRows(storage).filter(
    (row) =>
      row.run === runId && row.type === 'run.activate' && row.commit > after,
  ).length;

/** The transcripts the session view keeps for its subscribers. */
const subscribed = (session: LocalSession) => [
  ...session.view.current().transcriptSeq.keys(),
];

/** Wait until the session view keeps transcripts for exactly `ids`. */
const untilSubscribed = (session: LocalSession, ids: readonly RunId[]) => {
  const wanted = JSON.stringify(ids.map((id) => id).toSorted());
  const matches = (keys: readonly string[]) =>
    JSON.stringify(keys.toSorted()) === wanted;
  return matches(subscribed(session))
    ? Effect.void
    : session.view.changes.pipe(
        Stream.filter((view) => matches([...view.transcriptSeq.keys()])),
        Stream.runHead,
        Effect.asVoid,
        Effect.timeout('10 seconds'),
      );
};

describe('the package hands a run over', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-handoff-'), { buildPerTest: true })((it) => {
      it.effect(
        "R14: resuming a child its parent's open call owns resumes the parent once, names the child, and leaves no listener",
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            // A process killed while the parent's `agent` call runs its child:
            // the child's opening and first response committed, the call open.
            const { parent, child, storage } = yield* Effect.scoped(
              Effect.gen(function* () {
                const sdk = yield* packageSession(
                  yield* persistentTestSession(roots),
                );
                const faults = yield* sessionStoreFaults(roots.storage);
                const run = yield* sdk.start({
                  agent: 'golden_parent',
                  instruction: 'Read the notes, plan, delegate.',
                  model: MODEL,
                  approval: 'autoApprove',
                });
                yield* untilStored(roots.storage, (rows) =>
                  rows.some(
                    (row) =>
                      row.run === run.runId && row.type === 'tools.offered',
                  ),
                );
                // The next run offered tools is the child; its first call's
                // intent is held, so the cut follows its response.
                const opening = yield* faults.holdNext(
                  'appendAll',
                  'tools.offered',
                );
                yield* opening.reached;
                const intent = yield* faults.holdNext(
                  'appendAll',
                  'tool.intent',
                );
                yield* opening.release;
                yield* intent.reached;
                const storage = crashedCopy(roots.storage);
                yield* intent.release;
                yield* Sessions.use((sessions) => sessions.close(roots));
                // cast: the store's logical id of a run aggregate is its RunId.
                const child = storedRows(storage).find(
                  (row) => row.parent === run.runId && row.type === 'run.start',
                )?.run as RunId;
                return { parent: run.runId, child, storage };
              }),
            );
            expect(child).toBeDefined();
            expect(endsOf(storage, child)).toEqual([]);
            const cut = Math.max(
              ...storedRows(storage).map((row) => row.commit),
            );

            const sdk = yield* packageSession(
              yield* persistentTestSession({ ...roots, storage }),
            );
            // The embedder's own listener on the child, attached first.
            const listener = yield* Scope.make();
            yield* sdk.view
              .subscribe([{ id: child, fromSeq: 0 }])
              .pipe(Scope.provide(listener));
            const run = yield* sdk.resume(child);
            expect(run.runId).toBe(parent);
            expect(run.redirectedFrom).toBe(child);
            yield* Stream.runDrain(run.view);
            expect((yield* run.result).outcome).toBe('completed');

            expect(endsOf(storage, child)).toEqual(['completed']);
            expect(endsOf(storage, parent)).toEqual(['completed']);
            expect(activationsAfter(storage, parent, cut)).toBe(1);
            expect(activationsAfter(storage, child, cut)).toBe(1);
            for (const runId of [parent, child])
              expect(sdk.held(runId)).toBeUndefined();
            // Only the embedder's listener is left, and it goes with its scope.
            yield* untilSubscribed(sdk, [child]);
            yield* Scope.close(listener, Exit.void);
            yield* untilSubscribed(sdk, []);
          }),
      );

      it.effect(
        "records a stop of a launch still opening on its run's end",
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const sdk = yield* packageSession(
              yield* persistentTestSession(roots),
            );
            const faults = yield* sessionStoreFaults(roots.storage);
            const opening = yield* faults.holdNext('appendAll', 'run.start');
            const launch = yield* Effect.forkChild(
              sdk.start({
                agent: 'golden_parent',
                instruction: 'Read the notes, plan, delegate.',
                model: MODEL,
              }),
            );
            yield* opening.reached;
            const runId = sdk.held()[0]?.runId;
            assert(runId !== undefined, 'the session holds the launch');
            // A launch the session holds: stopped, then interrupted, as its
            // opening commits. The stop's own row waits behind that commit.
            const stopped = yield* Effect.forkChild(
              sdk.request({ kind: 'run.stop', runId, reason: 'user' }),
              { startImmediately: true },
            );
            const interrupted = yield* Effect.forkChild(
              Fiber.interrupt(launch),
            );
            yield* opening.release;
            yield* Fiber.join(stopped);
            yield* Fiber.join(interrupted);
            yield* untilStored(roots.storage, (rows) =>
              rows.some((row) => row.run === runId && row.type === 'run.end'),
            );
            const rows = storedRows(roots.storage).filter(
              (row) => row.run === runId,
            );
            const stops = rows
              .filter((row) => row.type === 'run.stop')
              .map((row) => Schema.decodeUnknownSync(RunStopData)(row.data));
            const ends = rows
              .filter((row) => row.type === 'run.end')
              .map((row) => Schema.decodeUnknownSync(RunEndData)(row.data));
            expect(stops).toStrictEqual([{ reason: 'user' }]);
            expect(ends).toStrictEqual([{ outcome: 'cancelled' }]);
          }),
      );

      it.effect(
        'R17: a launch interrupted after its run answered, before its caller has the handle, leaves the run held, stoppable and released',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const session = yield* persistentTestSession(roots);
            const sdk = yield* packageSession(session);
            const faults = yield* sessionStoreFaults(roots.storage);
            const opening = yield* faults.holdNext('appendAll', 'run.start');
            const launch = yield* Effect.forkChild(
              sdk.start({
                agent: 'golden_parent',
                instruction: 'Read the notes, plan, delegate.',
                model: MODEL,
              }),
            );
            yield* opening.reached;
            const held = sdk.held()[0];
            assert(held !== undefined, 'the session holds the launch');
            const { runId } = held;
            const answered = Context.get(session, RunRegistry).opened(runId);
            assert(answered !== undefined, 'a fiber here drives the run');
            // The opening commits in one batch; the run's next position is
            // its loop's first write, made after the opening answered.
            const loop = yield* faults.holdNext('appendAll', 'run.position');
            yield* opening.release;
            yield* loop.reached;
            // Inside the window: the launch has answered, and its caller
            // has no handle yet.
            const answer = yield* Effect.forkChild(answered, {
              startImmediately: true,
            });
            expect(answer.pollUnsafe()).toBeDefined();
            expect(launch.pollUnsafe()).toBeUndefined();
            yield* Fiber.interrupt(launch);
            const exit = yield* Fiber.await(launch);
            expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);

            // The run is the session's: listed, and a stop reaches it.
            expect(sdk.held(runId)).toBeDefined();
            const stopped = yield* Effect.forkChild(
              sdk.request({ kind: 'run.stop', runId, reason: 'user' }),
              { startImmediately: true },
            );
            yield* loop.release;
            yield* Fiber.join(stopped);
            yield* held.drained;
            expect(sdk.held(runId)).toBeUndefined();
            expect(
              storedRows(roots.storage)
                .filter((row) => row.run === runId && row.type === 'run.stop')
                .map((row) => Schema.decodeUnknownSync(RunStopData)(row.data)),
            ).toStrictEqual([{ reason: 'user' }]);
            expect(endsOf(roots.storage, runId)).toStrictEqual(['cancelled']);

            // The session closes, and a reopen holds nothing of the run.
            yield* Sessions.use((sessions) => sessions.close(roots));
            const reopened = yield* packageSession(
              yield* persistentTestSession(roots),
            );
            expect(reopened.held()).toStrictEqual([]);
            // The view fills in as the reopened session reads its store.
            const shown = yield* Stream.concat(
              Stream.succeed(reopened.view.current()),
              reopened.view.changes,
            ).pipe(
              Stream.filter((view) => view.runs.has(runId)),
              Stream.runHead,
              Effect.timeout('10 seconds'),
            );
            const run = Option.getOrUndefined(shown)?.runs.get(runId);
            expect(run?.outcome).toBe('cancelled');
            expect(run?.holder).toBe('none');
          }),
      );

      it.effect('refuses a launch whose stop came before it started', () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const sdk = yield* packageSession(
            yield* persistentTestSession(roots),
          );
          // A host mints the id, and a stop can reach the session before
          // the launch does: no rows exist yet, and none ever run.
          const runId = generateRunId();
          yield* sdk.request({ kind: 'run.stop', runId, reason: 'user' });
          const refused = yield* Effect.flip(
            sdk.start({
              agent: 'golden_parent',
              instruction: 'Read the notes, plan, delegate.',
              model: MODEL,
              runId,
            }),
          );
          expect(refused._tag).toBe('LaunchRefused');
          expect(refused.message).toContain('stopped before it started');
          expect(
            storedRows(roots.storage).filter((row) => row.run === runId),
          ).toStrictEqual([]);
        }),
      );

      it.effect(
        "fails a run's result with what the store refused of its end",
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const sdk = yield* packageSession(
              yield* persistentTestSession(roots),
            );
            const faults = yield* sessionStoreFaults(roots.storage);
            yield* faults.failNext('appendAll', 'run.end');
            // One run, so the refused end is its own.
            const run = yield* sdk.start({
              agent: 'golden_child',
              instruction: 'Answer once.',
              model: MODEL,
            });
            const failure = yield* Effect.flip(run.result);
            expect(failure.message).toContain(
              'injected appendAll fault (run.end)',
            );
          }),
      );

      it.effect(
        "counts a labelled run's label request in its result and its view alike",
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const sdk = yield* packageSession(
              yield* persistentTestSession(roots),
            );
            const run = yield* sdk.start({
              agent: 'golden_parent',
              instruction: 'Read the notes, plan, delegate.',
              model: MODEL,
              approval: 'autoApprove',
            });
            yield* Stream.runDrain(run.view);
            const { usage } = yield* run.result;

            const rows = storedRows(roots.storage).filter(
              (row) => row.run === run.runId,
            );
            expect(rows.map((row) => row.type)).toContain('run.description');
            const responses = rows.filter(
              (row) =>
                row.type === 'model.message' &&
                row.data.includes('"kind":"response"'),
            ).length;
            // Every validation answer is one output token: the turns' and
            // the label's.
            expect(usage?.outputTokens).toBe(responses + 1);
            const view = sdk.view.current().runs.get(run.runId)?.usage;
            expect(view?.outputTokens).toBe(usage?.outputTokens);
            expect(view?.inputTokens).toBe(usage?.inputTokens);
            expect(view?.cost).toBeCloseTo(usage?.cost ?? -1, 12);
          }),
      );
    });
  });
});
