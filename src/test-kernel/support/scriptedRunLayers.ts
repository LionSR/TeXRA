/**
 * The loop harness the run-loop suites share: the run's own services over a
 * real session run history, with the model faked at the `ModelInvoker` seam. The
 * rows the fake writes are the production ones, so the fold, the resume rules
 * and dispatch run against the durable facts a live turn leaves behind.
 */
import { randomUUID } from 'node:crypto';

import {
  Context,
  Effect,
  Layer,
  Schema,
  type Scope,
  ScopedRef,
  Semaphore,
  SynchronizedRef,
} from 'effect';

import { RunFileService } from '@texra-ai/harness/plugins';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { ModelInvoker } from '@agent/runtime/ModelInvoker';
import type { InvokeRequest } from '@agent/runtime/run/requestContext';
import { positionRow } from '@agent/runtime/loop/rows';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import { dispatchFactsFor, localCallsOf } from '@agent/runtime/run/tools';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import {
  ModelAccess,
  type BoundModel,
} from '@agent/runtime/modelAccess/ModelAccess';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import { turnText } from '@shared/session/runFacts';
import type { HistoryMessage } from '@shared/session/historyTurns';
import type { RunCell } from '@shared/session/runHistory';
import {
  AgentConfigSchema,
  PersonaSchema,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  qualifyAggregateId,
  type RetryErrorInfo,
  type RunId,
} from '@shared/schemas';
import { generateRunId } from '@shared/schemas';
import { testRunTools } from '@test/support/nativeToolTestLayer';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';

import type { Model, TurnResult } from '@texra-ai/llm';

const TEST_ORIGIN = {
  protocol: 'openai-responses',
  codecVersion: 1,
  requestedModel: 'test-model',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'deepseek',
  },
} as const;

/** A `Model` the harness never invokes: the invoker seam is faked above it. */
// cast: every property read throws, so nothing reads the empty target.
const unusedModel = new Proxy({} as Model, {
  get(_target, property) {
    throw new Error(`The harness model has no ${String(property)}.`);
  },
});

/** A scenario's binding: any field of it, and whether its model reads images. */
type TestBinding = Partial<BoundModel> & { readonly supportsVision?: boolean };

function testBoundModel({
  supportsVision = false,
  ...overrides
}: TestBinding = {}): BoundModel {
  const config = buildTestModelConfig({
    contextWindow: 200_000,
    capabilities: { supportsVision },
  });
  return {
    modelId: 'test-model',
    catalogEntry: config,
    config,
    backend: 'deepseek',
    declinedRoutes: [],
    model: unusedModel,
    origin: TEST_ORIGIN,
    route: {
      kind: 'api-key',
      endpoint: 'https://api.deepseek.com',
      provider: 'deepseek',
      usageRoute: 'api-key',
    },
    forcedToolChoice: true,
    billing: 'api-key',
    maxOutputTokens: null,
    background: false,
    serviceTier: null,
    routes: routePolicies(['test-route'], 'test-model'),
    automaticRetries: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    textOnly: false,
    ...overrides,
  };
}

type HttpContent = Extract<TurnResult, { kind: 'http' }>['content'];

const httpTurn = (
  content: HttpContent,
  finishReason: 'stop' | 'length' | 'tool-calls',
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
  finishReason: 'stop' | 'length' = 'stop',
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
  | { readonly compactTo: readonly HistoryMessage[]; readonly turn: TurnResult }
  /** A compaction's own summary call answered with this text. */
  | { readonly summary: string }
  | { readonly failWith: RetryErrorInfo }
  | { readonly cancelled: true };

/** The turns a scenario hands the loop, in order; `seen` collects the request
 *  each one answered, and its length is the next turn's index. */
export function scriptedInvokerLayer(
  script: readonly ScriptedTurn[],
  seen: InvokeRequest[] = [],
) {
  return Layer.merge(unreachedModelAccess, scriptedInvoker(script, seen));
}

/** Model access a scripted run never reaches: its binding is the scenario's. */
const unreachedModelAccess = Layer.succeed(ModelAccess, {
  bind: () => Effect.die(new Error('A scripted run binds no model.')),
  admit: () => Effect.die(new Error('A scripted run switches no model.')),
  credentialSwitch: () => Effect.succeed(null),
});

function scriptedInvoker(
  script: readonly ScriptedTurn[],
  seen: InvokeRequest[],
) {
  return Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const aggregateId = qualifyAggregateId('run', run.runId);
      // The next scripted item, whichever call takes it.
      let cursor = 0;
      return {
        call: () =>
          Effect.suspend(() => {
            const scripted = script[cursor];
            if (scripted === undefined || !('summary' in scripted))
              return Effect.die(new Error('No compaction in this scenario.'));
            cursor += 1;
            return Effect.succeed({
              turn: textTurn(scripted.summary),
              usage: null,
            });
          }),
        invoke: (cell: RunCell, request: InvokeRequest) =>
          Effect.gen(function* () {
            const state = yield* cell.current;
            const scripted = script[cursor];
            cursor += 1;
            seen.push(request);
            if (scripted === undefined) {
              return yield* Effect.die(
                new Error('The scenario ran out of model turns.'),
              );
            }
            if ('summary' in scripted) {
              return yield* Effect.die(
                new Error('A summary was scripted where a turn was asked.'),
              );
            }
            if ('cancelled' in scripted) {
              return { kind: 'cancelled' as const, state };
            }
            if ('failWith' in scripted) {
              // As the invoker does: the failure commits before it returns,
              // as the `failed` row a resumed run reads back off the fold.
              return {
                kind: 'failed' as const,
                state: yield* cell.append([
                  {
                    type: 'model.message',
                    aggregateId,
                    payload: {
                      kind: 'failed',
                      invocation: { invocationId: randomUUID(), attempt: 1 },
                      error: scripted.failWith,
                      next: { kind: 'stop' },
                    },
                  },
                ]),
                error: scripted.failWith,
              };
            }
            const bound = yield* ScopedRef.get(run.model);
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
                  ),
                  usage: null,
                },
              },
              positionRow(run.runId, state, 'response.ready'),
            ]);
            return {
              kind: 'response' as const,
              state: next,
              text: turnText(turn),
            };
          }),
      };
    }),
  );
}

