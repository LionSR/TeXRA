/**
 * The dispatch guarantees the loop must keep: barrier segmentation, the
 * parallel-safe concurrency window, duplicate fan-out without repeated
 * effects, the terminal-result stop, and the deliberate absence of
 * fail-fast sibling interruption. Settlements are read where the model
 * reads them — the one delivered tool group — and, where a dispatch is
 * interrupted, off the ledger it did or did not commit to.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports

import {
  Cause,
  Deferred,
  Exit,
  Effect,
  Fiber,
  Layer,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';
import { it } from '@effect/vitest';
import { MODEL_CONFIGS } from 'llm-zoo';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';
import { z } from 'zod';
import {
  TurnResultSchema,
  type Model,
  type ModelOrigin,
  type TurnResult,
} from '@texra-ai/llm/turn';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { ToolCall } from '@agent/runtime/ToolCall';
import type {
  RuntimeTool as ITool,
  RuntimeToolRegistry,
  ToolServices,
} from '@agent/runtime/ToolServices';
import { makeRunCell } from '@agent/runtime/loop/runProgram';
import { dispatchPendingResponse } from '@agent/runtime/loop/toolUseDispatch';
import {
  appendRow,
  familyState,
  rowAggregate,
  snapshotRow,
  type ToolUseFlowState,
} from '@agent/runtime/loop/rows';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { dispatchFactsFor } from '@agent/runtime/run/tools';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { TraceEmitter, type AgentEvent, type AgentTrace } from '@agent/trace';
import { DatabaseWriteFailed } from '@shared/session/database';
import {
  AgentCategory,
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  EMPTY_RUN_USAGE_TOTALS,
  formatZodIssuesForDiagnostics,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  nativeToolTestLayer,
  emptyPinnedComposition,
} from '@test/support/nativeToolTestLayer';
import { createTestSession } from '@test/support/sessionTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';
import { RunFileService } from '@utils/files/runStorage';

import { recordSessionEvents } from './progressTestUtils';
import { testModelInfo } from './runtime/launchContextTestUtils';

setupPlatform({ workspacePath: '/workspace' });

const ORIGIN = {
  protocol: 'openai-chat',
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
  options: { endTurn?: boolean; parallelSafe?: boolean } = {},
): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    parallelSafe: options.parallelSafe,
    call: Effect.fn(function* (
      input: unknown,
    ): Effect.fn.Return<ToolResult, never, ToolCall> {
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
  return TurnResultSchema.parse({
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
    generateTurn: () => Effect.die(new Error('dispatch issues no turn')),
  };
  return {
    modelId: 'gpt54',
    config: MODEL_CONFIGS.gpt54,
    compatibilityKey: 'OpenAI',
    model,
    origin: ORIGIN,
    route: { kind: 'api-key', provider: 'openai', usageRoute: 'api-key' },
    usageRoute: 'api-key',
    contextWindow: MODEL_CONFIGS.gpt54.contextWindow,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: true,
    wireRouteKey: 'wire',
    modelRetryRouteKey: 'wire:gpt54',
    backgroundCapable: false,
  };
}

let dispatchRunCounter = 0;
const dispatchRunId = (): RunId =>
  `dd${(dispatchRunCounter++).toString(16).padStart(4, '0')}` as RunId;

/** The opening state of a fresh tool-use run, as the loop authors it. */
const freshState = (): RunState => ({
  commit: 0,
  snapshotCommit: null,
  rowsBeforeSnapshot: 0,
  family: 'toolUse',
  step: null,
  outcome: null,
  phase: null,
  round: 0,
  turn: 0,
  continuationIndex: 0,
  modelId: 'gpt54',
  modelCompatibilityKey: 'OpenAI',
  lastError: null,
  pendingRetry: null,
  declinedRoutes: [],
  messages: [],
  continuation: null,
  openAttempt: null,
  lastTurn: null,
  pendingResponse: null,
  pendingIntents: {},
  requests: {},
  followUps: [],
  followUpIds: new Set(),
  usage: EMPTY_RUN_USAGE_TOTALS,
  flow: null,
  roundOutputs: [],
  overflowRecoveredAtRound: null,
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
  tools: RuntimeToolRegistry,
  model: SynchronizedRef.SynchronizedRef<BoundModel>,
  rootUserInstruction: string | undefined,
  pendingSwitch: string | null = null,
): AgentRunShape {
  const config = AgentConfigSchema.parse({
    agent: 'assistant',
    model: 'gpt54',
    agentCategory: AgentCategory.ToolUse,
    ...(rootUserInstruction === undefined ? {} : { rootUserInstruction }),
  });
  const setting = AgentSettingSchema.parse({
    agentCategory: AgentCategory.ToolUse,
  });
  return {
    runId,
    session,
    config,
    setting,
    prompt: AgentPromptSchema.parse({}),
    logger,
    parentStage: logger.openStage('Run: assistant'),
    // The launch stores a real run carries; no fixture reads through them.
    stores: hostStores(),
    toolPolicy: {},
    userVarChannels: {},
    initialUserMessageForTranscript: undefined,
    fileService: new RunFileService(runId, session.roots),
    tools,
    finalToolName: null,
    toolset: { offeredTools: [], toolsetHash: '0'.repeat(64) },
    composition: emptyPinnedComposition,
    structured: { value: undefined },
    model,
    scope: Scope.makeUnsafe(),
    declinedRoutes: [],
    pendingModelSwitch: { value: pendingSwitch },
    usageMonitor: new UsageMonitor(
      {
        logger,
        runId,
        runStageId: undefined,
        config: testWorkspaceRoots().config,
        usageLog: { log: () => {} },
      },
      { agentName: config.agent, agentCategory: setting.agentCategory },
    ),
    callbacks: { onModelChanged: () => undefined },
  };
}

interface DispatchKit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  /** The folded state with the turn's response pending and unsettled. */
  readonly state: RunState;
  readonly workspace: AgentWorkspaceState;
  readonly layer: Layer.Layer<
    AgentRun | RunLedger | Exclude<ToolServices, Scope.Scope>
  >;
}

