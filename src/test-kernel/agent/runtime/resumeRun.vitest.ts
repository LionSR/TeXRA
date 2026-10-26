/**
 * `resumeRun`, the one door every host resumes a persisted run through, over
 * a real store: each case parks a root run, crashes its process, and resumes
 * it in a fresh session on the validation model, failing or holding the
 * store's own operations where the case needs a race (`StoreFaults`).
 *
 * Failure modes:
 * - a store failure during a resume reads as a refusal, or loses input;
 * - input sent while a resume reads the run, or from its host step, is
 *   lost, left unread, or delivered out of order;
 * - two resumes of one run both launch it;
 * - a run whose input closed while the resume read it is launched anyway;
 * - a resume whose launch fails loses input that raced it, keeps the run
 *   live here, or wedges the next resume;
 * - a host that cannot answer approval prompts has approval-gated tools
 *   offered to the run it resumed;
 * - a stop asked as the resumed run opens still runs a turn;
 * - a user's stop of the resumed run's turn is undone: the input typed
 *   behind that turn wakes the run again; or a message sent once the stop
 *   returns, before its halt commits, is left unread;
 * - a run another live process holds is resumed here, or the host
 *   rearranges itself before the refusal;
 * - a run whose rows do not fold is reported as finished.
 */
import '@test/support/sessionGraphTestSetup';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { describe, expect } from 'vitest';

