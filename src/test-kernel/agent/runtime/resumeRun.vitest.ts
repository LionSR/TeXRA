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

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect } from 'vitest';

import { resumeRun, type ResumeRunOptions } from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withProcessServices } from '@platform/processRuntime';
import { type RunId } from '@shared/schemas';
import { queuedFollowUps } from '@test/support/sessionTestUtils';
import {
  answersOf,
  claimHolder,
  parkedRunAfterCrash,
  sessionStoreFaults,
  storedRows,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { testRuntime } from '@test/support/testProcessRuntime';

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
          expect((yield* result.completion)?.outcome).toBe('cancelled');
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
  },
);
