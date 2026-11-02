/**
 * The package's `start` and `resume` (`sessionPrograms.ts`) and the `Run`
 * they hand back, over a real store on the validation model: the run
 * ownership and hand-off scenarios of the harness 1.0 release acceptance
 * (R4, R14, R17, R23), each checked against the result it requires.
 *
 * Failure modes:
 * - R4: a caller cancelled as its run opens leaves the run executing with
 *   nobody to stop it; closing the session then leaves a run unended, a
 *   claim held, a view reader waiting, or a command's process alive;
 * - R4: a view that dies during an activation leaves the caller of the
 *   run's view or result waiting forever;
 * - R14: a resumed child its parent's open call owns is activated on its
 *   own, or the parent twice, or the redirect is an error instead of the
 *   parent's handle; the redirect leaves a claim held or a listener of its
 *   own subscribed;
 * - R17: a caller interrupted after the handle is built, before it is
 *   handed over, leaves the run executing with no holder, its claim held,
 *   or its view subscribed;
 * - R23: an observer that stops waiting on a run's result, view or events
 *   stops the run.
 */
import '@test/support/sessionGraphTestSetup';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Scope, Stream } from 'effect';
import { describe, expect } from 'vitest';

import {
  qualifyAggregateId,
  type InlinePersona,
  type RunId,
} from '@texra-ai/harness/schemas';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import {
  answersOf,
  claimHolder,
  crashedCopy,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import {
  testRuntime,
  testSessionOwner,
} from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeSessions } from '../../../packages/harness/src/effect/sessionPrograms';
import type { LocalSession } from '@texra-ai/harness';

/** The model every case runs on: the validation model answers it. */
const MODEL = 'openai/gpt-5.6-sol';

/** `session` as the package hands it to an embedder (`Sessions.open`),
 *  launching under the test process's session owner. */