import {
  resumeOwnRun,
  resumeRun,
  type ResumeRunOptions,
} from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { withProcessServices } from '@platform/processRuntime';
import { AgentConfigSchema, type RunId } from '@shared/schemas';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import { queuedFollowUps } from '@test/support/sessionTestUtils';
import {
  answersOf,
  claimHolder,
  parkedRunAfterCrash,
  sessionStoreFaults,
  storedRows,
  REAL_RUN_TIMEOUT,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { generateRunId } from '@utils/core';

/** A resume on the test process's runtime. */
const resume = (runId: RunId, options: ResumeRunOptions) =>
  withProcessServices(testRuntime(), resumeRun(runId, options));

/** Send `text` to the run as its user. */
const send = (session: SessionHandle, runId: RunId, text: string) =>
  session.followUps.send(runId, { from: { kind: 'user' }, text });

/** The texts the run's rows still queue. */
const queuedTexts = (session: SessionHandle, runId: RunId) =>
  Effect.map(queuedFollowUps(session, runId), (queued) =>
    queued.map((followUp) => followUp.text),
  );

/** How many times the run has been activated: once per launch. */
const activations = (storage: string, runId: RunId) =>
  storedRows(storage).filter(
    (row) => row.run === runId && row.type === 'run.activate',
  ).length;

/** The names of the tools the run's newest `tools.offered` row offers. */
const offeredTools = (storage: string, runId: RunId) => {
  const rows = storedRows(storage).filter(
    (row) => row.run === runId && row.type === 'tools.offered',
  );
  return rows.map((row) =>
    (
      JSON.parse(row.data) as {
        payload: { tools: readonly { name: string }[] };
      }
    ).payload.tools.map((tool) => tool.name),
  );
};

/** What a resume that reached the run's next idle turn answers. */
const DELIVERED = { started: true, delivered: true, outcome: 'waiting' };

describe(
  'resumeRun over a crashed store',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-resume-');

    it.live(
      "a store read that fails under a resume's claim fails it with the store's error, releases the claim, activates nothing and keeps the queued input",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'Keep this input.');
          const faults = yield* sessionStoreFaults(storage);
          // Under the claim, the resume reads the run's queued input and
          // then its lineage (`persistedParentRunId`): that read fails.
          const claim = yield* faults.holdNext('acquireClaims');
          const resumed = yield* Effect.forkChild(
            Effect.flip(resume(runId, { session })),
          );
          yield* claim.reached;
          const input = yield* faults.holdNext('readAggregate');
          yield* claim.release;
          yield* input.reached;
          yield* faults.failNext('readRunRecords');
          yield* input.release;

          const error = yield* Fiber.join(resumed);
          expect(error.message).toContain('injected readRunRecords fault');
          expect(activations(storage, runId)).toBe(1);
          expect(claimHolder(storage, runId)).toBeNull();
          expect(yield* queuedTexts(session, runId)).toEqual([
            'Keep this input.',
          ]);
        }),
    );

    it.live(
      'input sent while a resume reads the run reaches the resumed run',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // The first records read finds the run's owner; the second, its
          // config, is inside the resume.
          const owner = yield* faults.holdNext('readRunRecords');
          const resumed = yield* Effect.forkChild(resume(runId, { session }));
          yield* owner.reached;
          const config = yield* faults.holdNext('readRunRecords');
          yield* owner.release;
          yield* config.reached;

          expect(yield* send(session, runId, 'raced')).toEqual({
            kind: 'queued',
            read: false,
          });
          yield* config.release;
          const result = yield* Fiber.join(resumed);
          expect(result).toMatchObject(DELIVERED);
          expect(answersOf(storage, runId).at(-1)).toContain('raced');

          // A root's lifetime is the caller's to await past the
          // acknowledgement: its input ending ends it.
          if (!('started' in result)) throw new Error('resume refused');
          yield* session.followUps.closeInput(runId);
          expect((yield* result.completion!)?.outcome).toBe('cancelled');
        }),
    );

    it.live(
      'input sent from the host step of a resume follows the input queued before it',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'first');

          const result = yield* resume(runId, {
            session,
            onAdmitted: () =>
              Effect.gen(function* () {
                expect(yield* send(session, runId, 'second')).toEqual({
                  kind: 'queued',
                  read: false,
                });
              }),
          });
          expect(result).toMatchObject(DELIVERED);
          const seen = answersOf(storage, runId).join('\n');
          expect(seen.indexOf('first')).toBeGreaterThan(-1);
          expect(seen.indexOf('second')).toBeGreaterThan(seen.indexOf('first'));
        }),
    );

    it.live(
      'a second resume of a run joins the one in flight, each admitted once',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'once');
          const faults = yield* sessionStoreFaults(storage);
          // The first resume waits on the run's claim, inside its resume.
          const claim = yield* faults.holdNext('acquireClaims');
          const admitted: string[] = [];
          const admit = (who: string) => () =>
            Effect.sync(() => void admitted.push(who));
          const first = yield* Effect.forkChild(
            resume(runId, { session, onAdmitted: admit('first') }),
          );
          yield* claim.reached;
          const joining = yield* Deferred.make<void>();
          const second = yield* Effect.forkChild(
            resume(runId, {
              session,
              onAdmitted: admit('second'),
              onJoined: () => Deferred.doneUnsafe(joining, Effect.void),
            }),
          );
          yield* Deferred.await(joining);
          yield* claim.release;

          const joined = yield* Fiber.join(second);
          expect(joined).toMatchObject(DELIVERED);
          expect(yield* Fiber.join(first)).toEqual(joined);
          expect(activations(storage, runId)).toBe(2);
          expect(admitted.toSorted()).toEqual(['first', 'second']);
        }),
    );

    it.live(
      'a joiner is an observer: its interruption leaves the resume running, and it hears the run on its trace port',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'observed');
          const faults = yield* sessionStoreFaults(storage);
          const claim = yield* faults.holdNext('acquireClaims');
          const owner = yield* Effect.forkChild(resume(runId, { session }));
          yield* claim.reached;
          const heard: unknown[] = [];
          const unlisten = session.trace.listen(runId, (event) =>
            heard.push(event),
          );
          const joining = yield* Deferred.make<void>();
          // `resumeOwnRun`: `resumeRun` itself is uninterruptible.
          const joiner = yield* Effect.forkChild(
            withProcessServices(
              testRuntime(),
              resumeOwnRun(runId, {
                session,
                onJoined: () => Deferred.doneUnsafe(joining, Effect.void),
              }),
            ),
          );
          yield* Deferred.await(joining);
          // Its own wait ends at once; the resume it joined does not.
          yield* Fiber.interrupt(joiner);
          expect(owner.pollUnsafe()).toBeUndefined();
          yield* claim.release;

          expect(yield* Fiber.join(owner)).toMatchObject(DELIVERED);
          unlisten();
          expect(heard.length).toBeGreaterThan(0);
          expect(answersOf(storage, runId).at(-1)).toContain('observed');
        }),
    );

    it.live(
      'a resume refuses a run whose input closed while it read the run, launching nothing',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          const owner = yield* faults.holdNext('readRunRecords');
          const resumed = yield* Effect.forkChild(resume(runId, { session }));
          yield* owner.reached;
          const config = yield* faults.holdNext('readRunRecords');
          yield* owner.release;
          yield* config.reached;
          yield* session.followUps.closeInput(runId);
          yield* session.log.settled;
          yield* config.release;

          expect(yield* Fiber.join(resumed)).toEqual({
            failed: 'not_resumable',
          });
          expect(activations(storage, runId)).toBe(1);
        }),
    );

    it.live(
      'a resume whose activation is refused ends the run as failed and keeps the queued input, which the next resume delivers',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'keep me');
          const faults = yield* sessionStoreFaults(storage);
          yield* faults.failNext('appendAll', 'run.activate');

          const error = yield* Effect.flip(resume(runId, { session }));
          expect(error.message).toContain('injected appendAll fault');
          expect(activations(storage, runId)).toBe(1);
          const ended = storedRows(storage).findLast(
            (row) => row.run === runId && row.type === 'run.end',
          );
          expect(JSON.parse(ended!.data)).toMatchObject({
            outcome: 'failed',
            error: { message: expect.stringContaining('injected appendAll') },
          });
          expect(yield* queuedTexts(session, runId)).toEqual(['keep me']);
          // The failed generation's leave wakes the run for the message it
          // kept; a resume asked now joins that one or runs its own.
          expect(yield* resume(runId, { session })).toMatchObject(DELIVERED);
          expect(answersOf(storage, runId).at(-1)).toContain('keep me');
        }),
    );

    it.live(
      "a child's result that races a failed resume stays queued for the next one",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'original');
          const faults = yield* sessionStoreFaults(storage);
          // The activation's commit holds the session's publisher, so the
          // result queues behind it.
          const activation = yield* faults.holdNext(
            'appendAll',
            'run.activate',
          );
          const resuming = yield* Effect.forkChild(resume(runId, { session }));
          yield* activation.reached;
          const delivered = yield* Effect.forkChild(
            session.followUps.send(runId, {
              text: 'completed child',
              from: { kind: 'run', runId: 'c41dc41dc41d' as RunId },
            }),
          );
          yield* activation.fail;

          const error = yield* Effect.flip(Fiber.join(resuming));
          expect(error.message).toContain('injected appendAll fault');
          yield* Fiber.join(delivered);
          expect(yield* queuedTexts(session, runId)).toEqual([
            'original',
            'completed child',
          ]);
          expect(yield* resume(runId, { session })).toMatchObject(DELIVERED);
          expect(answersOf(storage, runId).at(-1)).toContain('completed child');
        }),
    );

    it.live(
      'a resume on a host that cannot answer approval prompts offers its run no approval-gated tool',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash({
            interactions: { approvalPromptsUnavailable: true },
          });
          yield* send(session, runId, 'continue');

          expect(yield* resume(runId, { session })).toMatchObject(DELIVERED);
          const [launched, resumed] = offeredTools(storage, runId);
          expect(launched).toContain('bash');
          expect(resumed).toContain('read_file');
          expect(resumed).not.toContain('bash');
        }),
    );

    it.live(
      'a stop asked as the resumed run opens runs no turn, and the next resume delivers the input',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'held over');
          let stopped = false;

          const exit = yield* Effect.exit(
            resume(runId, {
              session,
              isCancellationRequested: () => stopped,
              onRun: () =>
                Effect.sync(() => {
                  stopped = true;
                }),
            }),
          );
          expect(Exit.hasInterrupts(exit)).toBe(true);
          expect(answersOf(storage, runId)).toHaveLength(1);
          expect(yield* queuedTexts(session, runId)).toEqual(['held over']);

          expect(yield* resume(runId, { session })).toMatchObject(DELIVERED);
          expect(answersOf(storage, runId).at(-1)).toContain('held over');
        }),
    );

    // A stop asked of a run held here returns once the run is interrupted;
    // its halt commits as the run unwinds, so a message sent at once lands
    // before the halt and is woken all the same, as is one sent while a
    // stop that detaches the run's agents commits that detach first.
    for (const [after, afterStop] of [
      ['leaves the input typed behind it queued, and wakes nothing', null],
      ['is woken for a message sent once the stop returns', 'stopped'],
      ['is woken for a message sent while it detaches', 'detaching'],
    ] as const)
      it.live(`a user's stop of the resumed turn ${after}`, () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          // The validation model holds a call that names GOLDEN-PARK.
          yield* send(session, runId, 'GOLDEN-PARK Hold this turn.');
          const resumed = yield* Effect.forkChild(resume(runId, { session }));
          yield* untilStored(storage, (rows) => {
            const own = rows.filter((row) => row.run === runId);
            const consumed = own.findLastIndex(
              (row) => row.type === 'followup.consumed',
            );
            return (
              consumed >= 0 &&
              own
                .slice(consumed + 1)
                .some((row) => row.data.includes('"kind":"attempt"'))
            );
          });
          expect(yield* send(session, runId, 'Typed behind.')).toMatchObject({
            kind: 'queued',
          });
          const stop = session.runs.stop(runId, {
            reason: 'user',
            detachActiveChildren: afterStop === 'detaching',
          });
          const settled = yield* Effect.forkChild(stop.settlement);
          if (afterStop !== 'detaching') yield* Fiber.join(settled);
          // A host's send: it waits for the stop to drain, so the row lands
          // after the run's end and wakes it.
          if (afterStop)
            yield* submitFollowUp(
              runId,
              { text: 'After the stop.', from: { kind: 'user' } },
              { session },
            );
          yield* Fiber.join(settled);
          yield* Fiber.await(resumed);
          // A wake owed as the stopped generation leaves starts at once: give
          // it time to activate the run a third time.
          yield* untilStored(
            storage,
            () => activations(storage, runId) > 2,
          ).pipe(Effect.timeoutOption('2 seconds'));

          expect(activations(storage, runId)).toBe(afterStop ? 3 : 2);
          if (!afterStop)
            expect(yield* queuedTexts(session, runId)).toEqual([
              'Typed behind.',
            ]);
        }),
      );

    it.live(
      'a run a live process elsewhere holds is refused before the host rearranges',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash({
            owner: JSON.stringify(['other-host', 4321, 'start-1']),
          });
          let rearranged = false;

          expect(
            yield* resume(runId, {
              session,
              onAdmitted: () =>
                Effect.sync(() => {
                  rearranged = true;
                }),
            }),
          ).toEqual({ failed: 'owned_elsewhere' });
          expect(rearranged).toBe(false);
          expect(activations(storage, runId)).toBe(1);
        }),
    );

    it.live(
      'a document task that ended refuses a resume as finished and keeps the input woken for it',
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          const runId = generateRunId();
          writeFileSync(
            join(roots.workspace!, 'paper.tex'),
            'A short draft.\n',
          );
          // The persona answers with the validation document, not the echo.
          delete process.env.TEXRA_INTERNAL_VALIDATE_ECHO;
          const session = yield* openTestDefaultSession({ roots });
          const ended = yield* withProcessServices(
            testRuntime(),
            session.runs.launch({
              request: {
                config: Schema.decodeUnknownSync(AgentConfigSchema)(
                  asDocumentTask({
                    agent: 'polish',
                    agentSource: 'builtIn',
                    model: 'openai/gpt-5.6-sol',
                    instruction: 'Polish the draft.',
                    inputFiles: ['paper.tex'],
                    workingDirectory: roots.workspace,
                  }),
                ),
                runId,
              },
              options: {},
            }),
          );
          expect(ended.outcome).toBe('completed');
          expect(yield* send(session, runId, 'again')).toEqual({
            kind: 'queued',
            read: false,
          });
          // The run ended: the wake its sender owes is refused, and the
          // resume tells the user; the wake itself read the run.
          expect(yield* session.followUps.wake(runId)).toBe(true);

          expect(yield* resume(runId, { session })).toEqual({
            failed: 'finished',
          });
          expect(yield* queuedTexts(session, runId)).toEqual(['again']);
        }),
    );

    // Telling the user the run "has finished", or throwing the launch's own
    // wording at them, are the two ways this used to go wrong.
    it.live(
      'a run whose rows no longer fold is refused as unusable, not as finished',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          // The run's positions go, so its history has no opening to fold from.
          const db = new DatabaseSync(join(storage, 'texra.db'));
          try {
            db.exec(
              `DELETE FROM event WHERE type = 'run.position' AND "commit" IN (${storedRows(
                storage,
              )
                .filter((row) => row.run === runId)
                .map((row) => row.commit)
                .join(',')})`,
            );
          } finally {
            db.close();
          }

          expect(yield* resume(runId, { session })).toEqual({
            failed: 'unusable_checkpoint',
          });
        }),
    );
  },
);
