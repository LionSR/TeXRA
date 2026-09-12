import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { randomUUID } from 'node:crypto';

import { it } from '@effect/vitest';
import { Effect, Layer, SynchronizedRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { followUpsLayer } from '@agent/runtime/FollowUps';
import {
  ModelInvoker,
  turnText,
  type InvokeRequest,
} from '@agent/runtime/ModelInvoker';
import { rowAggregate, stepRow, type Message } from '@agent/runtime/loop/rows';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { dispatchFactsFor } from '@agent/runtime/run/tools';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { TraceEmitter } from '@agent/trace';
import type { Model, TurnResult } from '@llm/turn';
import {
  AgentCategory,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  type JsonValue,
  type RetryErrorInfo,
  type RunId,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { StreamLog } from '@shared/session/traceEntries';
import { hostStores } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import {
  attachTestTranscriptFold,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { isObject } from '@utils/core';
import { generateRunId, generateShortId } from '@utils/core';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

import { sessionWithInteractions } from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session ledger, with
// the model faked at the `ModelInvoker` seam. The rows the fake writes are the
// production ones, so the turn's own decisions — the blank-turn retry, the
// terminal-tool turn, the stage it opens and closes — run against the durable
// facts a live turn leaves behind.
// ---------------------------------------------------------------------------

const ORIGIN = {
  protocol: 'deepseek-chat',
  codecVersion: 1,
  requestedModel: 'test-model',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'deepseek',
  },
} as const;

/**
 * A `Model` the harness never invokes: the invoker seam is faked above it.
 * Compaction still probes the optional token counter, and this model offers
 * none, so that one read answers `undefined` and the text heuristic decides.
 */
const unusedModel = new Proxy({} as Model, {
  get(_target, property) {
    if (property === 'estimateInputTokens') return undefined;
    throw new Error(`The harness model has no ${String(property)}.`);
  },
});

function testBoundModel(overrides: Partial<BoundModel> = {}): BoundModel {
  return {
    modelId: 'test-model',
    config: buildTestModelConfig(),
    compatibilityKey: 'DeepSeek',
    model: unusedModel,
    origin: ORIGIN,
    usageProvider: 'openai',
    usageRoute: 'api-key',
    contextWindow: 200_000,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsReasoning: false,
    supportsForcedToolChoice: true,
    wireRouteKey: 'test-route',
    modelRetryRouteKey: 'test-route/test-model',
    routedOnKimiCode: false,
    backgroundCapable: false,
    ...overrides,
  };
}

/** A turn that calls tools, after the text the model wrote alongside them. */
function toolCallTurn(
  calls: readonly { readonly id: string; readonly name: string }[],
  text = '',
): TurnResult {
  return {
    kind: 'http',
    providerResponseId: `resp-${calls.map((call) => call.id).join('-')}`,
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [
      ...(text === ''
        ? []
        : [
            {
              kind: 'message' as const,
              content: [{ kind: 'text' as const, text }],
            },
          ]),
      ...calls.map((call) => ({
        kind: 'local-call' as const,
        providerCallId: call.id,
        name: call.name,
        argumentsText: '{}',
      })),
    ],
    finishReason: 'tool-calls',
    usage: null,
  };
}

function textTurn(text: string): TurnResult {
  return {
    kind: 'http',
    providerResponseId: randomUUID(),
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content:
      text === ''
        ? []
        : [{ kind: 'message', content: [{ kind: 'text', text }] }],
    finishReason: 'stop',
    usage: null,
  };
}

/**
 * What the faked invoker reports for one turn, in script order. A turn may
 * first replace the whole conversation, the way a context-limit compaction
 * does, before its response is committed.
 */
type ScriptedTurn =
  | TurnResult
  | { readonly compactTo: readonly Message[]; readonly turn: TurnResult }
  | { readonly failWith: RetryErrorInfo }
  | { readonly cancelled: true };

function invokerLayer(script: readonly ScriptedTurn[], seen: InvokeRequest[]) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const ledger = yield* RunLedger;
      const aggregateId = rowAggregate(run.runId);
      let index = 0;
      return {
        invoke: (state: RunState, request: InvokeRequest) =>
          Effect.gen(function* () {
            const scripted = script[index];
            index += 1;
            seen.push(request);
            if (scripted === undefined) {
              return yield* Effect.die(
                new Error('The scenario ran out of model turns.'),
              );
            }
            if ('cancelled' in scripted) {
              return { kind: 'cancelled' as const, state };
            }
            if ('failWith' in scripted) {
              return {
                kind: 'failed' as const,
                state,
                error: scripted.failWith,
              };
            }
            const bound = yield* SynchronizedRef.get(run.model);
            const invocation = { invocationId: randomUUID(), attempt: 1 };
            const responseId = randomUUID();
            const turn = 'compactTo' in scripted ? scripted.turn : scripted;
            const next = yield* ledger.appendBatch(run.runId, state, [
              {
                type: 'model.message',
                aggregateId,
                payload: {
                  kind: 'attempt',
                  invocation,
                  origin: bound.origin,
                  delivery: 'stream',
                },
              },
              ...('compactTo' in scripted
                ? [
                    {
                      type: 'model.compaction' as const,
                      aggregateId,
                      payload: {
                        keepPrefix: 0,
                        messages: scripted.compactTo,
                        cause: 'context-limit' as const,
                        continuation: null,
                        continuationDropped: null,
                      },
                    },
                  ]
                : []),
              {
                type: 'model.message',
                aggregateId,
                payload: {
                  kind: 'response',
                  responseId,
                  invocation,
                  turn,
                  calls: dispatchFactsFor(
                    turn,
                    run.tools,
                    run.logger,
                    generateShortId,
                  ),
                  usage: null,
                },
              },
              stepRow(run.runId, state, 'response.ready'),
            ]);
            return {
              kind: 'response' as const,
              state: next,
              responseId,
              turn,
              text: turnText(turn),
              usage: null,
              responseTimeMs: 1,
            };
          }),
      };
    }),
  );
}

