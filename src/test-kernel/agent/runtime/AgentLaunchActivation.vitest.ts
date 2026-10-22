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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect } from 'vitest';

import '@test/support/sessionGraphTestSetup';

import { apiKeySecretName } from '@texra-ai/llm';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { withProcessServices } from '@platform/processRuntime';
import { AgentConfigSchema } from '@shared/schemas';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import { fakeHostSecrets } from '@test/support/setupPlatform';
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
          // The default helper model's key, so the label is the validation
          // model's to answer.
          yield* fakeHostSecrets.set(
            apiKeySecretName('deepseek'),
            'validation-fake-key',
          );
          const faults = yield* sessionStoreFaults(roots.storage);
          const end = yield* faults.holdNext('appendAll', 'run.end');
          // The run's first read after it opened fails it. That fault must
          // come before the run's first model turn: the turn carries the
          // GOLDEN-PARK instruction too, so the validation model would hold it.
          const launch = yield* withProcessServices(
            testRuntime(),
            session.runs.launch({
              // The validation model holds a call that names GOLDEN-PARK, its
              // label's included, until released.
              request: { config: config('GOLDEN-PARK Fix grammar.'), runId },
              options: {
                onAdmitted: () =>
                  Effect.sync(() => {
                    Effect.runFork(
                      faults
                        .holdNext('readAggregate')
                        .pipe(
                          Effect.flatMap((hold) =>
                            hold.reached.pipe(Effect.andThen(hold.fail)),
                          ),
                        ),
                    );
                  }),
              },
            }),
          ).pipe(Effect.flip, Effect.forkChild);

          // The run fails with its description still being generated: its
          // loop's stop is logged on the way to the description's settle.
          yield* untilStored(roots.storage, (rows) =>
            rows.some(
              (row) =>
                row.run === runId &&
                row.type === 'log' &&
                row.data.includes('stopped: injected readAggregate fault'),
            ),
          );
          // The settle joins the description: no `run.end` is attempted
          // while it is unanswered (a run that left it in flight ends at once).
          const early = yield* end.reached.pipe(
            Effect.as(true),
            Effect.timeoutOrElse({
              duration: '1 second',
              orElse: () => Effect.succeed(false),
            }),
          );
          expect(early).toBe(false);
          writeFileSync(join(roots.storage, 'golden-park.release'), '');
          yield* end.reached;
          yield* end.release;
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
          expect(rows[0]!.data).toContain('Parked run released');
        }),
    );
  },
);
