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
import { Effect, Schema } from 'effect';
import { describe, expect } from 'vitest';

import '@test/support/sessionGraphTestSetup';

import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { withProcessServices } from '@platform/processRuntime';
import { AgentConfigSchema } from '@shared/schemas';
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
  Schema.decodeUnknownSync(AgentConfigSchema)({
    agent: 'assistant',
    model: 'openai/gpt-5.6-sol',
    instruction,
  });

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
  },
);