interface HarnessOptions {
  readonly tools: Record<string, ITool>;
  readonly calls: readonly Call[];
  readonly rootUserInstruction?: string;
  readonly logger?: AgentTrace;
  /** Opened with the slices a real run carries, for the cases that read the
   *  workspace a settlement persisted. */
  readonly stateSlices?: ToolUseFlowState['stateSlices'];
  /** The run's binding, for the cases that read more than capabilities. */
  readonly bound?: BoundModel;
  /** A model switch waiting for the next boundary, for the upload gating. */
  readonly pendingSwitch?: string;
}

/** The slices of a run that has yet to touch a file. */
const emptySlices = (): NonNullable<ToolUseFlowState['stateSlices']> => ({
  workspaceSnapshot: AgentWorkspaceState.create().toSnapshot({
    excludeAssemblyStrings: true,
  }),
  userChannels: {},
});

/**
 * Open a run aggregate and commit the completed turn the dispatch continues
 * from, exactly as `ModelInvoker` does before it hands over.
 */
const openDispatch = Effect.fn('openDispatch')(function* (
  options: HarnessOptions,
) {
  const session = createTestSession();
  const runId = dispatchRunId();
  const logger = options.logger ?? noopTrace;
  const tools = new MapToolRegistry(options.tools);
  publishTestRunStart(session, runId);
  yield* session.settlePublications();
  yield* session.ledger.acquire(runId);
  const opened = yield* session.ledger.appendBatch(runId, null, [
    appendRow(runId, [
      { role: 'user', content: [{ kind: 'text', text: 'go' }] },
    ]),
    snapshotRow(runId, freshState(), {
      phase: 'initial',
      state: {
        family: 'toolUse',
        state: {
          stateSlices: options.stateSlices ?? null,
          offeredTools: [],
          toolsetHash: '0'.repeat(64),
        },
      },
    }),
  ]);
  const turn = turnWithCalls(options.calls);
  const state = yield* session.ledger.appendBatch(runId, opened, [
    {
      type: 'model.message',
      aggregateId: rowAggregate(runId),
      payload: {
        kind: 'attempt',
        invocation: INVOCATION,
        origin: ORIGIN,
        delivery: 'stream',
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
        calls: dispatchFactsFor(turn, tools, logger, () => 'log-id'),
        usage: null,
      },
    },
  ]);
  const model = yield* SynchronizedRef.make(options.bound ?? boundModel());
  const layer = Layer.mergeAll(
    nativeToolTestLayer(),
    Layer.succeed(
      AgentRun,
      agentRun(
        runId,
        session,
        logger,
        tools,
        model,
        options.rootUserInstruction,
        options.pendingSwitch ?? null,
      ),
    ),
    Layer.succeed(RunLedger, session.ledger),
  );
  return {
    runId,
    session,
    state,
    workspace: AgentWorkspaceState.create(),
    layer,
  } satisfies DispatchKit;
});

