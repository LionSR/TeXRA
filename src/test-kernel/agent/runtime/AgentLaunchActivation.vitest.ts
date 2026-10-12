/**
 * A launch's activation over a real store, on the validation model: a run
 * is born with its opening batch or not at all, and a run that fails after
 * it opened still records the description generated for it.
 *
 * Failure modes:
 * - a launch whose opening is refused leaves a partial run (a `run.start`
 *   with no activation) for the listing to show;
 * - a run that fails while its description is still being generated ends
 *   without it, or records it after its `run.end`.
 */
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  started: undefined as (() => void) | undefined,
  answer: undefined as Promise<string> | undefined,
}));

// The one seam left: the description's helper call is answered by the
// validation model at once, so the race below needs it held; the session,
// the store, the agent catalog and the lifecycle are real.
vi.mock('@agent/runtime/helperModel', async (importActual) => {
  const { Effect } = await import('effect');
  const actual =
    await importActual<typeof import('@agent/runtime/helperModel')>();
  return {
    ...actual,
    helperCall: (...args: Parameters<typeof actual.helperCall>) =>
      helper.answer === undefined
        ? actual.helperCall(...args)
        : Effect.promise(() => {
            helper.started?.();
            return helper.answer!;
          }),
  };
});

import '@test/support/sessionGraphTestSetup';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { withProcessServices } from '@platform/processRuntime';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import {
  parkedAfter,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { generateRunId } from '@utils/core';

const config = (instruction: string) =>
  AgentConfigSchema.parse({ agent: 'assistant', model: 'gpt56', instruction });

describe(
  'native agent launch activation',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-activation-');

    // A root's refused opening is the ownership suite's
    // (`RunAgentOwnership.vitest.ts`); a child's ends failed, for its parent.
    it.live(
      'a child launch whose opening is refused leaves no run and ends failed for its parent',
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          const session = yield* openTestDefaultSession({ roots });
          const parentRunId = generateRunId();
          yield* withProcessServices(
            testRuntime(),
            session.runs.launch({
              request: { config: config('Parent.'), runId: parentRunId },
              options: {},
            }),
          ).pipe(Effect.forkChild);
          yield* untilStored(
            roots.storage,
            parkedAfter(parentRunId, 1, roots.storage),
          );
          const faults = yield* sessionStoreFaults(roots.storage);
          yield* faults.failNext('appendAll', 'run.start');
          const runId = generateRunId();

          const ended = yield* withProcessServices(
            testRuntime(),
            prepareAgentDefinition({
              config: config('Refused.'),
              session,
            }).pipe(
              Effect.flatMap((definition) =>
                executeAgent(definition, runId, {
                  session,
                  parentRunId,
                  registration: {
                    identity: { kind: 'agent', agent: 'assistant' },
                    parentRunId,
                  },
                }),
              ),
            ),
          );
          expect(ended).toMatchObject({
            outcome: 'failed',
            error: { message: expect.stringContaining('injected appendAll') },
          });
          expect(
            storedRows(roots.storage).filter((row) => row.run === runId),
          ).toEqual([]);
        }),
    );

    // Regression: the description join once lived in a generator `finally`,
    // which the Effect driver never resumes after a failed `yield*`, so a run
    // that failed left with the description's write still in flight.
    it.live(
      'a run that fails while its description is generated records the description before its end',
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          const session = yield* openTestDefaultSession({ roots });
          const runId = generateRunId();
          const generating = yield* Deferred.make<void>();
          let answer: (text: string) => void = () => undefined;
          helper.answer = new Promise((resolve) => {
            answer = resolve;
          });
          helper.started = () => Deferred.doneUnsafe(generating, Effect.void);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              helper.answer = undefined;
              helper.started = undefined;
            }),
          );
          const faults = yield* sessionStoreFaults(roots.storage);
          // The run's first read after it opened fails it.
          const failed = yield* Deferred.make<void>();
          const launch = yield* withProcessServices(
            testRuntime(),
            session.runs.launch({
              request: { config: config('Fix grammar.'), runId },
              options: {
                onAdmitted: () =>
                  Effect.sync(() => {
                    Effect.runFork(
                      faults
                        .holdNext('readAggregate')
                        .pipe(
                          Effect.flatMap((hold) =>
                            hold.reached.pipe(
                              Effect.andThen(hold.fail),
                              Effect.andThen(
                                Deferred.succeed(failed, undefined),
                              ),
                            ),
                          ),
                        ),
                    );
                  }),
              },
            }),
          ).pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(generating);
          yield* Deferred.await(failed);

          // The run fails with its description still being generated.
          yield* Effect.promise(
            () => new Promise((done) => setImmediate(done)),
          );
          answer('Fixing grammar in the introduction');
          expect((yield* Fiber.join(launch)).message).toContain(
            'injected readAggregate fault',
          );
          const rows = storedRows(roots.storage).filter(
            (row) =>
              row.run === runId &&
              (row.type === 'run.description' || row.type === 'run.end'),
          );
          expect(rows.map((row) => row.type)).toEqual([
            'run.description',
            'run.end',
          ]);
          expect(rows[0]!.data).toContain('Fixing grammar in the introduction');
        }),
    );
  },
);
