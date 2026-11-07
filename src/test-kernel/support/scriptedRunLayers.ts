/**
 * The loop harness the run-loop suites share: the run's own services over a
 * real session run history, with the model faked at its edge. A scripted
 * `Model` answers each attempt; the production `ModelInvoker` above it writes
 * the rows, so the fold, the resume rules and dispatch run against the
 * durable facts a live turn leaves behind.
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
  Stream,
} from 'effect';

import { RunFileService } from '@texra-ai/harness/plugins';
import { UsageLog } from '@texra-ai/harness/host';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { modelInvokerLayer } from '@agent/runtime/ModelInvoker';
import { makeRetryGate, RouteRetries } from '@agent/runtime/ModelRetryGate';
import {
  AgentRun,
  type AgentRunShape,
  type RunLaunch,
} from '@agent/runtime/run/AgentRun';
import { TraceEmitter } from '@agent/trace/TraceEmitter';
import {
  ModelAccess,
  type BoundModel,
} from '@agent/runtime/modelAccess/ModelAccess';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import { AgentConfigSchema, PersonaSchema, type RunId } from '@shared/schemas';
import { MODEL_RETRY_MAX_ATTEMPTS_SETTING } from '@texra-ai/harness/schemas';
import { generateRunId } from '@shared/schemas';
import { testRunTools } from '@test/support/nativeToolTestLayer';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { noopTrace } from '@test/support/noopTrace';
import { publishTestRunStart } from '@test/support/sessionTestUtils';

import {
  ModelError,
  ResolvedTurnSchema,
  type Model,
  type ModelOrigin,
  type TurnEvent,
  type TurnResult,
} from '@texra-ai/llm';

const TEST_ORIGIN = {
  protocol: 'openai-responses',
  codecVersion: 1,
  requestedModel: 'test-model',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'deepseek',
  },
} as const satisfies ModelOrigin;

/** What one attempt of a scripted model does: a finished turn, a failure the
 *  invoker judges as a provider's, or a stream that never ends. */
export type ScriptedAttempt = TurnResult | ModelError | 'hang';

export interface ScriptedModel {
  readonly model: Model;
  /** Attempts the model has served, in order. */
  readonly attempts: () => number;
}

/**
 * A `Model` that serves `script` one attempt at a time, repeating the last
 * entry once the script runs out. The invoker (and a compaction's summary
 * call) are its only callers, so this is the whole provider surface a run
 * drives.
 */
export function scriptedModel(
  script: readonly ScriptedAttempt[],
): ScriptedModel {
  let served = 0;
  const next = (): ScriptedAttempt => {
    const attempt = script[Math.min(served, script.length - 1)];
    served += 1;
    if (attempt === undefined) throw new Error('The script has no attempts.');
    return attempt;
  };
  const model: Model = {
    // The request as asked, under fixed controls: the invoker checks the
    // prepared turn against the run's rows.
    prepareTurn: ({ system, messages, tools, toolChoice }) =>
      Effect.succeed(
        Schema.decodeUnknownSync(ResolvedTurnSchema)({
          ...TEST_ORIGIN,
          mode: 'foreground',
          ...(system !== undefined ? { system } : {}),
          messages,
          tools: tools ?? [],
          controls: {
            temperature: null,
            maxOutputTokens: 1024,
            store: false,
            toolChoice: toolChoice ?? 'auto',
            reasoning: null,
            serviceTier: null,
          },
        }),
      ),
    streamTurn: () =>
      Stream.unwrap(
        Effect.sync(() => {
          const attempt = next();
          if (attempt === 'hang') return Stream.never;
          if (attempt instanceof ModelError) return Stream.fail(attempt);
          const completed: TurnEvent = { kind: 'completed', result: attempt };
          // A provider that names its response says so before it finishes.
          const events: TurnEvent[] =
            attempt.kind === 'http' && attempt.providerResponseId !== null
              ? [
                  {
                    kind: 'identified',
                    providerResponseId: attempt.providerResponseId,
                    requestedOrigin: attempt.requestedOrigin,
                    returnedModel: null,
                  },
                  completed,
                ]
              : [completed];
          return Stream.fromIterable(events);
        }),
      ),
  };
  return { model, attempts: () => served };
}

/** A scenario's binding: any field of it, and whether its model reads images. */
type TestBinding = Partial<BoundModel> & {
  readonly supportsVision?: boolean;
};

/** `model` bound the way `bindModel` binds an API-key route. */
export function testBinding(
  model: Model,
  { supportsVision = false, ...overrides }: TestBinding = {},
): BoundModel {
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
    model,
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
    automaticRetries: Schema.decodeUnknownSync(
      MODEL_RETRY_MAX_ATTEMPTS_SETTING.schema,
    )(undefined),
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

/** A turn that calls tools, each with its `input` (none when absent), after
 *  the text the model wrote alongside them. */
export const toolCallTurn = (
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input?: Readonly<Record<string, unknown>>;
  }[],
  text = '',
): TurnResult =>
  httpTurn(
    [
      ...textContent(text),
      ...calls.map((call) => ({
        kind: 'local-call' as const,
        providerCallId: call.id,
        name: call.name,
        argumentsText: JSON.stringify(call.input ?? {}),
      })),
    ],
    'tool-calls',
    `resp-${calls.map((call) => call.id).join('-')}`,
  );

