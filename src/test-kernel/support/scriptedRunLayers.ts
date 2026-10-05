/**
 * The loop harness the run-loop suites share: the run's own services over a
 * real session run history, with the model faked at the `ModelInvoker` seam. The
 * rows the fake writes are the production ones, so the fold, the resume rules
 * and dispatch run against the durable facts a live turn leaves behind.
 */
import { randomUUID } from 'node:crypto';

import { Effect, Layer, type Scope, SynchronizedRef } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { PersonaSchema } from '@agent/core/definition/AgentDataclass';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { ModelInvoker, type InvokeRequest } from '@agent/runtime/ModelInvoker';
import {
  rowAggregate,
  snapshotRow,
  positionRow,
  type Message,
} from '@agent/runtime/loop/rows';
import type { RunCell } from '@agent/runtime/loop/runProgram';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { dispatchFactsFor, localCallsOf } from '@agent/runtime/run/tools';
import { turnText } from '@agent/runtime/run/turnText';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { TraceEmitter } from '@agent/trace';
import {
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type JsonValue,
  type RetryErrorInfo,
  type RunId,
} from '@shared/schemas';
import { testRunTools } from '@test/support/nativeToolTestLayer';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { untrackRun } from '@test/support/sessionEnd';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { hostStores } from '@test/support/setupPlatform';
import { generateRunId, generateShortId } from '@utils/core';
import { RunFileService } from '@utils/files/runStorage';

import type { Model, TurnResult } from '@texra-ai/llm';

export const TEST_ORIGIN = {
  protocol: 'openai-responses',
  codecVersion: 1,
  requestedModel: 'test-model',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'deepseek',
  },
} as const;

/** A `Model` the harness never invokes: the invoker seam is faked above it. */
const unusedModel = new Proxy({} as Model, {
  get(_target, property) {
    throw new Error(`The harness model has no ${String(property)}.`);
  },
});

function testBoundModel(overrides: Partial<BoundModel> = {}): BoundModel {
  const supportsVision = overrides.supportsVision ?? false;
  return {
    modelId: 'test-model',
    config: buildTestModelConfig({ capabilities: { supportsVision } }),
    reasoning: { thinking: false, effort: null, mode: null },
    backend: 'deepseek',
    model: unusedModel,
    origin: TEST_ORIGIN,
    route: { kind: 'api-key', provider: 'deepseek', usageRoute: 'api-key' },
    usageRoute: 'api-key',
    contextWindow: 200_000,
    supportsVision,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: true,
    wireRouteKey: 'test-route',
    modelRetryRouteKey: 'test-route/test-model',
    backgroundCapable: false,
    persistentConnection: false,
    automaticRetries: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    textOnly: false,
    ...overrides,
  };
}

type HttpContent = Extract<TurnResult, { kind: 'http' }>['content'];

const httpTurn = (
  content: HttpContent,
  finishReason: 'stop' | 'length' | 'context-window-exceeded' | 'tool-calls',
  providerResponseId: string = randomUUID(),
): TurnResult => ({
  kind: 'http',
  providerResponseId,
  requestedOrigin: TEST_ORIGIN,
  returnedModel: null,
  modelFingerprint: null,
  content,
  finishReason,
  usage: null,
});

/** The text a turn wrote; a blank text is no content at all. */
const textContent = (text: string): HttpContent =>
  text === '' ? [] : [{ kind: 'message', content: [{ kind: 'text', text }] }];

/** A turn that ends with `text`. */
export const textTurn = (
  text: string,
  finishReason: 'stop' | 'length' | 'context-window-exceeded' = 'stop',
): TurnResult => httpTurn(textContent(text), finishReason);

/** A turn that calls tools, after the text the model wrote alongside them. */
export const toolCallTurn = (
  calls: readonly { readonly id: string; readonly name: string }[],
  text = '',
): TurnResult =>
  httpTurn(
    [
      ...textContent(text),
      ...calls.map((call) => ({
        kind: 'local-call' as const,
        providerCallId: call.id,
        name: call.name,
        argumentsText: '{}',
      })),
    ],
    'tool-calls',
    `resp-${calls.map((call) => call.id).join('-')}`,
  );

/**
 * What the faked invoker reports for one turn, in script order. A turn may
 * first replace the whole conversation, the way a context-limit compaction
 * does, before its response is committed.
 */
export type ScriptedTurn =
  | TurnResult
  | { readonly compactTo: readonly Message[]; readonly turn: TurnResult }
  | { readonly failWith: RetryErrorInfo }
  | { readonly cancelled: true };

/** The turns a scenario hands the loop, in order; `seen` collects the request
 *  each one answered, and its length is the next turn's index. */