/**
 * The run service a fixture stands on: the session a real run carries,
 * no step opened, no callbacks. `over` names what the case under test reads.
 */
export function testAgentRun(
  base: Pick<AgentRunShape, 'runId' | 'logger' | 'model' | 'scope'> & {
    readonly session: Context.Context<SessionServices>;
  },
  over: Partial<AgentRunShape> = {},
): AgentRunShape {
  const { session, ...run } = base;
  const { runId, logger } = run;
  return {
    startedAt: 0,
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      agent: 'chat',
      model: 'test-model',
      instruction: 'Do the thing.',
    }),
    persona: Schema.decodeUnknownSync(PersonaSchema)({}),
    parentStage: logger.openStage('Run: chat'),
    toolPolicy: {},
    opening: {
      inputs: {},
      activated: [],
      attachedMemories: null,
      attachedMemoryMisses: [],
    },
    entry: {
      parent: null,
      awaited: false,
      registration: null,
      enter: (commit) => Effect.uninterruptible(commit(Effect.succeed([]))),
      initialUserMessage: 'Do the thing.',
    },
    fileService: new RunFileService(runId, Context.get(session, SessionRoots)),
    ...testRunTools(),
    finalToolName: null,
    callbacks: {},
    awaitedCalls: Semaphore.makeUnsafe(Number.MAX_SAFE_INTEGER),
    ...run,
    ...over,
  };
}

/** A scripted conversation run. */
export interface ScriptedRunInit {
  readonly runId: RunId;
  readonly session: Context.Context<SessionServices>;
  readonly tools?: Record<string, ITool>;
  readonly logger?: TraceEmitter;
  readonly bound?: TestBinding;
  /** A child run: its parent owns continuation across its turns. */
  readonly parentRunId?: RunId | null;
  /** Headless: the run stops after one turn instead of parking for input. */
  readonly stopAfterCycle?: boolean;
  /** The terminal structured-output tool, when the run has one. */
  readonly finalToolName?: string | null;
  readonly mediaFiles?: readonly string[];
  /** Absent means the launch had no transcript row to write. */
  readonly initialUserMessage?: string | undefined;
}

export function agentRunTestLayer(init: ScriptedRunInit) {
  // The run's session services, which the loop reads from its fiber.
  return Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const model = yield* ScopedRef.make(() => testBoundModel(init.bound));
      const logger = init.logger ?? new TraceEmitter();
      const scope: Scope.Scope = yield* Effect.scope;
      const tools = init.tools ?? {};
      return testAgentRun(
        { runId: init.runId, session: init.session, logger, model, scope },
        {
          config: Schema.decodeUnknownSync(AgentConfigSchema)({
            agent: 'chat',
            model: 'test-model',
            instruction: 'Do the thing.',
            ...(init.mediaFiles ? { mediaFiles: init.mediaFiles } : {}),
          }),
          persona: Schema.decodeUnknownSync(PersonaSchema)({
            tools: Object.keys(tools).map((name) => ({ name })),
          }),
          toolPolicy: { stopAfterCycle: init.stopAfterCycle === true },
          ...testRunTools(tools),
          finalToolName: init.finalToolName ?? null,
          callbacks: {},
          entry: {
            parent: init.parentRunId ?? null,
            awaited: false,
            registration: null,
            enter: (commit) =>
              Effect.uninterruptible(commit(Effect.succeed([]))),
            initialUserMessage:
              'initialUserMessage' in init
                ? init.initialUserMessage
                : 'Do the thing.',
          },
        },
      );
    }),
  ).pipe(Layer.provideMerge(Layer.succeedContext(init.session)));
}

/** A run id whose start is already on the session's log; with
 *  `parentRunId`, a child of that run, whose start goes first. */
export function startedRun(
  session: Context.Context<SessionServices>,
  parentRunId?: RunId,
): RunId {
  const runId = generateRunId();
  if (parentRunId !== undefined) publishTestRunStart(session, parentRunId);
  publishTestRunStart(session, runId, { parent: parentRunId ?? null });
  return runId;
}
