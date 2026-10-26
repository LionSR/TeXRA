/**
 * The dispatch guarantees the loop must keep: barrier segmentation, the
 * parallel-safe concurrency window, duplicate fan-out without repeated
 * effects, the terminal-result stop, and the deliberate absence of
 * fail-fast sibling interruption. Settlements are read where the model
 * reads them — the one delivered tool group — and, where a dispatch is
 * interrupted, off the run history it did or did not commit to.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';
import { it } from '@effect/vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { describe, expect } from 'vitest';
import {
  type Model,
  type ModelOrigin,
  type TurnResult,
  TurnResultSchema,
} from '@texra-ai/llm';

// Local imports
import type {
  RuntimeTool as ITool,
  RuntimeToolRegistry,
  ToolServices,
} from '@agent/runtime/ToolServices';
import { dispatchPendingResponse } from '@agent/runtime/loop/toolUseDispatch';
import { appendRow, positionRow, rowAggregate } from '@agent/runtime/loop/rows';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import { dispatchFactsFor, localCallsOf } from '@agent/runtime/run/tools';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentTrace } from '@agent/trace';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import type { PluginContext } from '@platform/processRuntime';
import {
  AgentConfigSchema,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  qualifyAggregateId,
  type RunId,
  type ToolDefinition,
  type ToolResult,
} from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunHistory, type RunCell } from '@shared/session/runHistory';
import { freshRunState, type RunState } from '@shared/session/runState';
import { testAgentRun } from '@test/support/scriptedRunLayers';
import { closeSessionOf } from '@test/support/sessionEnd';
import { noopTrace } from '@test/support/noopTrace';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { ScriptTool } from '@tools/codemode/ScriptTool';

import { recordSessionEvents } from './progressTestUtils';

const GPT54 = 'openai/gpt-5.4-2026-03-05';

/** The calls a folded state holds settled. */
const settledIds = (state: RunState | null | undefined): string[] =>
  Object.entries(state?.pendingResponse?.records ?? {}).flatMap(([id, call]) =>
    call.status.kind === 'settled' ? [id] : [],
  );

setupPlatform({ workspacePath: '/workspace' });

const ORIGIN = {
  protocol: 'openai-responses',
  codecVersion: 1,
  requestedModel: 'gpt-test',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'openai',
  },
} satisfies ModelOrigin;

interface DispatchProbe {
  events: string[];
  inFlight: number;
  maxInFlight: number;
}

function newProbe(): DispatchProbe {
  return { events: [], inFlight: 0, maxInFlight: 0 };
}

function probeTool(
  probe: DispatchProbe,
  name: string,
  wait: number | Effect.Effect<void>,
  options: { endTurn?: boolean; lane?: ITool['lane'] } = {},
): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    lane: options.lane,
    call: Effect.fn(function* (input: unknown): Effect.fn.Return<ToolResult> {
      const tag = `${name}:${JSON.stringify(input)}`;
      probe.events.push(`start ${tag}`);
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      yield* typeof wait === 'number' ? Effect.sleep(wait) : wait;
      probe.inFlight -= 1;
      probe.events.push(`end ${tag}`);
      return {
        status: 'executed',
        output: `${tag} ok`,
        endTurn: options.endTurn,
      };
    }),
  } as ITool;
}