export function scriptedInvokerLayer(
  script: readonly ScriptedTurn[],
  seen: InvokeRequest[] = [],
) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const aggregateId = rowAggregate(run.runId);
      return {
        call: () => Effect.die(new Error('No compaction in this scenario.')),
        invoke: (cell: RunCell, request: InvokeRequest) =>
          Effect.gen(function* () {
            const state = yield* cell.current;
            const scripted = script[seen.length];
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
              // As the invoker does: the failure commits before it returns,
              // as the runtime snapshot a resumed run reads back off the fold.
              return {
                kind: 'failed' as const,
                state: yield* cell.append([
                  ...snapshotRow(run.runId, state, {
                    runtime: {
                      lastError: scripted.failWith,
                      declinedRoutes: [],
                    },
                  }),
                ]),
                error: scripted.failWith,
              };
            }
            const bound = yield* SynchronizedRef.get(run.model);
            const invocation = { invocationId: randomUUID(), attempt: 1 };
            const responseId = randomUUID();
            const turn = 'compactTo' in scripted ? scripted.turn : scripted;
            const next = yield* cell.append([
              {
                type: 'model.message',
                aggregateId,
                payload: {
                  kind: 'attempt',
                  request: '0'.repeat(64),
                  invocation,
                  origin: bound.origin,
                  delivery: 'stream',
                },
              },
              ...('compactTo' in scripted
                ? [
                    {
                      type: 'context.edit' as const,
                      aggregateId,
                      payload: {
                        cause: 'compaction' as const,
                        trigger: 'context-limit' as const,
                        base: state.lastEdit,
                        range: { from: 0, to: state.messages.length },
                        messages: scripted.compactTo,
                        usage: null,
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
                    turn.kind === 'http' ? localCallsOf(turn.content) : [],
                    (yield* SynchronizedRef.get(run.steps))?.tools.registry,
                    run.logger,
                    generateShortId,
                  ),
                  usage: null,
                },
              },
              positionRow(run.runId, state, 'response.ready'),
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

/**
 * The run service a fixture stands on: the launch stores a real run carries,
 * no step opened, no callbacks. `over` names what the case under test reads.
 */
export function testAgentRun(
  base: Pick<AgentRunShape, 'runId' | 'session' | 'logger' | 'model' | 'scope'>,
  over: Partial<AgentRunShape> = {},
): AgentRunShape {
  const { runId, session, logger, model } = base;
  return {
    config: AgentConfigSchema.parse({
      agent: 'chat',
      model: 'test-model',
      instruction: 'Do the thing.',
    }),
    persona: PersonaSchema.parse({}),
    task: null,
    parentStage: logger.openStage('Run: chat'),
    stores: hostStores(),
    toolPolicy: {},
    opening: { inputs: {}, activated: [], attachedMemoryMisses: [] },
    initialUserMessageForTranscript: 'Do the thing.',
    fileService: new RunFileService(runId, session.roots),
    ...testRunTools(hostStores()),
    finalToolName: null,
    structured: { value: undefined },
    swapModel: (next) =>
      SynchronizedRef.updateAndGetEffect(model, (current) =>
        Effect.scoped(next(current)),
      ),
    declinedRoutes: [],
    callbacks: {},
    ...base,
    ...over,
  };
}

/** A scripted conversation run. */
export interface ScriptedRunInit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly tools?: Record<string, ITool>;
  readonly logger?: TraceEmitter;
  readonly bound?: Partial<BoundModel>;
  /** A child run: its parent owns continuation across its turns. */
  readonly parentRunId?: RunId | null;
  /** Headless: the run stops after one turn instead of parking for input. */
  readonly stopAfterCycle?: boolean;
  /** The terminal structured-output tool, when the run has one. */
  readonly finalToolName?: string | null;
  /** The slot the terminal tool captures into, shared with the scenario. */
  readonly structured?: { value: JsonValue | undefined };
  readonly mediaFiles?: readonly string[];
  /** Absent means the launch had no transcript row to write. */
  readonly initialUserMessageForTranscript?: string | undefined;
  readonly onIdle?: () => void;
}

export function agentRunTestLayer(init: ScriptedRunInit) {
  return Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const model = yield* SynchronizedRef.make(testBoundModel(init.bound));
      const logger = init.logger ?? new TraceEmitter();
      const scope: Scope.Scope = yield* Effect.scope;
      const tools = init.tools ?? {};
      const handle = testRunHandle({
        runId: init.runId,
        agent: 'chat',
        parent: init.parentRunId ?? null,
      });
      init.session.runs.track(handle);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => untrackRun(init.session.runs, handle.runId)),
      );
      return testAgentRun(
        { runId: init.runId, session: init.session, logger, model, scope },
        {
          config: AgentConfigSchema.parse({
            agent: 'chat',
            model: 'test-model',
            instruction: 'Do the thing.',
            ...(init.mediaFiles ? { mediaFiles: init.mediaFiles } : {}),
          }),
          persona: PersonaSchema.parse({
            tools: Object.keys(tools).map((name) => ({ name })),
          }),
          toolPolicy: { stopAfterCycle: init.stopAfterCycle === true },
          ...testRunTools(hostStores(), tools),
          finalToolName: init.finalToolName ?? null,
          structured: init.structured ?? { value: undefined },
          callbacks: init.onIdle ? { onIdle: init.onIdle } : {},
          ...('initialUserMessageForTranscript' in init
            ? {
                initialUserMessageForTranscript:
                  init.initialUserMessageForTranscript,
              }
            : {}),
        },
      );
    }),
  );
}

/** A run id whose start is already on the session's log. */
export function startedRun(session: SessionHandle): RunId {
  const runId = generateRunId();
  publishTestRunStart(session, runId);
  return runId;
}
