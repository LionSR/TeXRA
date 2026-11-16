/**
 * `resumeRun`, the one door every host resumes a persisted run through, over
 * a real store: each case leaves a root run waiting, crashes its process, and resumes
 * it in a fresh session on the validation model, failing or holding the
 * store's own operations where the case needs a race (`StoreFaults`).
 *
 * Failure modes:
 * - a store failure during a resume reads as a refusal, or loses input;
 * - input sent while a resume reads the run is lost or left unread;
 * - a host that cannot answer approval prompts has approval-gated tools
 *   offered to the run it resumed;
 * - a run another live process holds is resumed here, or the host
 *   rearranges itself before the refusal;
 * - a user's stop while a resume decides is lost: the stop writes no
 *   `run.stop` row or no end, or the resume activates the stopped run anyway;
 * - a root launched to run once, resumed by an interactive caller after it
 *   ended, waits for input while every message to it is refused, with a
 *   refusal that tells the user to resume it.
 * - a resume sent as soon as a run's end is stored, while the fiber that
 *   wrote it is still leaving, is answered with the ended activation and
 *   resumes nothing.
 */
import { layer } from '@effect/vitest';
import { Effect, Fiber, Context } from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { resumeRun, type ResumeRunOptions } from '@agent/runtime/resumeRun';
import { Inbox } from '@agent/followUp/Inbox';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { queuedFollowUps } from '@test/support/sessionTestUtils';
import {
  answersOf,
  waitingRunAfterCrash,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, TestSession } from '@test/support/testKernel';
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';
import type { RunId } from '@texra-ai/harness/schemas';

/** A resume in `session`. */
const resume = (
  runId: RunId,
  {
    session,
    ...options
  }: ResumeRunOptions & { readonly session: Context.Context<SessionServices> },
) => resumeRun(runId, options).pipe(Effect.provide(session));

/** Send `text` to the run as its user. */
const send = (
  session: Context.Context<SessionServices>,
  runId: RunId,
  text: string,
) => Context.get(session, Inbox).send(runId, { from: { kind: 'user' }, text });

/** The texts the run's rows still queue. */
const queuedTexts = (session: Context.Context<SessionServices>, runId: RunId) =>
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
  return rows.map((row) => {
    // cast: a `tools.offered` row's data holds its ToolsOfferedPayload.
    const { payload } = JSON.parse(row.data) as {
      payload: { tools: readonly { name: string }[] };
    };
    return payload.tools.map((tool) => tool.name);
  });
};

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    // cast: a `run.end` row's data holds the run's outcome.
    .map((row) => (JSON.parse(row.data) as { outcome: string }).outcome);

/** The reasons of the run's `run.stop` rows, in order. */
const stopsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.stop')
    // cast: a `run.stop` row's data holds the stop's reason.
    .map((row) => (JSON.parse(row.data) as { reason: string }).reason);

/** What a resume that activated the run answers. */
const ACTIVATED = { activation: expect.any(Number) };

