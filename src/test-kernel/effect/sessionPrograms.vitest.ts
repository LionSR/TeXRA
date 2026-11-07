/**
 * The package's `resume` (`sessionPrograms.ts`) and the `Run` it hands
 * back, over a real store on the validation model: the run hand-off
 * scenario of the harness 1.0 release acceptance (R14).
 *
 * Failure modes:
 * - R14: a resumed child its parent's open call owns is activated on its
 *   own, or the parent twice, or the redirect is an error instead of the
 *   parent's handle; the redirect leaves a listener of its own subscribed.
 * - A labelled run's label request is left out of its result's usage or its
 *   view's, or the two disagree.
 * - A host's shutdown that stops a launch still opening, then interrupts
 *   it (the CLI's), leaves the run ended without the shutdown's reason, so
 *   a resume reads its turn as unanswered rather than continued.
 */
import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Schema, Scope, Stream } from 'effect';
import { assert, describe, expect } from 'vitest';

import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { Sessions, type LocalSession } from '@texra-ai/harness';
import { AgentCatalog } from '@agent/index/agentCatalog';
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
import { makeSessions } from '../../../packages/harness/src/effect/sessionPrograms';

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
  const wanted = JSON.stringify(
    ids.map((id) => qualifyAggregateId('run', id)).toSorted(),
  );
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
              .subscribe([{ id: qualifyAggregateId('run', child), fromSeq: 0 }])
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
        "records a host shutdown's stop of a launch still opening on its run's end",
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
            // The CLI's shutdown of a launch the session holds: stopped for
            // the shutdown, then interrupted, as its opening commits.
            yield* sdk.request({ kind: 'run.stop', runId, reason: 'shutdown' });
            const interrupted = yield* Effect.forkChild(
              Fiber.interrupt(launch),
            );
            yield* opening.release;
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
            expect(stops).toStrictEqual([{ reason: 'shutdown' }]);
            expect(ends).toStrictEqual([{ outcome: 'cancelled' }]);
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