interface LoopInit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly script: readonly ScriptedTurn[];
  readonly tools?: Record<string, ITool>;
  readonly logger?: TraceEmitter;
  readonly bound?: Partial<BoundModel>;
  readonly finalToolName?: string | null;
  /** The slot the terminal tool captures into, shared with the scenario. */
  readonly structured?: { value: JsonValue | undefined };
  readonly mediaFiles?: readonly string[];
  /** Absent means the launch had no transcript row to write. */
  readonly initialUserMessageForTranscript?: string | undefined;
}

function agentRunTestLayer(init: LoopInit) {
  return Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const model = yield* SynchronizedRef.make(testBoundModel(init.bound));
      const logger = init.logger ?? new TraceEmitter();
      const tools = init.tools ?? {};
      const scope = yield* Effect.scope;
      const runScope = createRunScope({
        runId: init.runId,
        session: init.session,
        signal: new AbortController().signal,
      });
      return {
        runId: init.runId,
        parentRunId: null,
        session: init.session,
        config: AgentConfigSchema.parse({
          agent: 'chat',
          model: 'test-model',
          agentCategory: AgentCategory.ToolUse,
          ...(init.mediaFiles ? { mediaFiles: init.mediaFiles } : {}),
        }),
        setting: AgentSettingSchema.parse({
          agentCategory: AgentCategory.ToolUse,
          tools: Object.keys(tools).map((name) => ({ name })),
        }),
        prompt: AgentPromptSchema.parse({ userRequest: 'Do the thing.' }),
        logger,
        parentStage: logger.openStage('Run: chat'),
        // Headless: the turn ends the run instead of parking for input.
        // The launch stores a real run carries; no fixture reads through them.
        stores: hostStores(),
        toolPolicy: { stopAfterCycle: true },
        userVarChannels: {},
        initialUserMessageForTranscript:
          'initialUserMessageForTranscript' in init
            ? init.initialUserMessageForTranscript
            : 'Do the thing.',
        fileService: new TaskRunFileService(init.runId),
        tools: new MapToolRegistry(tools),
        finalToolName: init.finalToolName ?? null,
        structured: init.structured ?? { value: undefined },
        model,
        scope,
        pendingModelSwitch: { value: null },
        inScope: <A>(operation: () => A): A =>
          withRunContext(createRunContext({ runScope }), operation),
        usageMonitor: new UsageMonitor(
          { logger, runId: init.runId, runStageId: undefined },
          { agentName: 'chat', agentCategory: AgentCategory.ToolUse },
        ),
        callbacks: { onModelChanged: vi.fn() },
        interrupt: vi.fn(),
      } satisfies AgentRunShape;
    }),
  );
}

