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
 * - a run whose rows do not fold is reported as finished;
 * - a resume whose input the resumed turn's end takes with it answers only
 *   at a later rest, after the turn that input starts;
 * - a user's stop while a resume decides is lost: the stop writes the end,
 *   and the resume activates the stopped run anyway;
 * - the first caller of a resume leaving before admission takes a second
 *   SDK caller's resume down with it;
 * - every caller of a resume leaving before admission leaves the resume
 *   running with no owner, which then activates the run;
 * - a message sent while a resume decides only watches that resume, so the
 *   resume's caller leaving loses the wake.
 */
import '@test/support/sessionGraphTestSetup';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Cause, Effect, Fiber } from 'effect';
import { describe, expect } from 'vitest';

import { submitFollowUp, wakeRun } from '@agent/followUp/ToolUseFollowUp';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
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
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeSessions } from '../../../../packages/harness/src/effect/sessionPrograms';

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

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    .map((row) => (JSON.parse(row.data) as { outcome: string }).outcome);

/** `session` as the package hands it to an embedder (`Sessions.open`). */
const packageSession = (session: SessionHandle) =>
  Effect.gen(function* () {
    const sessions = yield* makeSessions(
      // cast: the owner opens the one session this case holds.
      { open: () => Effect.succeed(session) } as never,
      yield* testRuntime().contextEffect,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

/** What a resume that activated the run answers. */
const ACTIVATED = { activation: expect.any(Number) };

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
          expect(yield* Fiber.join(resumed)).toMatchObject(ACTIVATED);
          yield* untilStored(
            storage,
            () => answersOf(storage, runId).at(-1)?.includes('raced') ?? false,
          );

          // A root outlives its resume: its input ending ends it.
          yield* session.followUps.closeInput(runId);
          yield* untilStored(
            storage,
            () => endsOf(storage, runId).at(-1) === 'cancelled',
          );
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
          const first = yield* Effect.forkChild(resume(runId, { session }));
          yield* claim.reached;
          // Joined as it is forked: the resume is the run's activation.
          const second = yield* Effect.forkChild(resume(runId, { session }), {
            startImmediately: true,
          });
          yield* claim.release;

          const joined = yield* Fiber.join(second);
          expect(joined).toMatchObject(ACTIVATED);
          expect(yield* Fiber.join(first)).toEqual(joined);
          expect(activations(storage, runId)).toBe(2);
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

          expect(yield* resume(runId, { session })).toMatchObject(ACTIVATED);
          yield* untilStored(
            storage,
            () => offeredTools(storage, runId).length > 1,
          );
          const [launched, resumed] = offeredTools(storage, runId);
          expect(launched).toContain('bash');
          expect(resumed).toContain('read_file');
          expect(resumed).not.toContain('bash');
        }),
    );

    it.live(
      'a resume whose input the turn end takes with it answers at that commit',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          // The crash cut a turn short: its message taken, its answer not given.
          yield* Effect.gen(function* () {
            yield* session.log.hold(runId);
            const parked = yield* session.runHistory.load(runId);
            if (parked === null) throw new Error('The run has no history.');
            const cell = yield* session.runHistory.open(runId);
            yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: 'answer me' }],
                },
              ]),
              positionRow(runId, parked, 'turn.ready'),
            ]);
          }).pipe(Effect.scoped);
          // Read at a turn's end, never mid-turn; the turn it starts holds
          // its model call until released.
          yield* session.followUps.send(
            runId,
            { from: { kind: 'user' }, text: 'GOLDEN-PARK then this' },
            { hold: 'turn' },
          );

          // The receipt is what a wake (no caller holds the run) answers on.
          yield* Effect.flatten(wakeRun(runId, session));
          expect(answersOf(storage, runId)).toHaveLength(2);
          writeFileSync(
            join(testWorkspaceRoots().storage, 'golden-park.release'),
            '',
          );
        }),
    );

    it.live(
      'a run a live process elsewhere holds is refused before the host rearranges',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash({
            owner: JSON.stringify(['other-host', 4321, 'start-1']),
          });

          expect(yield* resume(runId, { session })).toEqual({
            failed: 'owned_elsewhere',
          });
          expect(activations(storage, runId)).toBe(1);
        }),
    );
    it.live(
      "a user's stop while a resume decides ends the run cancelled, keeps the stop's reason, and the resume activates nothing",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // Past its checks under the claim, the resume reads the run's
          // input before it launches: the stop lands there.
          const claim = yield* faults.holdNext('acquireClaims');
          const resumed = yield* Effect.forkChild(
            Effect.exit(resume(runId, { session })),
          );
          yield* claim.reached;
          const input = yield* faults.holdNext('readAggregate');
          yield* claim.release;
          yield* input.reached;

          const stop = session.runs.stop(runId, {
            reason: 'user',
            detachActiveChildren: false,
          });
          expect(session.runs.get(runId)?.stopReason).toBe('user');
          yield* stop.settlement;
          yield* input.release;
          yield* Fiber.join(resumed);

          expect(endsOf(storage, runId)).toEqual(['cancelled']);
          expect(activations(storage, runId)).toBe(1);
        }),
    );

    it.live(
      "a user's stop after a resume launched its generation, before admission, ends the run cancelled once",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // The resume reads the run's input and lineage, then launches its
          // generation, whose first read the stop lands on.
          const claim = yield* faults.holdNext('acquireClaims');
          const resumed = yield* Effect.forkChild(
            Effect.exit(resume(runId, { session })),
          );
          yield* claim.reached;
          const input = yield* faults.holdNext('readAggregate');
          yield* claim.release;
          yield* input.reached;
          const lineage = yield* faults.holdNext('readRunRecords');
          yield* input.release;
          yield* lineage.reached;
          const launched = yield* faults.holdNext('readRunRecords');
          yield* lineage.release;
          yield* launched.reached;
          // Its generation holds the run here, not yet admitted.
          expect(session.runs.get(runId)?.live).toBe(true);

          session.runs.stop(runId, {
            reason: 'user',
            detachActiveChildren: false,
          });
          expect(session.runs.get(runId)?.stopReason).toBe('user');
          yield* launched.release;
          yield* Fiber.join(resumed);

          expect(endsOf(storage, runId)).toEqual(['cancelled']);
          expect(activations(storage, runId)).toBe(1);
        }),
    );

    it.live(
      'a second SDK resumer is handed the run when the first leaves before admission',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'once');
          const sdk = yield* packageSession(session);
          const faults = yield* sessionStoreFaults(storage);
          const claim = yield* faults.holdNext('acquireClaims');
          const first = yield* Effect.forkChild(sdk.resume(runId), {
            startImmediately: true,
          });
          yield* claim.reached;
          const second = yield* Effect.forkChild(sdk.resume(runId), {
            startImmediately: true,
          });
          yield* Fiber.interrupt(first);
          yield* claim.release;

          const run = yield* Fiber.join(second);
          expect(run.runId).toBe(runId);
          expect((yield* run.result).outcome).toBe('completed');
          expect(activations(storage, runId)).toBe(2);
        }),
    );

    it.live(
      'a resume whose every caller leaves before it admits the run is stopped, activating nothing',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          const claim = yield* faults.holdNext('acquireClaims');
          const first = yield* Effect.forkChild(resume(runId, { session }), {
            startImmediately: true,
          });
          yield* claim.reached;
          const second = yield* Effect.forkChild(resume(runId, { session }), {
            startImmediately: true,
          });
          yield* Fiber.interrupt(first);
          yield* Fiber.interrupt(second);
          yield* claim.release;

          // Nothing is left to activate it: no activation comes within a
          // bound that a live resume meets many times over.
          const activated = yield* untilStored(
            storage,
            () => activations(storage, runId) > 1,
          ).pipe(Effect.timeout('3 seconds'), Effect.exit);
          expect(
            activated._tag === 'Failure' && Cause.squash(activated.cause),
          ).toBeInstanceOf(Cause.TimeoutError);
          expect(session.runs.get(runId)).toBeUndefined();
        }),
    );

    it.live(
      "a message sent while a resume decides wakes the run though the resume's caller leaves",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // The resume reads the run's config, before its claim.
          const owner = yield* faults.holdNext('readRunRecords');
          const resumed = yield* Effect.forkChild(resume(runId, { session }));
          yield* owner.reached;
          const config = yield* faults.holdNext('readRunRecords');
          yield* owner.release;
          yield* config.reached;

          expect(
            yield* submitFollowUp(
              runId,
              { from: { kind: 'user' }, text: 'woken' },
              { session },
            ),
          ).toEqual({ status: 'queued' });
          yield* Fiber.interrupt(resumed);
          yield* config.release;

          yield* untilStored(storage, () =>
            answersOf(storage, runId).some((answer) =>
              answer.includes('woken'),
            ),
          );
        }),
    );
  },
);
