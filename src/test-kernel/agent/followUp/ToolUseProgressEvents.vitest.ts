import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { InvokeRequest } from '@agent/runtime/ModelInvoker';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { TraceEmitter } from '@agent/trace';
import { RUN_OUTCOME, type JsonValue } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  startedRun,
  textTurn,
  toolCallTurn,
  type ScriptedRunInit,
  type ScriptedTurn,
} from '@test/support/scriptedRunLayers';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

import { sessionWithInteractions } from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session ledger, with
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
        Layer.provideMerge(Layer.succeed(RunLedger)(init.session.ledger)),
      ),
    ),
  );
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  return { result, requests, state };
});

const quietSession = () => sessionWithInteractions({ emit: () => {} });

/** The plain text of every user message the run recorded. */
function userTexts(state: RunState | null): string[] {
  return (state?.messages ?? []).flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) =>
          part.kind === 'text' ? [part.text] : [],
        )
      : [],
  );
}

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
    'finalizes the response of a turn that ends with text, and not of one that continues with tools',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const finalized: string[] = [];
        const logger = new TraceEmitter((event) => {
          if (event.type === 'response.finalized') finalized.push(event.text);
        });

        const { state } = yield* runScript({
          runId: startedRun(session),
          session,
          logger,
          tools: { echo: echoTool('echo') },
          script: [
            toolCallTurn([{ id: 'call-1', name: 'echo' }]),
            textTurn('Done \\checkmark'),
          ],
        });

        // The tool-calling round is not the end of the turn, so only the
        // text round's response is finalized, once, with its text.
        expect(finalized).toEqual(['Done \\checkmark']);
        expect(state?.messages.at(-1)?.role).toBe('assistant');
      }),
  );

  it.effect(
    'asks once more when the model returns a blank turn after a tool result, and does not repeat it',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();

        const { requests, state } = yield* runScript({
          runId: startedRun(session),
          session,
          tools: { echo: echoTool('echo') },
          script: [
            toolCallTurn([{ id: 'call-1', name: 'echo' }]),
            textTurn(''),
            textTurn(''),
          ],
        });

        expect(requests).toHaveLength(3);
        const continuations = userTexts(state).filter((text) =>
          text.includes('blank'),
        );
        expect(continuations).toHaveLength(1);
        expect(continuations[0]).toContain('tool result');
      }),
  );

  it.effect.each([true, false])(
    'forces one terminal-tool turn only where the provider can force it (%s)',
    (supportsForcedToolChoice) =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const { requests, state } = yield* runScript({
          runId: startedRun(session),
          session,
          bound: { supportsForcedToolChoice },
          finalToolName: 'submit_output',
          tools: { submit_output: echoTool('submit_output') },
          script: [textTurn('Draft answer'), textTurn('Still drafting')],
        });

        // Exploration is never forced; the terminal tool gets one forced
        // turn where the route supports it.
        expect(requests.map((request) => request.toolChoice)).toEqual([
          undefined,
          supportsForcedToolChoice ? { name: 'submit_output' } : undefined,
        ]);
        // The instruction is written once, forced or not.
        expect(
          userTexts(state).filter((text) =>
            text.includes('Submit the final structured output now.'),
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect('returns the text that accompanied the terminal tool', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const structured: { value: JsonValue | undefined } = { value: undefined };
      const submitOutput: ITool = {
        definition: { name: 'submit_output' },
        call: vi.fn(() =>
          Effect.sync(() => {
            structured.value = { answer: 'done' };
            return {
              status: 'executed' as const,
              output: 'recorded',
              endTurn: true,
            };
          }),
        ),
      } as ITool;

      const { result } = yield* runScript({
        runId: startedRun(session),
        session,
        finalToolName: 'submit_output',
        structured,
        tools: { submit_output: submitOutput },
        script: [
          toolCallTurn(
            [{ id: 'call-1', name: 'submit_output' }],
            'Here is the structured result.',
          ),
        ],
      });

      expect(result).toMatchObject({
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'Here is the structured result.',
        structured: { answer: 'done' },
      });
    }),
  );

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
          response: 'I checked the tool.',
          error: { message: 'Later provider failure' },
        });
      }),
  );

  it.effect(
    'keeps the fresh response when a compaction replaces the whole conversation',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();

        const { result, state } = yield* runScript({
          runId: startedRun(session),
          session,
          script: [
            {
              compactTo: [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: 'Compacted context.' }],
                },
              ],
              turn: textTurn('B'),
            },
          ],
        });

        expect(result.response).toBe('B');
        // The replacement is the history now: the paid response lands on it,
        // not on the conversation it discarded.
        expect(state?.messages).toMatchObject([
          {
            role: 'user',
            content: [{ kind: 'text', text: 'Compacted context.' }],
          },
          {
            role: 'assistant',
            content: [
              { kind: 'message', content: [{ kind: 'text', text: 'B' }] },
            ],
          },
        ]);
      }),
  );
});

describe('the transcript row of the opening message (regression #7508)', () => {
  it.effect(
    'logs the user request even when the launch media cannot be attached',
    () =>
      Effect.gen(function* () {
        // A failed first turn (corrupt or oversized media, a provider
        // validation error) must still leave a record of what the user asked
        // for, or the transcript's opening row vanishes for exactly the runs
        // most likely to need debugging.
        const session = yield* quietSession();
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');

        const exit = yield* Effect.exit(
          runScript({
            runId: startedRun(session),
            session,
            logger,
            bound: { supportsVision: true },
            mediaFiles: ['/tmp/texra-missing-figure.png'],
            script: [textTurn('unreachable')],
          }),
        );

        expect(exit._tag).toBe('Failure');
        expect(info).toHaveBeenCalledWith(
          'Do the thing.',
          expect.objectContaining({ messageType: expect.any(String) }),
        );
      }),
  );

  it.effect('logs nothing when the launch had no transcript row to write', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const logger = new TraceEmitter();
      const info = vi.spyOn(logger, 'info');

      const exit = yield* Effect.exit(
        runScript({
          runId: startedRun(session),
          session,
          logger,
          bound: { supportsVision: true },
          mediaFiles: ['/tmp/texra-missing-figure.png'],
          initialUserMessageForTranscript: undefined,
          script: [textTurn('unreachable')],
        }),
      );

      expect(exit._tag).toBe('Failure');
      expect(info).not.toHaveBeenCalled();
    }),
  );
});

describe('tool-use session-stage outcome persistence (#8023)', () => {
  it.effect.each([
    {
      name: 'completed',
      script: [textTurn('done')] as ScriptedTurn[],
      expectedOutcome: RUN_OUTCOME.COMPLETED,
    },
    {
      name: 'failed',
      script: [
        { failWith: { message: 'round failed', userRetryable: false } },
      ] as ScriptedTurn[],
      expectedOutcome: RUN_OUTCOME.FAILED,
    },
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
        // The turn is the only structural stage: rounds are row facts.
        expect(groups.some((group) => group.kind === 'round')).toBe(false);
      } finally {
        recorder.dispose();
      }
    }),
  );
});
