import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { InvokeRequest } from '@agent/runtime/ModelInvoker';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { RUN_OUTCOME } from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  startedRun,
  toolCallTurn,
  type ScriptedRunInit,
  type ScriptedTurn,
} from '@test/support/scriptedRunLayers';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

import { sessionWithInteractions } from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session run history, with
// the model faked at the `ModelInvoker` seam. The rows the fake writes are the
// production ones, so the turn's own decisions — the blank-turn retry, the
// terminal-tool turn, the stage it opens and closes — run against the durable
// facts a live turn leaves behind.
// ---------------------------------------------------------------------------

interface LoopInit extends ScriptedRunInit {
  readonly script: readonly ScriptedTurn[];
}

/** Run one scripted tool-use run to completion, with what it asked for. */
const runScript = Effect.fn('test.runScript')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* runToolUse({ resume: false }).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer(init.script, requests),
        nativeToolTestLayer(),
      ).pipe(
        Layer.provideMerge(
          agentRunTestLayer({ stopAfterCycle: true, ...init }),
        ),
        Layer.provideMerge(Layer.succeed(RunHistory)(init.session.runHistory)),
      ),
    ),
  );
  const state = yield* init.session.runHistory
    .load(init.runId)
    .pipe(Effect.orDie);
  return { result, requests, state };
});

const quietSession = () => sessionWithInteractions({ emit: () => {} });

function echoTool(name: string): ITool {
  return {
    definition: { name },
    call: vi.fn(() =>
      Effect.succeed({
        status: 'executed' as const,
        output: `${name} done`,
      }),
    ),
  } as ITool;
}

describe('the tool-use turn', () => {
  it.effect(
    'keeps the text of an earlier turn when a later model turn fails',
    () =>
      Effect.gen(function* () {
        // A failed run still reports what the model had said: the text that
        // accompanied the tool calls is the run's response, beside the error.
        const session = yield* quietSession();

        const { result } = yield* runScript({
          runId: startedRun(session),
          session,
          tools: { probe: echoTool('probe') },
          script: [
            toolCallTurn(
              [{ id: 'call-1', name: 'probe' }],
              'I checked the tool.',
            ),
            {
              failWith: {
                message: 'Later provider failure',
                userRetryable: false,
              },
            },
          ],
        });

        expect(result).toMatchObject({
          outcome: RUN_OUTCOME.FAILED,
          output: { response: 'I checked the tool.' },
          error: { message: 'Later provider failure' },
        });
      }),
  );
});

describe('tool-use session-stage outcome persistence (#8023)', () => {
  it.effect.each([
    {
      name: 'cancelled',
      script: [{ cancelled: true }] as ScriptedTurn[],
      expectedOutcome: RUN_OUTCOME.CANCELLED,
    },
  ])('persists a $name turn as one structural session stage', (scenario) =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const recorder = createTestRunTrace(runId);
      const logger = recorder.trace;

      try {
        const { result } = yield* runScript({
          runId,
          session,
          logger,
          script: scenario.script,
        });

        expect(result.outcome).toBe(scenario.expectedOutcome);
        const groups = recorder.transcript().taskGroups;
        const sessionStages = groups.flatMap((group) =>
          group.kind === 'session' && group.endTime !== undefined
            ? [{ label: group.name, status: group.status }]
            : [],
        );
        expect(sessionStages).toEqual([
          { label: 'Tool-use turn', status: scenario.expectedOutcome },
        ]);
      } finally {
        recorder.dispose();
      }
    }),
  );
});