const packageSession = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const owner = yield* testSessionOwner;
    const sessions = yield* makeSessions(
      { ...owner, open: () => Effect.succeed(session) },
      yield* testRuntime().contextEffect,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

/** A persona whose one turn runs `command` through `bash`, then answers
 *  "The approved command ran.": the validation model's approval script. */
const commandPersona = (command: string): InlinePersona => ({
  name: 'command_runner',
  description: 'Runs one command.',
  prompt: `GOLDEN-APPROVAL bash ${command}`,
  tools: ['bash'],
});

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    .map((row) => (JSON.parse(row.data) as { outcome: string }).outcome);

/** How many model requests the run sent: its `attempt` rows. */
const requestsOf = (storage: string, runId: RunId) =>
  storedRows(storage).filter(
    (row) =>
      row.run === runId &&
      row.type === 'model.message' &&
      (JSON.parse(row.data) as { payload: { kind: string } }).payload.kind ===
        'attempt',
  ).length;

/** How many times the run was activated after commit `after`. */
const activationsAfter = (storage: string, runId: string, after: number) =>
  storedRows(storage).filter(
    (row) =>
      row.run === runId && row.type === 'run.activate' && row.commit > after,
  ).length;

/** Whether process `pid` is alive. */
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
  validationHost('texra-handoff-');

  it.live(
    'R4: a start cancelled at the hand-off and a session close leave no run, claim, reader or process behind',
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const sdk = yield* packageSession(
          yield* openTestDefaultSession({ roots }),
        );
        // A run whose command holds a process open, read by the caller.
        const pidFile = join(roots.workspace!, 'held.pid');
        const holding = yield* sdk.start({
          agent: commandPersona(`echo $$ > ${pidFile} && exec sleep 60`),
          instruction: 'Run the command.',
          model: MODEL,
          approval: { delegated: true },
        });
        const reader = yield* Effect.forkChild(Stream.runDrain(holding.view));
        const result = yield* Effect.forkChild(holding.result);
        yield* untilStored(roots.storage, () =>
          existsSync(pidFile)
            ? readFileSync(pidFile, 'utf8').trim() !== ''
            : false,
        );
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(isAlive(pid)).toBe(true);

        // A second start whose caller leaves while its opening commits.
        const faults = yield* sessionStoreFaults(roots.storage);
        const opening = yield* faults.holdNext('appendAll', 'run.start');
        const cancelled = yield* Effect.forkChild(
          sdk.start({
            agent: 'assistant',
            instruction: 'Never answered.',
            model: MODEL,
          }),
        );
        yield* opening.reached;
        // The interrupt is delivered while the opening is still held.
        const leaving = yield* Effect.forkChild(Fiber.interrupt(cancelled), {
          startImmediately: true,
        });
        yield* opening.release;
        yield* Fiber.join(leaving);
        expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true);
        const cancelledRun = storedRows(roots.storage).find(
          (row) => row.type === 'run.start' && row.run !== holding.runId,
        )?.run as RunId;

        expect(yield* closeTestSession(roots.storage)).toEqual({
          settled: true,
          abandoned: [],
        });

        // The reader and the result answer; the process is gone.
        yield* Fiber.join(reader).pipe(Effect.timeout('10 seconds'));
        expect((yield* Fiber.join(result)).outcome).toBe('cancelled');
        yield* untilStored(roots.storage, () => !isAlive(pid));
        // The cancelled start never reached its model; both runs ended once
        // and released their claims.
        expect(cancelledRun).toBeDefined();
        expect(requestsOf(roots.storage, cancelledRun)).toBe(0);
        for (const runId of [holding.runId, cancelledRun]) {
          expect(endsOf(roots.storage, runId)).toEqual(['cancelled']);
          expect(claimHolder(roots.storage, runId)).toBeNull();
        }
      }).pipe(Effect.provideServiceEffect(SessionOwner, testSessionOwner)),
  );

  it.live(
    "R4: a view that dies during an activation fails the run's view and result instead of leaving them waiting",
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const sdk = yield* packageSession(
          yield* openTestDefaultSession({ roots }),
        );
        const release = join(roots.workspace!, 'release');
        const run = yield* sdk.start({
          agent: commandPersona(`until [ -e ${release} ]; do sleep 0.05; done`),
          instruction: 'Run the command.',
          model: MODEL,
          approval: { delegated: true },
        });
        const view = yield* Effect.forkChild(
          Effect.exit(Stream.runDrain(run.view)),
        );
        const result = yield* Effect.forkChild(Effect.exit(run.result));
        yield* untilStored(roots.storage, (rows) =>
          rows.some(
            (row) => row.run === run.runId && row.type === 'tool.start',
          ),
        );
        // Every read the view's updater retries fails: it dies.
        const faults = yield* sessionStoreFaults(roots.storage);
        for (let read = 0; read < 6; read += 1)
          yield* faults.failNext('readInputBatch');
        writeFileSync(release, '');

        const exits: Exit.Exit<unknown, unknown>[] = [
          yield* Fiber.join(view).pipe(Effect.timeout('15 seconds')),
          yield* Fiber.join(result).pipe(Effect.timeout('15 seconds')),
        ];
        for (const exit of exits) expect(Exit.isFailure(exit)).toBe(true);
        expect(String(exits[0])).toContain('injected readInputBatch fault');
        yield* closeTestSession(roots.storage);
        expect(claimHolder(roots.storage, run.runId)).toBeNull();
      }).pipe(Effect.provideServiceEffect(SessionOwner, testSessionOwner)),
  );

  it.live(
    "R14: resuming a child its parent's open call owns resumes the parent once, names the child, and leaves no claim or listener",
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        // A process killed while the parent's `agent` call runs its child:
        // the child's opening and first response committed, the call open.
        const { parent, child, storage } = yield* Effect.scoped(
          Effect.gen(function* () {
            const sdk = yield* packageSession(
              yield* openTestDefaultSession({ roots }),
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
                (row) => row.run === run.runId && row.type === 'tools.offered',
              ),
            );
            // The next run offered tools is the child; its first call's
            // intent is held, so the cut follows its response.
            const opening = yield* faults.holdNext(
              'appendAll',
              'tools.offered',
            );
            yield* opening.reached;
            const intent = yield* faults.holdNext('appendAll', 'tool.intent');
            yield* opening.release;
            yield* intent.reached;
            const storage = crashedCopy(roots.storage);
            yield* intent.release;
            yield* closeTestSession(roots.storage);
            const child = storedRows(storage).find(
              (row) => row.parent === run.runId && row.type === 'run.start',
            )?.run as RunId;
            return { parent: run.runId, child, storage };
          }),
        );
        expect(child).toBeDefined();
        expect(endsOf(storage, child)).toEqual([]);
        const cut = Math.max(...storedRows(storage).map((row) => row.commit));

        const sdk = yield* packageSession(
          yield* openTestDefaultSession({ roots: { ...roots, storage } }),
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
        yield* closeTestSession(storage);
      }).pipe(Effect.provideServiceEffect(SessionOwner, testSessionOwner)),
  );

  it.live(
    'R17: a caller interrupted after its handle is built, before it is handed over, leaves no run, claim or listener',
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const session = yield* openTestDefaultSession({ roots });
        // The handle's stop is built from the session's requests as the
        // handle is: the caller is interrupted right there.
        const requests = Context.get(session, SessionRequests);
        let interrupted = false;
        const sdk = yield* packageSession(
          Context.add(session, SessionRequests, {
            ...requests,
            request: (request) => {
              if (!interrupted && request.kind === 'run.stop') {
                interrupted = true;
                Fiber.getCurrent()?.interruptUnsafe();
              }
              return requests.request(request);
            },
          }),
        );
        const caller = yield* Effect.forkChild(
          sdk.start({
            agent: 'assistant',
            instruction: 'Say hi.',
            model: MODEL,
          }),
        );
        expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true);
        expect(interrupted).toBe(true);
        const runId = storedRows(roots.storage).find(
          (row) => row.type === 'run.start',
        )?.run as RunId;
        // The run's end, then its activation's cleanup.
        yield* untilStored(
          roots.storage,
          () =>
            sdk.held(runId) === undefined &&
            claimHolder(roots.storage, runId) === null,
        );

        expect(endsOf(roots.storage, runId)).toEqual(['cancelled']);
        expect(requestsOf(roots.storage, runId)).toBe(0);
        expect(subscribed(sdk)).toEqual([]);
        yield* closeTestSession(roots.storage);
      }).pipe(Effect.provideServiceEffect(SessionOwner, testSessionOwner)),
  );

  it.live(
    "R23: an observer that stops waiting on a run's result, view and events leaves the run running to its end",
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const sdk = yield* packageSession(
          yield* openTestDefaultSession({ roots }),
        );
        const release = join(roots.workspace!, 'release');
        const run = yield* sdk.start({
          agent: commandPersona(`until [ -e ${release} ]; do sleep 0.05; done`),
          instruction: 'Run the command.',
          model: MODEL,
          approval: { delegated: true },
        });
        const waits = yield* Effect.forkChild(
          Effect.all(
            [
              run.result,
              Stream.runDrain(run.view),
              Stream.runDrain(run.events),
            ],
            { concurrency: 'unbounded' },
          ),
        );
        yield* untilStored(roots.storage, (rows) =>
          rows.some(
            (row) => row.run === run.runId && row.type === 'tool.start',
          ),
        );
        yield* Fiber.interrupt(waits);
        writeFileSync(release, '');

        expect((yield* run.result).outcome).toBe('completed');
        expect(answersOf(roots.storage, run.runId)).toEqual([
          'The approved command ran.',
        ]);
        expect(claimHolder(roots.storage, run.runId)).toBeNull();
        yield* closeTestSession(roots.storage);
      }).pipe(Effect.provideServiceEffect(SessionOwner, testSessionOwner)),
  );
});