describe(
  'resumeRun over a crashed store',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(texraHosted, { excludeTestServices: true })((it) => {
      it.layer(validationHost('texra-resume-', TEXRA_APP), {
        buildPerTest: true,
      })((it) => {
        it.effect(
          "a store read that fails under a resume fails it with the store's error, activates nothing and keeps the queued input",
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* waitingRunAfterCrash();
              yield* send(session, runId, 'Keep this input.');
              const faults = yield* sessionStoreFaults(storage);
              // The resume reads the run's queued input and then its lineage
              // (`persistedParentRunId`): that read fails.
              const input = yield* faults.holdNext('readAggregate');
              const resumed = yield* Effect.forkChild(
                Effect.flip(resume(runId, { session })),
              );
              yield* input.reached;
              yield* faults.failNext('readRunRecord');
              yield* input.release;

              const error = yield* Fiber.join(resumed);
              expect(error.message).toContain('injected readRunRecord fault');
              expect(activations(storage, runId)).toBe(1);
              expect(yield* queuedTexts(session, runId)).toEqual([
                'Keep this input.',
              ]);
            }),
        );

        it.effect(
          'input sent while a resume reads the run reaches the resumed run',
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* waitingRunAfterCrash();
              const faults = yield* sessionStoreFaults(storage);
              // The first records read finds the run's owner; the second, its
              // config, is inside the resume.
              const owner = yield* faults.holdNext('readRunRecord');
              const resumed = yield* Effect.forkChild(
                resume(runId, { session }),
              );
              yield* owner.reached;
              const config = yield* faults.holdNext('readRunRecord');
              yield* owner.release;
              yield* config.reached;

              expect(yield* send(session, runId, 'raced')).toEqual({
                kind: 'queued',
              });
              yield* config.release;
              expect(yield* Fiber.join(resumed)).toMatchObject(ACTIVATED);
              yield* untilStored(
                storage,
                () =>
                  answersOf(storage, runId).at(-1)?.includes('raced') ?? false,
              );

              // A root outlives its resume: its input ending ends it.
              yield* Context.get(session, Inbox).closeInput(runId);
              yield* untilStored(
                storage,
                () => endsOf(storage, runId).at(-1) === 'cancelled',
              );
            }),
        );

        it.effect(
          'a resume on a host that cannot answer approval prompts offers its run no approval-gated tool',
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* waitingRunAfterCrash({
                interactions: { approvalPromptsUnavailable: true },
              });
              yield* send(session, runId, 'continue');

              expect(yield* resume(runId, { session })).toMatchObject(
                ACTIVATED,
              );
              yield* untilStored(
                storage,
                () => offeredTools(storage, runId).length > 1,
              );
              const [launched, resumed] = offeredTools(storage, runId);
              expect(launched).toContain('bash');
              expect(resumed).toContain('read_file');
              expect(resumed).not.toContain('bash');
              // The notice names only the declared tools it withholds: `plan`,
              // which the persona declares and the goal plugin also injects,
              // once.
              const withheld = storedRows(storage).flatMap((row) => {
                if (row.run !== runId || row.type !== 'log') return [];
                // cast: a `log` row's data holds its message.
                const { message } = JSON.parse(row.data) as {
                  message: string;
                };
                const names = /^Not offering ([^:]+):/.exec(message)?.[1];
                return names === undefined ? [] : names.split(', ');
              });
              expect(withheld).toContain('bash');
              expect(withheld.filter((name) => name === 'plan')).toEqual([
                'plan',
              ]);
            }),
        );

        it.effect(
          "a user's stop while a resume decides records its reason, ends the run cancelled, and the resume activates nothing",
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* waitingRunAfterCrash();
              const faults = yield* sessionStoreFaults(storage);
              // Past its record checks, the resume reads the run's input
              // before it launches: the stop lands there.
              const input = yield* faults.holdNext('readAggregate');
              const resumed = yield* Effect.forkChild(
                resume(runId, { session }),
              );
              yield* input.reached;

              // The resume holds the run as it decides: the stop is taken,
              // and the resume ends the run in the batch that records it.
              expect(
                yield* Context.get(session, Runs).stop(runId, 'user'),
              ).toBe(true);
              yield* input.release;
              expect(yield* Fiber.join(resumed)).toHaveProperty('failed');

              expect(stopsOf(storage, runId)).toEqual(['user']);
              expect(endsOf(storage, runId)).toEqual(['cancelled']);
              expect(activations(storage, runId)).toBe(1);
            }),
        );
      });
    });
  },
);

/** The persona the run-once cases run. */
const NOTES_AGENT = {
  name: 'note_taker',
  description: 'Answers each message.',
  prompt: 'Answer each message.',
  tools: [],
};

describe('a root launched to run once', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(texraHosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-one-shot-', TEXRA_APP), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'resumed by an interactive caller after it ended runs one cycle, ends, and refuses a message as run once',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const sessions = yield* Sessions;
            const options = { persistent: true, host: {} } as const;
            // Ended in a session that then closed, so no fiber holds it.
            const runId = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* sessions.open(roots, options);
                const run = yield* session.start({
                  agent: NOTES_AGENT,
                  instruction: 'Start the notes.',
                  model: 'openai/gpt-5.6-sol',
                });
                expect((yield* run.result).outcome).toBe('completed');
                yield* sessions.close(roots);
                return run.runId;
              }),
            );
            const session = yield* TestSession.open(roots, options);
            const resumed = yield* session.resume(runId, { interactive: true });
            const end = yield* Effect.timeout(resumed.result, '20 seconds');
            expect(end.outcome).toBe('completed');
            const refused = yield* Effect.flip(
              session.request({
                kind: 'followUp.send',
                runId,
                text: 'Second point.',
              }),
            );
            expect(refused).toMatchObject({
              reason: expect.stringContaining('ran once'),
            });
          }),
      );

      it.effect(
        'resumed as soon as its end is stored, runs a new activation to its own end',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const session = yield* TestSession.open(roots, {
              persistent: true,
              host: {},
            });
            const run = yield* session.start({
              agent: NOTES_AGENT,
              instruction: 'Start the notes.',
              model: 'openai/gpt-5.6-sol',
            });
            expect((yield* run.result).outcome).toBe('completed');
            // Sent once the end is read back, as a host resumes a run it saw
            // end: the fiber that wrote the end may not have left yet.
            const resumed = yield* session.resume(run.runId);
            expect(resumed.activation).toBeGreaterThan(run.activation);
            const end = yield* Effect.timeout(resumed.result, '20 seconds');
            expect(end.outcome).toBe('completed');
            // The first lifecycle's end, then the resumed one's, after its
            // activation.
            const ends = storedRows(roots.storage).filter(
              (row) => row.run === run.runId && row.type === 'run.end',
            );
            expect(
              ends.map((row) => row.commit > resumed.activation),
            ).toStrictEqual([false, true]);
          }),
      );
    });
  });
});
