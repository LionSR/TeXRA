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
import { setTimeout as delay } from 'node:timers/promises';

import { Effect, Fiber, Layer, Scope, Stream, SynchronizedRef } from 'effect';
import { it } from '@effect/vitest';
import { MODEL_CONFIGS } from 'llm-zoo';
import { describe, expect } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { dispatchPendingResponse } from '@agent/runtime/loop/toolUseDispatch';
import { appendRow, rowAggregate, snapshotRow } from '@agent/runtime/loop/rows';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { dispatchFactsFor } from '@agent/runtime/run/tools';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { noopTrace, type AgentTrace } from '@agent/trace';
import {
  TurnResultSchema,
  type Model,
  type ModelOrigin,
  type TurnResult,
} from '@llm/turn';
import {
  AgentCategory,
  AgentRunStateSnapshotSchema,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { createTestSession } from '@test/support/sessionTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

import { testModelCell } from './modelCellTestUtils';
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
  delayMs: number,
  options: { endTurn?: boolean; parallelSafe?: boolean } = {},
): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    parallelSafe: options.parallelSafe,
    async call(input: unknown): Promise<ToolResult> {
      const tag = `${name}:${JSON.stringify(input)}`;
      probe.events.push(`start ${tag}`);
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      await delay(delayMs);
      probe.inFlight -= 1;
      probe.events.push(`end ${tag}`);
      return {
        status: 'executed',
        output: `${tag} ok`,
        endTurn: options.endTurn,
      };
    },
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
    compatibilityKey: 'ModelHandlerOpenAI',
    model,
    origin: ORIGIN,
    usageProvider: 'openai',
    usageRoute: 'api-key',
    contextWindow: MODEL_CONFIGS.gpt54.contextWindow,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsReasoning: false,
    supportsForcedToolChoice: true,
    wireRouteKey: 'wire',
    modelRetryRouteKey: 'wire:gpt54',
    routedOnKimiCode: false,
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
  modelHandlerCompatibilityKey: 'ModelHandlerOpenAI',
  lastError: null,
  pendingRetry: null,
  messages: [],
  continuation: null,
  openAttempt: null,
  lastTurn: null,
  pendingResponse: null,
  pendingIntents: {},
  approvals: {},
  usage: AgentRunStateSnapshotSchema.parse({}).usageAccumulator.totals,
  flow: null,
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
  tools: MapToolRegistry,
  model: SynchronizedRef.SynchronizedRef<BoundModel>,
  rootUserInstruction: string | undefined,
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
    parentRunId: null,
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
    fileService: new TaskRunFileService(runId),
    tools,
    finalToolName: null,
    structured: { value: undefined },
    model,
    scope: Scope.makeUnsafe(),
    pendingModelSwitch: { value: null },
    inScope: (operation) => operation(),
    usageMonitor: new UsageMonitor(
      testModelCell(testModelInfo, 'gpt54'),
      { logger, runId, runStageId: undefined },
      { agentName: config.agent, agentCategory: setting.agentCategory },
    ),
    callbacks: { onModelChanged: () => undefined },
    interrupt: () => undefined,
  };
}

interface DispatchKit {
  readonly runId: RunId;
  readonly session: SessionHandle;
  /** The folded state with the turn's response pending and unsettled. */
  readonly state: RunState;
  readonly workspace: AgentWorkspaceState;
  readonly layer: Layer.Layer<AgentRun | RunLedger>;
}

interface HarnessOptions {
  readonly tools: Record<string, ITool>;
  readonly calls: readonly Call[];
  readonly rootUserInstruction?: string;
  readonly logger?: AgentTrace;
}

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
  yield* Effect.promise(() => session.settlePublications());
  yield* session.ledger.acquire(runId);
  const opened = yield* session.ledger.appendBatch(runId, null, [
    appendRow(runId, [
      { role: 'user', content: [{ kind: 'text', text: 'go' }] },
    ]),
    snapshotRow(runId, freshState(), {
      phase: 'initial',
      state: { shouldSkipCycle: false, stateSlices: null },
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
  const model = yield* SynchronizedRef.make(boundModel());
  const layer = Layer.mergeAll(
    Layer.succeed(
      AgentRun,
      agentRun(
        runId,
        session,
        logger,
        tools,
        model,
        options.rootUserInstruction,
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
  dispatchPendingResponse(kit.state, {
    workspace: kit.workspace,
    userInstruction,
  }).pipe(Effect.provide(kit.layer));

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
  it.effect('converts a malformed attachment result into a tool error', () =>
    Effect.gen(function* () {
      const malformedAttachmentTool: ITool = {
        definition: {
          name: 'malformed_attachment',
          description: 'malformed_attachment',
          parameters: {},
        },
        async call(): Promise<ToolResult> {
          // Deliberately malformed (`path` is a number): parsed from JSON so
          // the shape reaches the dispatch boundary unchecked, as a real tool
          // returning bad data would, without a cast asserting it is valid.
          return JSON.parse(
            '{"status":"executed","output":"not accepted","files":[{"path":42,"mimeType":"image/png"}]}',
          );
        },
      } as ITool;
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
      kit.session.dispose();
    }),
  );

  it.effect('preserves the unwrapped root instruction across delegation', () =>
    Effect.gen(function* () {
      let observedInstruction: string | undefined;
      let observedTrace: unknown;
      const inspectContext: ITool = {
        definition: {
          name: 'inspect_context',
          description: 'inspect_context',
          parameters: {},
        },
        async call(): Promise<ToolResult> {
          const context = getCurrentToolCallContext();
          observedInstruction = context?.userInstruction;
          observedTrace = context?.trace;
          return { status: 'executed', output: 'ok' };
        },
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
      kit.session.dispose();
    }),
  );

  it.effect('runs contiguous parallel-safe calls concurrently, in order', () =>
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
      kit.session.dispose();
    }),
  );

  it.effect('treats non-safe tools as ordering barriers', () =>
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
      kit.session.dispose();
    }),
  );

  it.effect('stops dispatch and ends the turn after a terminal result', () =>
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
      kit.session.dispose();
    }),
  );

  it.effect(
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
        kit.session.dispose();
      }),
  );

  // No fail-fast sibling interruption and no fabricated settlement: an
  // interrupted call is outcome-unknown, and resume asks rather than guesses.
  it.effect('commits no settlement for a call interrupted in flight', () =>
    Effect.gen(function* () {
      const probe = newProbe();
      const kit = yield* openDispatch({
        tools: {
          grep: probeTool(probe, 'grep', 60, { parallelSafe: true }),
          read_file: probeTool(probe, 'read_file', 60, { parallelSafe: true }),
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
      // A real wait, matching the probe tools' own real timers: the point is
      // that both calls are genuinely in flight when the interrupt lands.
      yield* Effect.promise(() => delay(15));
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
      kit.session.dispose();
    }),
  );

  it.effect('does not share read results across a mutating barrier', () =>
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
      kit.session.dispose();
    }),
  );

  it.effect(
    'allows an identical mutation again after a different mutation',
    () =>
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
        kit.session.dispose();
      }),
  );

  it.effect('shares the primary result for side-effect tool duplicates', () =>
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
      kit.session.dispose();
    }),
  );
});
