/**
 * The package's `resume` (`sessionPrograms.ts`) and the `Run` it hands
 * back, over a real store on the validation model: the run hand-off
 * scenario of the harness 1.0 release acceptance (R14).
 *
 * Failure mode:
 * - R14: a resumed child its parent's open call owns is activated on its
 *   own, or the parent twice, or the redirect is an error instead of the
 *   parent's handle; the redirect leaves a claim held or a listener of its
 *   own subscribed.
 */
import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Scope, Stream } from 'effect';
import { describe, expect } from 'vitest';

import { qualifyAggregateId, type RunId } from '@texra-ai/harness/schemas';
import { Sessions, type LocalSession } from '@texra-ai/harness';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  claimHolder,
  crashedCopy,
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { SessionGraph } from '@test/support/testKernel';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
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
      yield* (yield* SessionGraph.runtime).contextEffect,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    .map((row) => (JSON.parse(row.data) as { outcome: string }).outcome);

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
        "R14: resuming a child its parent's open call owns resumes the parent once, names the child, and leaves no claim or listener",
        () =>
          Effect.gen(function* () {
            const roots = testWorkspaceRoots();
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
                  approval: { delegated: true },
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
            for (const runId of [parent, child]) {
              expect(claimHolder(storage, runId)).toBeNull();
              expect(sdk.held(runId)).toBeUndefined();
            }
            // Only the embedder's listener is left, and it goes with its scope.
            yield* untilSubscribed(sdk, [child]);
            yield* Scope.close(listener, Exit.void);
            yield* untilSubscribed(sdk, []);
          }),
      );
    });
  });
});