/** Dispatch the pending response of an opened run. */
const dispatch = (kit: DispatchKit, userInstruction?: string) =>
  makeRunCell(kit.runId, kit.state).pipe(
    Effect.flatMap((cell) =>
      dispatchPendingResponse(cell, {
        workspace: kit.workspace,
        userInstruction,
      }),
    ),
    Effect.provide(kit.layer),
  );

/** The one tool group the dispatch delivers, in call order. */
function deliveredResults(
  state: RunState,
): readonly { status: string; text: string }[] {
  const group = state.messages.at(-1);
  if (group === undefined || group.role !== 'tool') {
    throw new Error('The dispatch delivered no tool group.');
  }
  return group.results.map((result) => ({
    status: result.status,
    text: result.content
      .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
      .join(''),
  }));
}

function countStarts(probe: DispatchProbe, toolName = ''): number {
  return probe.events.filter((event) => event.startsWith(`start ${toolName}`))
    .length;
}

describe('tool-use dispatch', () => {
  it.live.each([
    'failure',
    'interrupted failure',
    'interrupted defect',
  ] as const)('leaves a durable tool write unsettled: %s', (mode) =>
    Effect.gen(function* () {
      const failure = new DatabaseWriteFailed({
        path: '/unavailable/state.sqlite',
        cause: new Error('disk write failed'),
      });
      const failureCause =
        mode === 'interrupted defect'
          ? Cause.die(failure)
          : Cause.fail(failure);
      const cause =
        mode === 'failure'
          ? failureCause
          : Cause.combine(Cause.interrupt(), failureCause);
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
        expect(Cause.hasInterrupts(exit.cause)).toBe(mode !== 'failure');
      }
      const saved = yield* kit.session.ledger.load(kit.runId);
      expect(Object.keys(saved?.pendingResponse?.settled ?? {})).toEqual([]);
      expect(saved?.pendingResponse).not.toBeNull();
      yield* kit.session.dispose();
    }),
  );

  it.live('converts a malformed attachment result into a tool error', () =>
    Effect.gen(function* () {
      const malformedAttachmentTool: ITool = {
        definition: {
          name: 'malformed_attachment',
          description: 'malformed_attachment',
          parameters: {},
        },
        call: () =>
          Effect.sync((): ToolResult => {
            // Deliberately malformed (`path` is a number): parsed from JSON so
            // the shape reaches the dispatch boundary unchecked, as a real tool
            // returning bad data would, without a cast asserting it is valid.
            return JSON.parse(
              '{"status":"executed","output":"not accepted","files":[{"path":42,"mimeType":"image/png"}]}',
            );
          }),
      };
      const kit = yield* openDispatch({
        tools: { malformed_attachment: malformedAttachmentTool },
        calls: [makeCall('c1', 'malformed_attachment', {})],
      });

      const { state } = yield* dispatch(kit);

      const [delivered] = deliveredResults(state);
      expect(delivered?.status).toBe('error');
      expect(delivered?.text).toMatch(
        /malformed_attachment: Tool returned an invalid result/i,
      );
      yield* kit.session.dispose();
    }),
  );

  it.live('settles a tool-input validation failure as a tool error', () =>
    Effect.gen(function* () {
      // An empty object against a required array: the issue names no
      // `received` value, and the settled row must still be JSON.
      const parsed = z.object({ files: z.array(z.string()) }).safeParse({});
      const invalidInputTool: ITool = {
        definition: { name: 'texcount', description: 'texcount' },
        call: () =>
          Effect.succeed<ToolResult>({
            status: 'error',
            error: 'Invalid input',
            diagnostics: {
              type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
              formatted: formatZodIssuesForDiagnostics(
                parsed.error?.issues ?? [],
              ),
            },
          }),
      };
      const kit = yield* openDispatch({
        tools: { texcount: invalidInputTool },
        calls: [makeCall('c1', 'texcount', {})],
      });

      const { state } = yield* dispatch(kit);

      const [delivered] = deliveredResults(state);
      expect(delivered?.status).toBe('error');
      expect(delivered?.text).toMatch(/Invalid input/);
      yield* kit.session.dispose();
    }),
  );

  it.live('preserves the unwrapped root instruction across delegation', () =>
    Effect.gen(function* () {
      let observedInstruction: string | undefined;
      let observedTrace: unknown;
      const inspectContext: ITool = {
        definition: {
          name: 'inspect_context',
          description: 'inspect_context',
          parameters: {},
        },
        call: Effect.fn(function* (): Effect.fn.Return<
          ToolResult,
          never,
          ToolCall
        > {
          const context = yield* ToolCall;
          observedInstruction = context?.userInstruction;
          observedTrace = context?.run?.logger;
          return { status: 'executed', output: 'ok' };
        }),
      } as ITool;
      const kit = yield* openDispatch({
        tools: { inspect_context: inspectContext },
        calls: [makeCall('c1', 'inspect_context', {})],
        rootUserInstruction: 'Do not use files or external tools.',
      });

      yield* dispatch(
        kit,
        'Wrapped child instruction with prior handoff boilerplate.',
      );

      expect(observedInstruction).toBe('Do not use files or external tools.');
      expect(observedTrace).toBe(noopTrace);
      yield* kit.session.dispose();
    }),
  );

  it.live(
    'bills a child cost reported before the call settled, not after',
    () =>
      Effect.gen(function* () {
        let report: ((costUsd: number) => void) | undefined;
        const delegate: ITool = {
          definition: {
            name: 'delegate',
            description: 'delegate',
            parameters: {},
          },
          call: Effect.fn(function* (): Effect.fn.Return<
            ToolResult,
            never,
            ToolCall
          > {
            const context = yield* ToolCall;
            report = context?.hooks?.recordSubagentCost;
            // An in-band one-shot child reports while its call is still open.
            report?.(2);
            return { status: 'executed', output: 'ok' };
          }),
        } as ITool;
        const trace = new TraceEmitter();
        const events: AgentEvent[] = [];
        trace.subscribe((event) => events.push(event));
        const kit = yield* openDispatch({
          tools: { delegate },
          calls: [makeCall('c1', 'delegate', {})],
          logger: trace,
        });

        const { state } = yield* dispatch(kit);
        // The latch must not close before the call returns: a one-shot
        // delegation is not `slow`, so gating it on the streamed-output latch
        // would drop every in-band cost.
        expect(state.usage.totalCost).toBe(2);

        // A detached child reports at its own run end, after the settlement
        // read the total. The spend stays on the child's own run, and the
        // report says so instead of incrementing a consumed local.
        report?.(5);
        expect(
          events.filter(
            (event) =>
              event.type === 'log' &&
              event.message.includes(
                'reported its cost after the call settled',
              ),
          ),
        ).toHaveLength(1);
        yield* kit.session.dispose();
      }),
  );

  it.live('runs contiguous parallel-safe calls concurrently, in order', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          grep: probeTool(probe, 'grep', 25, { parallelSafe: true }),
          read_file: probeTool(probe, 'read_file', 25, { parallelSafe: true }),
        },
        calls: [
          makeCall('c1', 'grep', { pattern: 'a' }),
          makeCall('c2', 'read_file', { path: 'b' }),
        ],
      });

      const { state } = yield* dispatch(kit);

      expect(probe.maxInFlight).toBe(2);
      expect(deliveredResults(state).map((result) => result.status)).toEqual([
        'success',
        'success',
      ]);
      expect(deliveredResults(state)[0]?.text).toContain(
        'grep:{"pattern":"a"}',
      );
      yield* kit.session.dispose();
    }),
  );

  it.live('treats non-safe tools as ordering barriers', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          read_file: probeTool(probe, 'read_file', 20, { parallelSafe: true }),
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
      yield* kit.session.dispose();
    }),
  );

  it.live('stops dispatch and ends the turn after a terminal result', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          submit_output: probeTool(probe, 'submit_output', 0, {
            endTurn: true,
          }),
          write_file: probeTool(probe, 'write_file', 0),
        },
        calls: [
          makeCall('c1', 'submit_output', { title: 'done' }),
          makeCall('c2', 'write_file', { path: 'late.txt' }),
        ],
      });

      const outcome = yield* dispatch(kit);

      expect(probe.events).toEqual([
        'start submit_output:{"title":"done"}',
        'end submit_output:{"title":"done"}',
      ]);
      expect(outcome.endTurn).toBe(true);
      // The skipped call still settles: the model sees a complete group.
      const delivered = deliveredResults(outcome.state);
      expect(delivered[1]?.status).toBe('error');
      expect(delivered[1]?.text).toContain(
        'an earlier tool call ended the turn',
      );
      yield* kit.session.dispose();
    }),
  );

  it.live(
    'executes duplicate parallel calls once and fans the result out',
    () =>
      Effect.gen(function* () {
        const probe = newProbe();
        const kit = yield* openDispatch({
          tools: { grep: probeTool(probe, 'grep', 5, { parallelSafe: true }) },
          calls: [
            makeCall('c1', 'grep', { pattern: 'same' }),
            makeCall('c2', 'grep', { pattern: 'same' }),
            makeCall('c3', 'grep', { pattern: 'other' }),
          ],
        });

        const { state } = yield* dispatch(kit);

        expect(countStarts(probe)).toBe(2);
        const delivered = deliveredResults(state);
        expect(delivered[1]?.status).toBe('success');
        expect(delivered[1]?.text).toBe(delivered[0]?.text);
        yield* kit.session.dispose();
      }),
  );

  // The settlement is the whole transactional boundary: the result, the card
  // that reports it, and the workspace the call mutated commit together, so a
  // stop before the delivering snapshot cannot leave a settled call whose
  // edits, media and tool-call count existed only in memory.
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
        stateSlices: emptySlices(),
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
          const ledger = yield* RunLedger;
          return yield* ledger.load(kit.runId);
        }),
        kit.layer,
      );
      expect(Object.keys(folded?.pendingResponse?.settled ?? {})).toEqual([
        'c1',
      ]);
      // No delivery ran, so this workspace can only have come from the
      // settlement's own state operation.
      const slices = familyState(folded!, 'toolUse')?.stateSlices;
      expect(slices?.workspaceSnapshot.interactions.edits).toEqual([
        { path: 'notes.tex', added: 3, removed: 1 },
      ]);
      // The count the settling call had made: the interrupted barrier's own
      // call is not in it, because it never settled.
      expect(slices?.workspaceSnapshot.interactions.toolCallCount).toBe(1);

      // The fast tool's card is now two rows of that same batch rather than a
      // pair of trace publications: exactly one open and one close reach the
      // display plane, and the interrupted second call opens none.
      const types = (yield* Effect.promise(() => recorded.read())).map(
        (event) => event.type,
      );
      expect(types.filter((type) => type === 'tool.start')).toHaveLength(1);
      expect(types.filter((type) => type === 'tool.end')).toHaveLength(1);
      yield* kit.session.dispose();
    }),
  );

  // No fail-fast sibling interruption and no fabricated settlement: an
  // interrupted call is outcome-unknown, and resume asks rather than guesses.
  it.live('commits no settlement for a call interrupted in flight', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const bothStarted = yield* Deferred.make<void>();
      const awaitInterruption = Effect.gen(function* () {
        if (probe.inFlight === 2)
          yield* Deferred.succeed(bothStarted, undefined);
        yield* Effect.never;
      });
      const kit = yield* openDispatch({
        tools: {
          grep: probeTool(probe, 'grep', awaitInterruption, {
            parallelSafe: true,
          }),
          read_file: probeTool(probe, 'read_file', awaitInterruption, {
            parallelSafe: true,
          }),
        },
        calls: [
          makeCall('c1', 'grep', { pattern: 'a' }),
          makeCall('c2', 'read_file', { path: 'b' }),
          // A duplicate of the interrupted primary: it must derive nothing
          // from a call whose outcome nobody knows.
          makeCall('c3', 'grep', { pattern: 'a' }),
        ],
      });

      const fiber = yield* Effect.forkChild(dispatch(kit));
      // Interrupt only after both calls have entered and are held in flight.
      yield* Deferred.await(bothStarted);
      expect(probe.maxInFlight).toBe(2);
      yield* Fiber.interrupt(fiber);

      const folded = yield* Effect.provide(
        Effect.gen(function* () {
          const ledger = yield* RunLedger;
          return yield* ledger.load(kit.runId);
        }),
        kit.layer,
      );
      const pending = folded?.pendingResponse ?? null;
      expect(Object.keys(pending?.settled ?? {})).toEqual([]);
      // The duplicate is recognised as one and still settles nothing: with
      // the primary interrupted it waits rather than fabricating a result.
      expect(
        pending?.calls.find((fact) => fact.callId === 'c3')?.duplicateOf,
      ).toBe('c1');
      expect(countStarts(probe, 'grep')).toBe(1);
      yield* kit.session.dispose();
    }),
  );

  it.live('does not share read results across a mutating barrier', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          read_file: probeTool(probe, 'read_file', 5, { parallelSafe: true }),
          write_file: probeTool(probe, 'write_file', 5),
        },
        calls: [
          makeCall('c1', 'read_file', { path: 'x' }),
          makeCall('c2', 'write_file', { path: 'x', content: 'new' }),
          makeCall('c3', 'read_file', { path: 'x' }),
        ],
      });

      const { state } = yield* dispatch(kit);

      // The post-barrier read must execute again — the write may have changed
      // what it returns, so sharing the pre-barrier result would feed the
      // model stale contents.
      expect(countStarts(probe, 'read_file')).toBe(2);
      expect(deliveredResults(state)[2]?.status).toBe('success');
      yield* kit.session.dispose();
    }),
  );

  it.live('allows an identical mutation again after a different mutation', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          write_file: probeTool(probe, 'write_file', 5),
          edit_file: probeTool(probe, 'edit_file', 5),
        },
        calls: [
          makeCall('c1', 'write_file', { path: 'x', content: 'v1' }),
          makeCall('c2', 'edit_file', { path: 'x', patch: 'p' }),
          makeCall('c3', 'write_file', { path: 'x', content: 'v1' }),
        ],
      });

      const { state } = yield* dispatch(kit);

      // The edit changed state, so re-issuing the identical write is a
      // plausible restore — it must execute, not be swallowed as a glitch.
      expect(countStarts(probe, 'write_file')).toBe(2);
      expect(deliveredResults(state)[2]?.status).toBe('success');
      yield* kit.session.dispose();
    }),
  );

  it.live('shares the primary result for side-effect tool duplicates', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: { write_file: probeTool(probe, 'write_file', 5) },
        calls: [
          makeCall('c1', 'write_file', { path: 'a', content: 'x' }),
          makeCall('c2', 'write_file', { path: 'a', content: 'x' }),
        ],
      });

      const { state } = yield* dispatch(kit);

      expect(countStarts(probe)).toBe(1);
      const delivered = deliveredResults(state);
      expect(delivered[0]?.status).toBe('success');
      // Accidental re-emissions get the primary's result, not an error.
      expect(delivered[1]?.status).toBe('success');
      expect(delivered[1]?.text).toBe(delivered[0]?.text);
      yield* kit.session.dispose();
    }),
  );

  it.effect(
    'keeps delivered documents as bytes and bounds a stalled upload by its deadline',
    () =>
      Effect.gen(function* () {
        const pdf = Buffer.from('%PDF-1.7').toString('base64');
        const warnings: string[] = [];
        // `a.pdf` finishes only once `b.pdf` has started, and `b.pdf` never
        // answers: uploads taken one at a time would never reach `b.pdf`.
        const bStarted = yield* Deferred.make<void>();
        const uploading: Model = {
          ...boundModel().model,
          uploadFile: (file) =>
            file.filename === 'a.pdf'
              ? Deferred.await(bStarted)
              : Effect.sync(() =>
                  Deferred.doneUnsafe(bStarted, Effect.void),
                ).pipe(Effect.andThen(Effect.never)),
        };
        const kit = yield* openDispatch({
          tools: {
            fetch_papers: {
              definition: { name: 'fetch_papers' },
              call: () =>
                Effect.succeed({
                  status: 'executed',
                  output: 'fetched',
                  files: ['a.pdf', 'b.pdf'].map((path) => ({
                    path,
                    mimeType: 'application/pdf',
                    base64Data: pdf,
                  })),
                } satisfies ToolResult),
            } as ITool,
          },
          calls: [makeCall('fetch', 'fetch_papers', {})],
          logger: {
            ...noopTrace,
            warn: (message: string) => {
              warnings.push(message);
            },
          },
          bound: {
            ...boundModel(),
            model: uploading,
            supportsVision: true,
            supportsNativePdf: true,
          },
        });
        const delivering = yield* Effect.forkChild(dispatch(kit));
        yield* Deferred.await(bStarted);
        yield* TestClock.adjust('5 seconds');
        const outcome = yield* Fiber.join(delivering);
        expect(warnings).toStrictEqual([expect.stringContaining('"b.pdf"')]);
        const group = outcome.state.messages.at(-1);
        if (group?.role !== 'tool') {
          throw new Error('The dispatch delivered no tool group.');
        }
        // The ledger holds the bytes; a file id only ever lives in memory.
        expect(group.results[0]?.content.slice(1)).toStrictEqual([
          { kind: 'document', mimeType: 'application/pdf', base64: pdf },
          { kind: 'document', mimeType: 'application/pdf', base64: pdf },
        ]);
        yield* kit.session.dispose();
      }),
  );

  it.effect('bounds the whole upload batch by one aggregate deadline', () =>
    Effect.gen(function* () {
      const pdf = Buffer.from('%PDF-1.7').toString('base64');
      const warnings: string[] = [];
      // Five stalled uploads: past the four-wide window, a per-item
      // deadline would hold delivery for two waves.
      const started = yield* Deferred.make<void>();
      const uploading: Model = {
        ...boundModel().model,
        uploadFile: () =>
          Effect.sync(() => Deferred.doneUnsafe(started, Effect.void)).pipe(
            Effect.andThen(Effect.never),
          ),
      };
      const kit = yield* openDispatch({
        tools: {
          fetch_papers: {
            definition: { name: 'fetch_papers' },
            call: () =>
              Effect.succeed({
                status: 'executed',
                output: 'fetched',
                files: ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'].map(
                  (path) => ({
                    path,
                    mimeType: 'application/pdf',
                    base64Data: pdf,
                  }),
                ),
              } satisfies ToolResult),
          } as ITool,
        },
        calls: [makeCall('fetch', 'fetch_papers', {})],
        logger: {
          ...noopTrace,
          warn: (message: string) => {
            warnings.push(message);
          },
        },
        bound: {
          ...boundModel(),
          model: uploading,
          supportsVision: true,
          supportsNativePdf: true,
        },
      });
      const delivering = yield* Effect.forkChild(dispatch(kit));
      yield* Deferred.await(started);
      yield* TestClock.adjust('5 seconds');
      const outcome = yield* Fiber.join(delivering);
      expect(warnings).toStrictEqual([
        expect.stringContaining('"a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"'),
      ]);
      expect(outcome.state.messages.at(-1)?.role).toBe('tool');
      yield* kit.session.dispose();
    }),
  );

  it.effect('uploads nothing while a model switch waits for the boundary', () =>
    Effect.gen(function* () {
      const pdf = Buffer.from('%PDF-1.7').toString('base64');
      let uploads = 0;
      const uploading: Model = {
        ...boundModel().model,
        uploadFile: () => Effect.sync(() => uploads++),
      };
      const kit = yield* openDispatch({
        tools: {
          fetch_papers: {
            definition: { name: 'fetch_papers' },
            call: () =>
              Effect.succeed({
                status: 'executed',
                output: 'fetched',
                files: [
                  {
                    path: 'a.pdf',
                    mimeType: 'application/pdf',
                    base64Data: pdf,
                  },
                ],
              } satisfies ToolResult),
          } as ITool,
        },
        calls: [makeCall('fetch', 'fetch_papers', {})],
        pendingSwitch: 'claude-sonnet-4',
        bound: {
          ...boundModel(),
          model: uploading,
          supportsVision: true,
          supportsNativePdf: true,
        },
      });
      const { state } = yield* dispatch(kit);
      expect(uploads).toBe(0);
      // The bytes still deliver; only the optional upload is skipped.
      const group = state.messages.at(-1);
      if (group?.role !== 'tool') {
        throw new Error('The dispatch delivered no tool group.');
      }
      expect(group.results[0]?.content.slice(1)).toStrictEqual([
        { kind: 'document', mimeType: 'application/pdf', base64: pdf },
      ]);
      yield* kit.session.dispose();
    }),
  );
});
