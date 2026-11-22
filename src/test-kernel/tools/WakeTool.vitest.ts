/**
 * A run that arranges to be continued later (`wake`), over a real store on
 * the validation model (`GOLDEN-WAKE`, `validationModel.ts`), with the
 * process on the test clock: the run asks for a wake in an hour and waits
 * for input, and each reply says how many notes to itself its conversation
 * holds.
 *
 * Failure modes:
 * - the time comes and nothing happens: the waiting run takes no turn, or
 *   takes one that does not read the note;
 * - the note reaches the model as a person's message, without the times it
 *   was asked for, due and delivered;
 * - no process holds the run when the wake is due, and the note is lost, or
 *   delivered again at each later open;
 * - a cancelled wake fires anyway.
 */
import { layer } from '@effect/vitest';
import { type Context, DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { assert, describe, expect } from 'vitest';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/worldline/schemas';
import {
  answersOf,
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  storedRows,
  untilStored,
  validationHost,
  waitingAfter,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

import { autoDecideRequests } from '../agent/progressTestUtils';

/** Wait until `runId` answered `answers` times and waits for input. The
 *  store is polled in real time: the test clock moves only where a case
 *  moves it. */
const answered = (storage: string, runId: RunId, answers: number) =>
  TestClock.withLive(
    untilStored(storage, waitingAfter(runId, answers, storage)),
  );

/** Start the wake run on `session` with `instruction`, approving its
 *  calls, and wait until its first turn ended. The block's clock is one
 *  for all its cases, so each starts it at zero. */
const arrange = Effect.fn('arrange')(function* (
  session: Context.Context<SessionServices>,
  instruction: string,
) {
  const { roots } = yield* FakeHost;
  yield* TestClock.setTime(0);
  yield* autoDecideRequests(session, () => ({ action: 'approve' }));
  const runId = generateRunId();
  yield* rootRun({
    runId,
    interactive: true,
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      label: 'golden_wake',
      system: 'GOLDEN-WAKE: arrange to be continued later.',
      tools: ['wake'],
      model: 'openai/gpt-5.6-sol',
      instruction,
    }),
  }).pipe(Effect.provide(session), Effect.forkScoped);
  yield* answered(roots.storage, runId, 1);
  return runId;
});

/** The times a stored note's frame names, as instants: each written with
 *  its UTC offset and its zone named, or it is left out. */
const frameTimes = (note: string): Record<string, number> =>
  Object.fromEntries(
    [...note.matchAll(/(asked|due|delivered)=\\"([^"\\]+\])\\"/g)].flatMap(
      ([, name, shown]) =>
        Option.match(DateTime.makeZonedFromString(shown ?? ''), {
          onNone: () => [],
          onSome: (time) => [[name, DateTime.toEpochMillis(time)]],
        }),
    ),
  );

/** The user messages `runId` stored that carry a note to itself. */
const notesRead = (storage: string, runId: RunId): string[] =>
  storedRows(storage).flatMap((row) =>
    row.run === runId &&
    row.type === 'model.message' &&
    row.data.includes('<wake-note ')
      ? [row.data]
      : [],
  );

describe('a run that arranges a wake', { timeout: REAL_RUN_TIMEOUT }, () => {
  // The process is on the test clock: the session's waits are its own.
  layer(SessionGraph.hosted)((it) => {
    it.layer(validationHost('texra-wake-'), { buildPerTest: true })((it) => {
      it.effect('reads its note in a turn of its own when the time comes', () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const session = yield* persistentTestSession();
          const runId = yield* arrange(session, 'Arrange a wake.');
          expect(answersOf(roots.storage, runId)).toStrictEqual([
            'Notes read: 0',
          ]);
          // A minute short of the hour, the run still waits.
          yield* TestClock.adjust('59 minutes');
          yield* TestClock.adjust('1 minute');
          yield* answered(roots.storage, runId, 2);
          expect(answersOf(roots.storage, runId)).toStrictEqual([
            'Notes read: 0',
            'Notes read: 1',
          ]);
          const [note, ...more] = notesRead(roots.storage, runId);
          assert(note !== undefined, 'the note became a message');
          expect(more).toStrictEqual([]);
          // Asked at the clock's zero, due and delivered an hour later.
          expect(frameTimes(note)).toStrictEqual({
            asked: 0,
            due: 3_600_000,
            delivered: 3_600_000,
          });
          expect(note).toContain('You wrote this note to yourself');
          expect(note).toContain('Check the build.');
        }),
      );

      it.effect(
        'reads its note once, late, when no process held it at the due time',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            // The process that arranged the wake exits before it is due.
            const runId = yield* Effect.scoped(
              Effect.flatMap(persistentTestSession(), (session) =>
                arrange(session, 'Arrange a wake.'),
              ),
            );
            yield* TestClock.adjust('3 hours');
            // The next process to open the project resumes the run for it.
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* persistentTestSession();
                yield* answered(roots.storage, runId, 2);
              }),
            );
            const [note, ...more] = notesRead(roots.storage, runId);
            assert(note !== undefined, 'the note became a message');
            expect(more).toStrictEqual([]);
            expect(frameTimes(note)).toStrictEqual({
              asked: 0,
              due: 3_600_000,
              delivered: 10_800_000,
            });
            // A later open delivers nothing more: the next turn is the
            // person's, and it still holds the one note.
            const session = yield* persistentTestSession();
            yield* submitFollowUp(
              runId,
              { text: 'Anything new?', from: { kind: 'user' } },
              {},
            ).pipe(Effect.provide(session));
            yield* answered(roots.storage, runId, 3);
            expect(answersOf(roots.storage, runId)).toStrictEqual([
              'Notes read: 0',
              'Notes read: 1',
              'Notes read: 1',
            ]);
          }),
      );

      it.effect('reads no note of a wake it cancelled', () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const session = yield* persistentTestSession();
          const runId = yield* arrange(
            session,
            'Arrange a wake, then cancel it.',
          );
          const dropped = storedRows(roots.storage).filter(
            (row) =>
              row.run === runId &&
              row.type === 'followup.consumed' &&
              row.data.includes('"reason":"cancelled"'),
          );
          expect(dropped).toHaveLength(1);
          yield* TestClock.adjust('3 hours');
          // Whatever the passed time started has run by the time the run
          // answers a person's message.
          yield* submitFollowUp(
            runId,
            { text: 'Anything new?', from: { kind: 'user' } },
            {},
          ).pipe(Effect.provide(session));
          yield* answered(roots.storage, runId, 2);
          expect(answersOf(roots.storage, runId)).toStrictEqual([
            'Notes read: 0',
            'Notes read: 0',
          ]);
          expect(notesRead(roots.storage, runId)).toStrictEqual([]);
        }),
      );
    });
  });
});
