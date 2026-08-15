import { describe, expect, it, vi } from 'vitest';

const roundFlowState = vi.hoisted(() => ({
  shouldStop: false,
  endTurn: false,
  lastError: undefined as
    { message: string; userRetryable: boolean } | undefined,
  finalTool: undefined as { name: string } | undefined,
}));

vi.mock('@agent/implementations/flows/tooluse/ToolUseRoundFlow', () => ({
  createToolUseRoundFlow: () => ({
    setServices() {},
    async run(shared: {
      shouldStop: boolean;
      endTurn: boolean;
      lastError?: { message: string; userRetryable: boolean };
      finalTool?: { name: string };
    }) {
      roundFlowState.finalTool = shared.finalTool;
      shared.shouldStop = roundFlowState.shouldStop;
      shared.endTurn = roundFlowState.endTurn;
      shared.lastError = roundFlowState.lastError;
    },
  }),
}));

import { TraceEmitter } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ToolUseCycleNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseCycleNode';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type {
  CyclePrepResult,
  ToolUseRunShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  type Plan,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { isObject } from '@utils/core';

import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
  testRunScope,
  withTestRunContext,
} from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

const todo: TodoItem = {
  content: 'Wire progress events through runtime host',
  status: 'in_progress',
  activeForm: 'Wiring progress events',
};

const plan: Plan = {
  objective:
    'Move progress publication behind the runtime host.\n' +
    'Publish tool-use cycle state through interactions.',
};

function createPrepResult(
  workspaceState: AgentWorkspaceState,
  shouldSkipCycle = true,
  cycleStartLastResponse = '',
): CyclePrepResult {
  return {
    shouldSkipCycle,
    messages: [],
    runState: AgentRunStateSnapshotSchema.parse({}),
    workspaceState,
    cycleStartLastResponse,
    userChannels: { input: {}, transient: {} },
  };
}

function setRoundFlowState(state: Partial<typeof roundFlowState>): void {
  Object.assign(roundFlowState, {
    shouldStop: false,
    endTurn: false,
    lastError: undefined,
    finalTool: undefined,
    ...state,
  });
}

function createErrorLoggerNode(): {
  error: ReturnType<typeof vi.fn>;
  node: ToolUseCycleNode<unknown>;
} {
  const error = vi.fn();
  const node = new ToolUseCycleNode().setServices({
    logger: { error },
  } as unknown as ToolUseServices);
  return { error, node };
}

type CycleOutcome = Parameters<ToolUseCycleNode<unknown>['post']>[2];

// Runs ToolUseCycleNode.post against a prepared workspace with only the
// onCycleResponse service wired, returning the spy and mutated shared state.
async function runCyclePost(options: {
  assemblyText?: string;
  shouldSkipCycle: boolean;
  prepBaseline?: string;
  sharedLastResponse?: string;
  result: CycleOutcome;
}): Promise<{
  onCycleResponse: ReturnType<typeof vi.fn>;
  shared: ToolUseRunShared;
}> {
  const workspaceState = AgentWorkspaceState.create();
  if (options.assemblyText !== undefined) {
    workspaceState.assembly.lastResponse = options.assemblyText;
  }
  const prepRes = createPrepResult(
    workspaceState,
    options.shouldSkipCycle,
    options.prepBaseline ?? '',
  );
  const shared = (
    options.sharedLastResponse === undefined
      ? {}
      : { lastResponse: options.sharedLastResponse }
  ) as ToolUseRunShared;
  const onCycleResponse = vi.fn();
  const node = new ToolUseCycleNode().setServices({
    onCycleResponse,
  } as unknown as ToolUseServices);

  await node.post(shared, prepRes, options.result);
  return { onCycleResponse, shared };
}

function createCycleNode(
  streamId: StreamTabId,
  host: ReturnType<typeof createRecordingHost>['host'],
  logger: TraceEmitter,
  overrides: Record<string, unknown> = {},
): ToolUseCycleNode<unknown> {
  return new ToolUseCycleNode<unknown>().setServices({
    runScope: testRunScope(streamId, { interactions: host }),
    logger,
    modelCell: testModelCell({ getClient: vi.fn() }),
    onRoundFinalized: vi.fn(),
    config: { model: 'test-model', agent: 'test-agent' },
    setting: { tools: [] },
    ...overrides,
  } as unknown as ToolUseServices);
}