interface Call {
  readonly callId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const makeCall = (
  callId: string,
  name: string,
  input: Record<string, unknown>,
): Call => ({ callId, name, input });

/** The completed turn whose calls the dispatch settles. */
function turnWithCalls(calls: readonly Call[]): TurnResult {
  return Schema.decodeUnknownSync(TurnResultSchema)({
    kind: 'http',
    providerResponseId: 'resp-1',
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: calls.map((call) => ({
      kind: 'local-call',
      providerCallId: call.callId,
      name: call.name,
      argumentsText: JSON.stringify(call.input),
    })),
    finishReason: 'tool-calls',
    usage: null,
  });
}

/** A binding whose model is never called: dispatch only reads capabilities. */
function boundModel(): BoundModel {
  const model: Model = {
    prepareTurn: () => Effect.die(new Error('dispatch issues no turn')),
    streamTurn: () => Stream.die(new Error('dispatch issues no turn')),
  };
  return {
    modelId: GPT54,
    config: {
      ...MODEL_CONFIGS[GPT54],
      capabilities: {
        ...MODEL_CONFIGS[GPT54].capabilities,
        supportsVision: false,
        supportsNativePdf: false,
        supportsNativeAudio: false,
      },
    },
    backend: 'openai',
    model,
    origin: ORIGIN,
    route: { kind: 'api-key', provider: 'openai', usageRoute: 'api-key' },
    forcedToolChoice: true,
    persistentConnection: false,
    billing: {},
    routes: routePolicies(['wire'], GPT54),
    delivery: Effect.succeed('foreground'),
    automaticRetries: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    textOnly: false,
  };
}

let dispatchRunCounter = 0;
const dispatchRunId = (): RunId =>
  `dd${(dispatchRunCounter++).toString(16).padStart(4, '0')}` as RunId;

/** The opening state of a fresh tool-use run, as the loop authors it. */
const freshState = (): RunState => ({
  ...freshRunState(0),
  family: 'toolUse',
  modelId: GPT54,
  backend: 'openai',
});

const INVOCATION = {
  invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d',
  attempt: 1,
} as const;
const RESPONSE_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

function agentRun(
  runId: RunId,
  session: SessionHandle,
  logger: AgentTrace,
  model: SynchronizedRef.SynchronizedRef<BoundModel>,
): AgentRunShape {
  return testAgentRun(
    { runId, session, logger, model, scope: Scope.makeUnsafe() },
    {
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: 'assistant',
        model: GPT54,
      }),
    },
  );
}

interface DispatchKit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  /** The folded state with the turn's response pending and unsettled. */
  readonly state: RunState;
  /** The cell a live dispatch runs on: opened before the response, which
   *  it then committed, as the invoker's does. */
  readonly cell: RunCell;
  /** The tools the dispatch's step offers. */
  readonly tools: RuntimeToolRegistry;
  readonly layer: Layer.Layer<
    AgentRun | RunHistory | Exclude<ToolServices, Scope.Scope>
  >;
}

interface HarnessOptions {
  readonly tools: Record<string, ITool>;
  readonly calls: readonly Call[];
  readonly logger?: AgentTrace;
  /** The run's binding, for the cases that read more than capabilities. */
  readonly bound?: BoundModel;
}

/**
 * Open a run aggregate and commit the completed turn the dispatch continues
 * from, exactly as `ModelInvoker` does before it hands over.
 */
const openDispatch = Effect.fn('openDispatch')(function* (
  options: HarnessOptions,
) {
  const session = yield* createTestSession();
  const runId = dispatchRunId();
  const logger = options.logger ?? noopTrace;
  const tools = new Map(Object.entries(options.tools));
  publishTestRunStart(session, runId);
  yield* session.log.settled;
  const cell = yield* session.runHistory.open(runId, {
    activation: () => Effect.succeed([]),
  });
  yield* cell.append([
    appendRow(runId, [
      { role: 'user', content: [{ kind: 'text', text: 'go' }] },
    ]),
    positionRow(runId, freshState(), 'turn.ready'),
  ]);
  const turn = turnWithCalls(options.calls);
  const state = yield* cell.append([
    {
      type: 'model.message',
      aggregateId: rowAggregate(runId),
      payload: {
        kind: 'attempt',
        request: '0'.repeat(64),
        invocation: INVOCATION,
        origin: ORIGIN,
        purpose: 'turn',
      },
    },
    {
      type: 'model.message',
      aggregateId: rowAggregate(runId),
      payload: {
        kind: 'response',
        responseId: RESPONSE_ID,
        invocation: INVOCATION,
        turn,
        calls: dispatchFactsFor(
          localCallsOf(turn.content),
          tools,
          logger,
          () => 'log-id',
        ),
        usage: null,
      },
    },
  ]);
  const model = yield* SynchronizedRef.make(options.bound ?? boundModel());
  const layer = Layer.mergeAll(
    nativeToolTestLayer(),
    Layer.succeed(AgentRun, agentRun(runId, session, logger, model)),
    Layer.succeed(RunHistory, session.runHistory),
  );
  return {
    runId,
    session,
    state,
    cell,
    tools,
    layer,
  } satisfies DispatchKit;
});