/** Run one scripted tool-use run to completion, with what it asked for. */
const runScript = Effect.fn('test.runScript')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* runToolUse({ resume: false }).pipe(
    Effect.provide(
      Layer.mergeAll(invokerLayer(init.script, requests), followUpsLayer).pipe(
        Layer.provideMerge(agentRunTestLayer(init)),
        Layer.provideMerge(Layer.succeed(RunLedger)(init.session.ledger)),
      ),
    ),
  );
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  return { result, requests, state };
});

function quietSession(): SessionHandle {
  return sessionWithInteractions({ emit: () => {}, cancel: () => {} });
}

function startedRun(session: SessionHandle): RunId {
  const runId = generateRunId();
  publishTestRunStart(session, runId);
  return runId;
}

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
    call: vi.fn(async () => ({
      status: 'executed' as const,
      output: `${name} done`,
    })),
  } as ITool;
}

describe('the tool-use turn', () => {
  it.effect(
    'finalizes the response of a turn that ends with text, and not of one that continues with tools',
    () =>
      Effect.gen(function* () {
        const session = quietSession();
        const logger = new TraceEmitter();
        const responseFinalized = vi.spyOn(logger, 'responseFinalized');

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
        expect(responseFinalized).toHaveBeenCalledExactlyOnceWith(
          'Done \\checkmark',
        );
        expect(state?.messages.at(-1)?.role).toBe('assistant');
      }),
  );

  it.effect(
    'asks once more when the model returns a blank turn after a tool result, and does not repeat it',
    () =>
      Effect.gen(function* () {
        const session = quietSession();

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
        const session = quietSession();
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
      const session = quietSession();
      const structured: { value: JsonValue | undefined } = { value: undefined };
      const submitOutput: ITool = {
        definition: { name: 'submit_output' },
        call: vi.fn(async () => {
          structured.value = { answer: 'done' };
          return {
            status: 'executed' as const,
            output: 'recorded',
            endTurn: true,
          };
        }),
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
        const session = quietSession();

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
        const session = quietSession();

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
        const session = quietSession();
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
      const session = quietSession();
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
      const session = quietSession();
      const logger = new TraceEmitter();
      const runId = startedRun(session);
      const store = new StreamLog();
      const recorder = attachTestTranscriptFold(logger, runId, store);

      try {
        const { result } = yield* runScript({
          runId,
          session,
          logger,
          script: scenario.script,
        });

        expect(result.outcome).toBe(scenario.expectedOutcome);
        const sessionStages = store
          .toJSON()
          .flatMap((entry) =>
            entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
            isObject(entry.data) &&
            entry.data.kind === 'session'
              ? [{ label: entry.text, status: entry.data.status }]
              : [],
          );
        expect(sessionStages).toEqual([
          { label: 'Tool-use turn', status: scenario.expectedOutcome },
        ]);
        // The turn is the only structural stage: rounds are row facts.
        expect(
          store
            .toJSON()
            .some(
              (entry) => isObject(entry.data) && entry.data.kind === 'round',
            ),
        ).toBe(false);
      } finally {
        recorder.unsubscribe();
      }
    }),
  );
});