describe('tool-use progress events', () => {
  const forcedToolOverrides = (tools: { name: string }[]) => ({
    modelCell: testModelCell({
      getClient: vi.fn(),
      supportsForcedToolChoice: true,
    }),
    finalTool: { name: 'submit_output' },
    setting: { tools },
  });

  it('collapses a run whose only tool is the terminal tool to one forced round', async () => {
    setRoundFlowState({ endTurn: true });
    const { host } = createRecordingHost();
    const streamId = 'stream:single-shot-final-tool' as StreamTabId;
    const node = createCycleNode(
      streamId,
      host,
      new TraceEmitter(),
      forcedToolOverrides([{ name: 'submit_output' }]),
    );

    await withTestRunContext(node.services.runScope, () =>
      node.exec(createPrepResult(AgentWorkspaceState.create(), false)),
    );

    expect(roundFlowState.finalTool).toEqual({ name: 'submit_output' });
  });

  it('does not force the first round of a headless run with exploration tools', async () => {
    setRoundFlowState({ endTurn: true });
    const { host } = createRecordingHost();
    const streamId = 'stream:headless-final-tool' as StreamTabId;
    const node = createCycleNode(
      streamId,
      host,
      new TraceEmitter(),
      forcedToolOverrides([{ name: 'read_file' }, { name: 'submit_output' }]),
    );

    await withTestRunContext(
      node.services.runScope,
      () => node.exec(createPrepResult(AgentWorkspaceState.create(), false)),
      { stopAfterCycle: true },
    );

    expect(roundFlowState.finalTool).toBeUndefined();
  });

  it('publishes skipped-cycle todo and plan events through the runtime host', async () => {
    const { host } = createRecordingHost();
    const logger = new TraceEmitter();
    const hub = new SessionEventHub();
    const recorded = recordSessionEvents(hub, { scope: 'run' });
    const streamId = 'stream:tool-use-cycle' as StreamTabId;
    const detachTrace = logger.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const workspaceState = AgentWorkspaceState.create();
    workspaceState.workPlan.updateTodos([todo]);
    workspaceState.workPlan.updatePlan(plan);

    const node = createCycleNode(streamId, host, logger);

    try {
      const result = await withTestRunContext(node.services.runScope, () =>
        node.exec(createPrepResult(workspaceState)),
      );

      expect(result).toEqual({ outcome: 'skipped' });
      expect(runEventsOfType(recorded.events, 'updateTodos')).toMatchObject([
        { streamId, todos: [todo] },
      ]);
      expect(runEventsOfType(recorded.events, 'updatePlan')).toMatchObject([
        { streamId, plan },
      ]);
    } finally {
      recorded.detach();
      detachTrace();
    }
  });

  it('logs outer cycle exceptions before storing the failed outcome', async () => {
    const workspaceState = AgentWorkspaceState.create();
    const prepRes = createPrepResult(workspaceState);
    const shared: Partial<ToolUseRunShared> = {};
    const { error, node } = createErrorLoggerNode();

    const failed = await node.execFallback(
      prepRes,
      new Error('Model claude-opus-4-7 not found'),
    );
    const transition = await node.post(
      shared as ToolUseRunShared,
      prepRes,
      failed,
    );

    expect(transition).toBe(FlowTransition.DEFAULT);
    expect(shared.lastError).toMatchObject({
      message: 'Model claude-opus-4-7 not found',
    });
    expect(error).toHaveBeenCalledWith('Model claude-opus-4-7 not found', {
      messageType: MESSAGE_TYPES.ERROR,
    });
  });

  it('does not repeat an inner model failure at the outer cycle boundary', async () => {
    const prepRes = createPrepResult(AgentWorkspaceState.create());
    const shared: Partial<ToolUseRunShared> = {};
    const { error, node } = createErrorLoggerNode();

    const lastError = {
      message: 'HTTP 503 Service Unavailable',
      userRetryable: true,
    };
    await node.post(shared as ToolUseRunShared, prepRes, {
      outcome: 'failed',
      lastError,
    });

    expect(shared.lastError).toBe(lastError);
    expect(error).not.toHaveBeenCalled();
  });

  it('reports partial assistant text from a failed non-skipped cycle', async () => {
    const { onCycleResponse, shared } = await runCyclePost({
      assemblyText: 'same response',
      shouldSkipCycle: false,
      sharedLastResponse: 'same response',
      result: {
        outcome: 'failed',
        lastError: { message: 'stream failed', userRetryable: true },
      },
    });

    expect(onCycleResponse).toHaveBeenCalledWith('same response');
    expect(shared.lastResponse).toBe('same response');
  });

  it('does not report restored assembly text from a skipped prepare cycle', async () => {
    const { onCycleResponse } = await runCyclePost({
      assemblyText: 'historical response',
      shouldSkipCycle: true,
      result: { outcome: 'skipped' },
    });

    expect(onCycleResponse).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    sharedLastResponse?: string;
    result: CycleOutcome;
  }>([
    {
      name: 'completed',
      sharedLastResponse: 'previous turn response',
      result: { outcome: 'completed', messages: [] },
    },
    {
      name: 'failed',
      sharedLastResponse: undefined,
      result: {
        outcome: 'failed',
        lastError: { message: 'stream failed', userRetryable: true },
      },
    },
  ])(
    'does not return the previous cycle response for an answerless $name cycle',
    async ({ sharedLastResponse, result }) => {
      // Assembly text unchanged since prep is historical: the cycle produced no
      // new assistant response, so it must not become this cycle's result (#9531).
      const { onCycleResponse, shared } = await runCyclePost({
        assemblyText: 'previous turn response',
        shouldSkipCycle: false,
        prepBaseline: 'previous turn response',
        sharedLastResponse,
        result,
      });

      expect(onCycleResponse).not.toHaveBeenCalled();
      expect(shared.lastResponse).toBeUndefined();
    },
  );

  it('reports assembly text written during the cycle over the prep baseline', async () => {
    // The failure path in exec copies this cycle's partial text into assembly;
    // differing from the prep-time baseline is what makes it reportable.
    const { onCycleResponse, shared } = await runCyclePost({
      assemblyText: 'partial cycle text',
      shouldSkipCycle: false,
      prepBaseline: 'previous turn response',
      result: {
        outcome: 'failed',
        lastError: { message: 'stream failed', userRetryable: true },
      },
    });

    expect(onCycleResponse).toHaveBeenCalledWith('partial cycle text');
    expect(shared.lastResponse).toBe('partial cycle text');
  });

  it('persists a completed cycle structured result in shared state', async () => {
    const prepRes = createPrepResult(AgentWorkspaceState.create());
    const shared: Partial<ToolUseRunShared> = {};
    const structured = { title: 'Durable result' };
    const node = new ToolUseCycleNode().setServices({
      getPendingStructuredOutput: () => structured,
    } as unknown as ToolUseServices);

    await node.post(shared as ToolUseRunShared, prepRes, {
      outcome: 'completed',
      messages: [],
    });

    expect(shared.structured).toEqual(structured);
  });
});

describe('tool-use session-stage outcome persistence (#8023)', () => {
  it.each([
    {
      name: 'completed',
      shouldStop: false,
      endTurn: false,
      lastError: undefined,
      expectedOutcome: 'completed',
      expectedStatus: RUN_OUTCOME.COMPLETED,
    },
    {
      name: 'failed',
      shouldStop: true,
      endTurn: false,
      lastError: { message: 'round failed', userRetryable: false },
      expectedOutcome: 'failed',
      expectedStatus: RUN_OUTCOME.FAILED,
    },
    {
      name: 'cancelled',
      shouldStop: true,
      endTurn: false,
      lastError: undefined,
      expectedOutcome: 'cancelled',
      expectedStatus: RUN_OUTCOME.CANCELLED,
    },
  ])(
    'persists a $name outer turn as a structural session stage',
    async ({
      name,
      shouldStop,
      endTurn,
      lastError,
      expectedOutcome,
      expectedStatus,
    }) => {
      setRoundFlowState({ shouldStop, endTurn, lastError });

      const { host } = createRecordingHost();
      const logger = new TraceEmitter();
      const streamId = `stream:tool-use-round-${name}` as StreamTabId;
      const store = StreamLogStore.ephemeral('test');
      store.ensureStream(streamId);
      const recorder = attachTranscriptRecorder(
        logger,
        store.acquireWriter(streamId, streamId),
      );
      const node = createCycleNode(streamId, host, logger);

      try {
        const result = await withTestRunContext(node.services.runScope, () =>
          node.exec(createPrepResult(AgentWorkspaceState.create(), false)),
        );

        expect(result.outcome).toBe(expectedOutcome);
        const sessionStages =
          store
            .get(streamId)
            ?.getRange(0)
            .flatMap((entry) => {
              if (
                entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
                isObject(entry.data) &&
                entry.data.kind === 'session'
              ) {
                return [{ label: entry.text, status: entry.data.status }];
              }
              return [];
            }) ?? [];
        expect(sessionStages).toEqual([
          { label: 'Tool-use turn', status: expectedStatus },
        ]);
        expect(
          store
            .get(streamId)
            ?.getRange(0)
            .some(
              (entry) => isObject(entry.data) && entry.data.kind === 'round',
            ),
        ).toBe(false);
      } finally {
        recorder.unsubscribe();
      }
    },
  );
});