/**
 * The production invoker over the run's own binding: model access rebinds to
 * the binding the run holds, usage is not recorded, and resends wait on the
 * process's route gate, as `processLayer` serves it.
 */
export const scriptedInvokerLayer = modelInvokerLayer().pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      UsageLog.disabled,
      Layer.sync(RouteRetries, makeRetryGate),
      Layer.effect(
        ModelAccess,
        Effect.gen(function* () {
          const run = yield* AgentRun;
          return {
            bind: () =>
              Effect.map(ScopedRef.get(run.model), (bound) => ({ ...bound })),
            admit: () =>
              Effect.die(new Error('A scripted run switches no model.')),
            credentialSwitch: () => Effect.succeed(null),
          };
        }),
      ),
    ),
  ),
);

/** The fixture task, which each launch is built from afresh. */
const TEST_INSTRUCTION = 'Do the thing.';
const testConfig = () =>
  Schema.decodeUnknownSync(AgentConfigSchema)({
    agent: 'chat',
    model: 'test-model',
    instruction: TEST_INSTRUCTION,
  });

/** A launch's entry with no parent, registration or opening trace. */
const testEntry = (): RunLaunch['entry'] => ({
  parent: null,
  awaited: false,
  registration: null,
  enter: (commit) => Effect.uninterruptible(commit(Effect.succeed([]))),
  initialUserMessage: TEST_INSTRUCTION,
});

/**
 * The launch a fixture run stands on: a `chat` run of the test model with
 * no opening inputs, tracing to `over.logger` (silent by default). `over`
 * names what the case under test reads.
 */
export function testLaunch(
  runId: RunId,
  over: Partial<RunLaunch> = {},
): RunLaunch {
  const logger = over.logger ?? noopTrace;
  const config = over.config ?? testConfig();
  return {
    runId,
    startedAt: 0,
    config,
    persona: Schema.decodeUnknownSync(PersonaSchema)({}),
    logger,
    parentStage: logger.openStage(`Run: ${config.agent}`),
    toolPolicy: {},
    opening: {
      inputs: {},
      activated: [],
      attachedMemories: null,
      attachedMemoryMisses: [],
    },
    entry: testEntry(),
    ...over,
  };
}

/**
 * The run service a fixture stands on: {@link testLaunch} with the session a
 * real run carries, no step opened and no callbacks. `over` names what the
 * case under test reads.
 */
export function testAgentRun(
  base: Pick<AgentRunShape, 'runId' | 'logger' | 'model' | 'scope'> & {
    readonly session: Context.Context<SessionServices>;
  },
  over: Partial<AgentRunShape> = {},
): AgentRunShape {
  const { session, runId, logger, model, scope } = base;
  return {
    ...testLaunch(runId, { logger }),
    model,
    scope,
    fileService: new RunFileService(runId, Context.get(session, SessionRoots)),
    ...testRunTools(),
    finalToolName: null,
    callbacks: {},
    awaitedCalls: Semaphore.makeUnsafe(Number.MAX_SAFE_INTEGER),
    ...over,
  };
}

/** A scripted conversation run. */
export interface ScriptedRunInit {
  readonly runId: RunId;
  readonly session: Context.Context<SessionServices>;
  readonly tools?: Record<string, ITool<Error, PluginToolServices>>;
  readonly logger?: TraceEmitter;
  /** The model the run is bound to, with the binding's overrides. */
  readonly model: Model;
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
      const model = yield* ScopedRef.make(() =>
        testBinding(init.model, init.bound),
      );
      const logger = init.logger ?? new TraceEmitter();
      const scope: Scope.Scope = yield* Effect.scope;
      const tools = init.tools ?? {};
      return testAgentRun(
        { runId: init.runId, session: init.session, logger, model, scope },
        {
          config: Schema.decodeUnknownSync(AgentConfigSchema)({
            ...testConfig(),
            ...(init.mediaFiles ? { mediaFiles: init.mediaFiles } : {}),
          }),
          persona: Schema.decodeUnknownSync(PersonaSchema)({
            tools: Object.keys(tools).map((name) => ({ name })),
          }),
          toolPolicy: { stopAfterCycle: init.stopAfterCycle === true },
          ...testRunTools(tools),
          finalToolName: init.finalToolName ?? null,
          entry: {
            ...testEntry(),
            parent: init.parentRunId ?? null,
            initialUserMessage:
              'initialUserMessage' in init
                ? init.initialUserMessage
                : TEST_INSTRUCTION,
          },
        },
      );
    }),
  ).pipe(Layer.provideMerge(Layer.succeedContext(init.session)));
}

/** A run id whose start is already on the session's log; with
 *  `parentRunId`, a child of that run, whose start goes first. */
export const startedRun = (
  session: Context.Context<SessionServices>,
  parentRunId?: RunId,
): Effect.Effect<RunId> =>
  Effect.gen(function* () {
    if (parentRunId !== undefined)
      yield* publishTestRunStart(session, parentRunId);
    return yield* publishTestRunStart(session, generateRunId(), {
      parent: parentRunId ?? null,
    });
  });
