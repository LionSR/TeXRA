// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const roundFlowState = vi.hoisted(() => ({
  shouldStop: false,
  endTurn: false,
  lastError: undefined as
    { message: string; userRetryable: boolean } | undefined,
  finalTool: undefined as { name: string } | undefined,
}));

vi.mock('@agent/core/flows/ToolUseRoundFlow', () => ({
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

vi.mock('@agent/core/flows/CycleServices', () => ({
  withModelClient: async (services: unknown) => services,
}));

// Local imports
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
  withTestRunContext,
} from '../progressTestUtils';

const todo: TodoItem = {
  content: 'Wire progress events through runtime host',
  status: 'in_progress',
  activeForm: 'Wiring progress events',
};

const plan: Plan = {
  objective:
    'Move progress publication behind the runtime host.\n' +
    'Publish tool-use cycle state through runtimeHost.',
};

function createPrepResult(
  workspaceState: AgentWorkspaceState,
  shouldSkipCycle = true,
): CyclePrepResult {
  return {
    shouldSkipCycle,
    messages: [],
    runState: AgentRunStateSnapshotSchema.parse({}),
    workspaceState,
    userChannels: { input: {}, transient: {} },
  };
}

describe('tool-use progress events', () => {
  it('collapses a run whose only tool is the terminal tool to one forced round', async () => {
    roundFlowState.shouldStop = false;
    roundFlowState.endTurn = true;
    roundFlowState.lastError = undefined;
    roundFlowState.finalTool = undefined;
    const { host } = createRecordingHost();
    const logger = new TraceEmitter();
    const streamId = 'stream:single-shot-final-tool' as StreamTabId;
    const node = new ToolUseCycleNode().setServices({
      streamId,
      runtimeHost: host,
      logger,
      modelHandler: {
        getClient: vi.fn(),
        supportsForcedToolChoice: true,
      },
      finalTool: { name: 'submit_output' },
      onRoundFinalized: vi.fn(),
      config: { model: 'test-model', agent: 'test-agent' },
      setting: { tools: [{ name: 'submit_output' }] },
    } as unknown as ToolUseServices);

    await withTestRunContext(host, streamId, () =>
      node.exec(createPrepResult(AgentWorkspaceState.create(), false)),
    );

    expect(roundFlowState.finalTool).toEqual({ name: 'submit_output' });
  });

  it('does not force the first round of a headless run with exploration tools', async () => {
    roundFlowState.shouldStop = false;
    roundFlowState.endTurn = true;
    roundFlowState.lastError = undefined;
    roundFlowState.finalTool = undefined;
    const { host } = createRecordingHost();
    const logger = new TraceEmitter();
    const streamId = 'stream:headless-final-tool' as StreamTabId;
    const node = new ToolUseCycleNode().setServices({
      streamId,
      runtimeHost: host,
      logger,
      modelHandler: {
        getClient: vi.fn(),
        supportsForcedToolChoice: true,
      },
      finalTool: { name: 'submit_output' },
      onRoundFinalized: vi.fn(),
      config: { model: 'test-model', agent: 'test-agent' },
      setting: {
        tools: [{ name: 'read_file' }, { name: 'submit_output' }],
      },
    } as unknown as ToolUseServices);

    await withTestRunContext(
      host,
      streamId,
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

    const node = new ToolUseCycleNode().setServices({
      streamId,
      runtimeHost: host,
      logger,
      modelHandler: { getClient: vi.fn() },
      onRoundFinalized: vi.fn(),
      config: { model: 'test-model', agent: 'test-agent' },
      setting: { tools: [] },
    } as unknown as ToolUseServices);

    try {
      const result = await withTestRunContext(host, streamId, () =>
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

  it('logs failed cycle outcomes as transcript errors', async () => {
    const workspaceState = AgentWorkspaceState.create();
    const prepRes = createPrepResult(workspaceState);
    const shared: Partial<ToolUseRunShared> = {};
    const error = vi.fn();
    const node = new ToolUseCycleNode().setServices({
      logger: { error },
    } as unknown as ToolUseServices);

    const transition = await node.post(shared as ToolUseRunShared, prepRes, {
      outcome: 'failed',
      message: 'Model claude-opus-4-7 not found',
      userRetryable: false,
    });

    expect(transition).toBe(FlowTransition.DEFAULT);
    expect(shared.lastError).toEqual({
      message: 'Model claude-opus-4-7 not found',
      userRetryable: false,
    });
    expect(error).toHaveBeenCalledWith('Model claude-opus-4-7 not found', {
      messageType: MESSAGE_TYPES.ERROR,
    });
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

describe('tool-use round outcome persistence (#8023)', () => {
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
    'persists a $name round with its canonical RunOutcome',
    async ({
      name,
      shouldStop,
      endTurn,
      lastError,
      expectedOutcome,
      expectedStatus,
    }) => {
      roundFlowState.shouldStop = shouldStop;
      roundFlowState.endTurn = endTurn;
      roundFlowState.lastError = lastError;

      const { host } = createRecordingHost();
      const logger = new TraceEmitter();
      const streamId = `stream:tool-use-round-${name}` as StreamTabId;
      const store = StreamLogStore.ephemeral('test');
      store.ensureStream(streamId);
      const recorder = attachTranscriptRecorder(logger, streamId, store);
      const node = new ToolUseCycleNode().setServices({
        streamId,
        runtimeHost: host,
        logger,
        modelHandler: { getClient: vi.fn() },
        onRoundFinalized: vi.fn(),
        config: { model: 'test-model', agent: 'test-agent' },
        setting: { tools: [] },
      } as unknown as ToolUseServices);

      try {
        const result = await withTestRunContext(host, streamId, () =>
          node.exec(createPrepResult(AgentWorkspaceState.create(), false)),
        );

        expect(result.outcome).toBe(expectedOutcome);
        const roundEndStatuses =
          store
            .get(streamId)
            ?.getRange(0)
            .flatMap((entry) => {
              if (
                entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
                isObject(entry.data) &&
                entry.data.kind === 'round'
              ) {
                return [entry.data.status];
              }
              return [];
            }) ?? [];
        expect(roundEndStatuses).toEqual([expectedStatus]);
      } finally {
        recorder.unsubscribe();
      }
    },
  );
});