/** Dispatch the pending response of an opened run; `definitions` are the
 *  tools a script run in it may call. */
const dispatch = (kit: DispatchKit, definitions: ToolDefinition[] = []) =>
  dispatchPendingResponse(
    kit.cell,
    {
      definitions,
      registry: kit.tools,
      offered: [],
      services: Context.empty() as PluginContext,
      stepRoots: [],
      hooks: [],
      modules: {},
    },
    // The run's pending requests, as its `FollowUps.controls` reads them.
    Effect.map(kit.session.followUps.read(kit.runId), ({ followUps }) =>
      followUps.filter((f) => f.control !== undefined),
    ).pipe(Effect.orDie),
  ).pipe(Effect.provide(kit.layer));

describe('tool-use dispatch', () => {
  it.live(
    'leaves a durable tool write unsettled when it fails under an interrupt',
    () =>
      Effect.gen(function* () {
        const failure = new DatabaseWriteFailed({
          path: '/unavailable/state.sqlite',
          cause: new Error('disk write failed'),
        });
        const cause = Cause.combine(Cause.interrupt(), Cause.die(failure));
        const kit = yield* openDispatch({
          tools: {
            write_state: {
              definition: { name: 'write_state' },
              call: () => Effect.failCause(cause),
            },
          },
          calls: [makeCall('failed-write', 'write_state', {})],
        });
        const exit = yield* Effect.exit(dispatch(kit));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBe(failure);
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
        const saved = yield* kit.session.runHistory.load(kit.runId);
        expect(settledIds(saved)).toEqual([]);
        expect(saved?.pendingResponse).not.toBeNull();
        yield* closeSessionOf(kit.session);
      }),
  );

  // Failure mode: the guest ends (here it throws) while a call it issued is
  // still running. The sandbox interrupts that call, and nothing wrote its
  // result, so its intent and card stayed open forever and a resumed parent
  // counted the child it had launched as still owned.
  it.live(
    'settles a call its script issued and never awaited, before the script result',
    () =>
      Effect.gen(function* () {
        // `slow` never settles on its own; `fast` settles once `slow` has
        // started, so the guest ends while `slow` has its rows and no result.
        const never = yield* Deferred.make<void>();
        const slowStarted = yield* Deferred.make<void>();
        const probe = newProbe();
        const kit = yield* openDispatch({
          tools: {
            // cast: the built-in's services are the dispatch's.
            script: ScriptTool as unknown as ITool,
            slow: probeTool(
              probe,
              'slow',
              Deferred.succeed(slowStarted, undefined).pipe(
                Effect.andThen(Deferred.await(never)),
              ),
              { lane: 'parallel' },
            ),
            fast: probeTool(probe, 'fast', Deferred.await(slowStarted), {
              lane: 'parallel',
            }),
          },
          calls: [
            makeCall('c1', 'script', {
              code: 'const pending = tools.slow({}); await tools.fast({}); throw new Error("the guest gave up");',
            }),
          ],
        });

        yield* dispatch(kit, [
          { name: 'slow', description: 'slow', parameters: {} },
          { name: 'fast', description: 'fast', parameters: {} },
        ]);

        // The results as the run history committed them, in commit order.
        yield* kit.session.log.settled;
        const results = (yield* kit.session.log.rows(
          qualifyAggregateId('run', kit.runId),
          ['tool.result'],
        )).flatMap((row) => (row.type === 'tool.result' ? [row.payload] : []));
        const nested = results.findIndex((r) => r.callId === 'c1/0');
        const own = results.findIndex((r) => r.callId === 'c1');
        expect(nested).toBeGreaterThanOrEqual(0);
        expect(own).toBeGreaterThanOrEqual(0);
        expect(results[nested]?.disposition).toBe('skipped');
        const skipped = results[nested]?.result;
        const reason = skipped?.status === 'error' ? skipped.error : '';
        // It had started, so the reason carries the unknown-outcome warning.
        expect(reason).toContain(
          'The script ended while this call was running',
        );
        expect(reason).toContain('Its outcome is unknown');
        // Committed before the script's own result.
        expect(nested).toBeLessThan(own);
        yield* closeSessionOf(kit.session);
      }),
  );

  it.live('treats non-safe tools as ordering barriers', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          read_file: probeTool(probe, 'read_file', 20, { lane: 'parallel' }),
          write_file: probeTool(probe, 'write_file', 10),
        },
        calls: [
          makeCall('c1', 'read_file', { n: 1 }),
          makeCall('c2', 'write_file', { n: 2 }),
          makeCall('c3', 'read_file', { n: 3 }),
        ],
      });

      yield* dispatch(kit);

      expect(probe.maxInFlight).toBe(1);
      expect(probe.events).toEqual([
        'start read_file:{"n":1}',
        'end read_file:{"n":1}',
        'start write_file:{"n":2}',
        'end write_file:{"n":2}',
        'start read_file:{"n":3}',
        'end read_file:{"n":3}',
      ]);
      yield* closeSessionOf(kit.session);
    }),
  );

  // The settlement is the whole transactional boundary: the result and the
  // card that reports it commit together, and the edit and the call the
  // fold reads off the result need no other row.
  it.live('commits the card and the workspace with the tool result', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const editingTool: ITool = {
        definition: { name: 'edit_file', description: 'edit_file' },
        call: () =>
          Effect.sync((): ToolResult => {
            probe.events.push('end edit_file');
            return {
              status: 'executed',
              output: 'edited',
              edits: [
                { path: 'notes.tex', lineChanges: { added: 3, removed: 1 } },
              ],
            };
          }),
      };
      const kit = yield* openDispatch({
        tools: {
          edit_file: editingTool,
          slow_barrier: probeTool(probe, 'slow_barrier', 5_000),
        },
        calls: [
          makeCall('c1', 'edit_file', { path: 'notes.tex' }),
          makeCall('c2', 'slow_barrier', {}),
        ],
      });
      const recorded = recordSessionEvents(kit.session, {
        aggregateId: rowAggregate(kit.runId),
      });

      const fiber = yield* Effect.forkChild(dispatch(kit));
      // The barriers are ordered, so the second call starting is proof the
      // first has settled; the dispatch is then stopped before delivery.
      while (!probe.events.some((event) => event.startsWith('start slow'))) {
        yield* Effect.sleep(5);
      }
      yield* Fiber.interrupt(fiber);

      const folded = yield* Effect.provide(
        Effect.gen(function* () {
          const runHistory = yield* RunHistory;
          return yield* runHistory.load(kit.runId);
        }),
        kit.layer,
      );
      expect(settledIds(folded)).toEqual(['c1']);
      // No delivery ran: the edit and the call are folded from the
      // settlement itself. The interrupted barrier's call is not counted,
      // because it never settled.
      expect(folded?.edited).toEqual(['notes.tex']);
      expect(folded?.toolCalls).toBe(1);

      // The fast tool's card is now two rows of that same batch rather than a
      // pair of trace publications: exactly one open and one close reach the
      // display plane, and the interrupted second call opens none.
      const types = (yield* Effect.promise(() => recorded.read())).map(
        (event) => event.type,
      );
      expect(types.filter((type) => type === 'tool.start')).toHaveLength(1);
      expect(types.filter((type) => type === 'tool.end')).toHaveLength(1);
      yield* closeSessionOf(kit.session);
    }),
  );
});
