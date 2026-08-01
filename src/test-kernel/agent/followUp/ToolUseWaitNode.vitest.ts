// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { DEFAULT_MODEL_CAPABILITIES } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { TraceEmitter, type AgentEvent, type AgentTrace } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import {
  extractTouchedFiles,
  type ToolUseRunShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import type { RunModelHandler } from '@agent/runtime/ModelCell';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  SessionEventHub,
  type SessionEvent,
} from '@agent/runtime/SessionEventHub';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import {
  MESSAGE_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupApprovalsForStream } from '@tools/approval';
import { GoalStore } from '@tools/goal';

// Local file imports
import {
  recordSessionEvents,
  runEventsOfType,
  sessionWithInteractions,
  testRunScope,
  toolUseRunShared,
  withTestRunContext,
} from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

type WaitNodeModelHandlerOverrides = Omit<
  Partial<RunModelHandler>,
  'capabilities'
> & {
  capabilities?: Partial<RunModelHandler['capabilities']>;
};

type WaitNodeServiceOverrides = Partial<
  Pick<
    ToolUseServices,
    | 'checkInterruption'
    | 'isSubagent'
    | 'onFollowUpConsumed'
    | 'onIdle'
    | 'runScope'
  >
> & {
  fileService?: Partial<ToolUseServices['fileService']>;
  logger?: AgentTrace;
  modelHandler?: WaitNodeModelHandlerOverrides;
  session?: Partial<ToolUseServices['session']>;
};

function createWaitNodeServices(
  overrides: WaitNodeServiceOverrides = {},
): ToolUseServices {
  const { fileService, modelHandler, session, ...topLevel } = overrides;
  const { capabilities, ...modelHandlerOverrides } = modelHandler ?? {};
  return {
    runScope: testRunScope('test-stream'),
    checkInterruption: () => false,
    fileService: {
      createLocation: (filePath: string) => ({ absolutePath: filePath }),
      ...fileService,
    },
    logger: new TraceEmitter(),
    modelCell: testModelCell({
      capabilities: {
        ...DEFAULT_MODEL_CAPABILITIES,
        ...capabilities,
      },
      createUserFollowUpMessages: vi.fn(async () => []),
      extractAssistantText: () => undefined,
      ...modelHandlerOverrides,
    }),
    session: {
      hasQueuedFollowUp: () => false,
      waitForFollowUp: vi.fn(async () => null),
      ...session,
    },
    ...topLevel,
  } as unknown as ToolUseServices;
}

function waitPrep(afterError = false) {
  return { afterError, lastResponse: undefined };
}

/**
 * Projects everything `logger` emits onto an isolated hub as run events for
 * `streamId` and records them, the way a live run's trace subscription does.
 * `observe` sees each trace event before it reaches the hub.
 */
function recordRunEvents(
  logger: TraceEmitter,
  streamId: StreamTabId,
  observe?: (event: AgentEvent) => void,
): { readonly events: SessionEvent[]; readonly detach: () => void } {
  const hub = new SessionEventHub();
  const recorded = recordSessionEvents(hub, { scope: 'run' });
  const detachTrace = logger.subscribe((event) => {
    observe?.(event);
    hub.emit({ scope: 'run', streamId, event });
  });
  return {
    events: recorded.events,
    detach: () => {
      detachTrace();
      recorded.detach();
    },
  };
}

describe('ToolUseWaitNode', () => {
  it('always suspends a subagent cycle at WAITING, carrying its turn facts', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    const interactions = { emit: vi.fn() };
    const waitForFollowUp = vi.fn();

    const services = createWaitNodeServices({
      isSubagent: true,
      session: {
        waitForFollowUp,
      },
    });

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    // No in-flow delivery site anymore — the child-run loop reads the turn
    // facts off the flow result and delivers after suspension (see
    // childRunLoop.ts), so the node itself carries none.
    expect(prep.lastResponse).toBeUndefined();

    const transition = await withTestRunContext(
      interactions,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        return node.post(shared, prep, exec);
      },
    );

    expect(transition).toBe(FlowTransition.WAITING);
    // The flow never blocks on session.waitForFollowUp in subagent mode —
    // the loop owns the next-turn wait via its own follow-up queue.
    expect(waitForFollowUp).not.toHaveBeenCalled();
  });

  it('always suspends a subagent cycle even when a follow-up is already queued', async () => {
    // The key behavior change from the old "skip suspension if a follow-up
    // already raced in" fast path: subagent mode now suspends unconditionally
    // and symmetrically. A follow-up already queued is the child-run loop's
    // concern (it resumes immediately instead of genuinely waiting) — not
    // something the flow itself should special-case.
    const shared: ToolUseRunShared = toolUseRunShared();
    const interactions = { emit: vi.fn() };
    const waitForFollowUp = vi.fn();

    const services = createWaitNodeServices({
      isSubagent: true,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp,
      },
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    const exec = await withTestRunContext(interactions, 'test-stream', () =>
      node.exec(prep),
    );

    expect(exec.kind).toBe('waiting');
    expect(waitForFollowUp).not.toHaveBeenCalled();
  });

  it('advances a drained child-loop batch once without reading the session queue', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    const interactions = { emit: vi.fn() };
    const waitForFollowUp = vi.fn();
    const createUserFollowUpMessages = vi.fn(
      async (
        _messages: ProviderMessage[],
        text: string,
      ): Promise<ProviderMessage[]> => [{ role: 'user', content: text }],
    );
    const onFollowUpConsumed = vi.fn();
    const batch = [
      {
        text: 'state where finiteness is used',
        displayText: 'clarify finiteness',
        origin: 'user' as const,
      },
    ];
    const services = createWaitNodeServices({
      isSubagent: true,
      modelHandler: {
        createUserFollowUpMessages,
      },
      onFollowUpConsumed,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);
    const prep = await node.prep(shared);

    const first = await withTestRunContext(
      interactions,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        const transition = await node.post(shared, prep, exec);
        return { exec, transition };
      },
    );
    const second = await withTestRunContext(interactions, 'test-stream', () =>
      node.exec(prep),
    );

    expect(first).toEqual({
      exec: {
        kind: 'continue',
        followUps: batch,
        synthetic: false,
      },
      transition: FlowTransition.CONTINUE,
    });
    expect(second).toEqual({ kind: 'waiting' });
    expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    expect(createUserFollowUpMessages).toHaveBeenCalledWith(
      [],
      'state where finiteness is used',
    );
    expect(shared.messages).toEqual([
      { role: 'user', content: 'state where finiteness is used' },
    ]);
    expect(onFollowUpConsumed).toHaveBeenCalledOnce();
    expect(waitForFollowUp).not.toHaveBeenCalled();
  });

  it('stops instead of suspending when stopAfterCycle is set (headless in-band subagent)', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    const interactions = { emit: vi.fn() };

    const services = createWaitNodeServices({
      isSubagent: true,
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    const transition = await withTestRunContext(
      interactions,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        expect(exec.kind).toBe('stop');
        return node.post(shared, prep, exec);
      },
      { stopAfterCycle: true },
    );

    expect(transition).toBe(FlowTransition.COMPLETE);
  });

  it('stops immediately on interruption instead of suspending a subagent', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    const interactions = { emit: vi.fn() };

    const services = createWaitNodeServices({
      checkInterruption: () => true,
      isSubagent: true,
    });

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const transition = await withTestRunContext(
      interactions,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        return node.post(shared, prep, exec);
      },
    );

    expect(transition).toBe(FlowTransition.COMPLETE);
  });

  it('fires the root-only onIdle notification every cycle without suspending', async () => {
    const shared: ToolUseRunShared = toolUseRunShared({
      messages: [{ role: 'assistant', content: 'partial response' } as never],
    });
    const onIdle = vi.fn();
    const interactions = { emit: vi.fn() };
    let waitCalls = 0;

    const services = createWaitNodeServices({
      isSubagent: false,
      modelHandler: { extractAssistantText: () => 'partial response' },
      onIdle,
      session: {
        waitForFollowUp: async () => {
          waitCalls += 1;
          return null;
        },
      },
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    await withTestRunContext(interactions, 'test-stream', () =>
      node.exec(prep),
    );

    expect(onIdle).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledWith('partial response');
    expect(waitCalls).toBe(1);
  });

  it('warns when follow-up media cannot be attached to a non-vision model', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    const info = vi.fn();
    const warn = vi.fn();
    const addMediaToUserMessage = vi.fn(async () => []);
    const interactions = { emit: vi.fn() };
    const logger = Object.assign(new TraceEmitter(), { info, warn });

    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        addMediaToUserMessage,
        capabilities: {
          supportsNativeAudio: true,
          supportsVision: false,
        },
        createUserFollowUpMessages: vi.fn(async () => []),
      },
    });

    const node = new ToolUseWaitNode().setServices(services);
    const transition = await withTestRunContext(
      interactions,
      'test-stream',
      () =>
        node.post(shared, waitPrep(), {
          followUps: [
            {
              text: 'please inspect this figure',
              mediaFiles: ['/tmp/figure.png'],
              origin: 'user',
            },
          ],
          kind: 'continue',
        }),
    );

    expect(transition).toBe(FlowTransition.CONTINUE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Model has no vision support'),
    );
    expect(addMediaToUserMessage).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      'please inspect this figure',
      expect.not.objectContaining({
        data: expect.objectContaining({ attachments: expect.anything() }),
      }),
    );
  });

  it('logs follow-up markers reported by provider insertion', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    const info = vi.fn();
    const interactions = { emit: vi.fn() };
    const logger = Object.assign(new TraceEmitter(), {
      info,
      warn: vi.fn(),
    });

    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        addMediaToUserMessage: vi.fn(async () => ['image' as const]),
        capabilities: {
          supportsNativeAudio: false,
          supportsVision: true,
        },
        createUserFollowUpMessages: vi.fn(async () => []),
      },
    });

    const node = new ToolUseWaitNode().setServices(services);
    await withTestRunContext(interactions, 'test-stream', () =>
      node.post(shared, waitPrep(), {
        followUps: [
          {
            text: 'please inspect this figure',
            mediaFiles: ['/tmp/figure.png', '/tmp/missing.pdf'],
            origin: 'user',
          },
        ],
        kind: 'continue',
      }),
    );

    expect(info).toHaveBeenCalledWith('please inspect this figure', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      data: { attachments: ['image'] },
    });
  });

  it('pauses the goal after a failed parent cycle', async () => {
    const streamId = 'wait-node-error-goal' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'finish the refactor');

    const shared: ToolUseRunShared = toolUseRunShared({
      lastError: { message: 'cycle failed', userRetryable: false },
    });
    const interactions = { emit: vi.fn() };
    const setApprovalBypassState = vi.fn();
    const session = sessionWithInteractions({
      setApprovalBypassState,
      cancel: vi.fn(),
    });
    const logger = new TraceEmitter();
    const recorded = recordRunEvents(logger, streamId);
    const waitForFollowUp = vi.fn();
    const services = createWaitNodeServices({
      isSubagent: false,
      logger,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(
        interactions,
        streamId,
        () => node.exec(waitPrep(true)),
        { session, stopAfterCycle: true },
      );

      const goal = GoalStore.getForStream(streamId);
      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(goal?.status).toBe('paused');
      expect(runEventsOfType(recorded.events, 'goalPaused')).toContainEqual(
        expect.objectContaining({
          streamId,
        }),
      );
      expect(setApprovalBypassState).toHaveBeenCalledWith({
        streamId,
        kind: 'bash',
        bypassActive: false,
      });
      expect(setApprovalBypassState).not.toHaveBeenCalledWith({
        streamId,
        kind: 'toolEdit',
        bypassActive: false,
      });
    } finally {
      recorded.detach();
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  it('injects an active goal continuation before the blocking wait', async () => {
    const streamId = 'wait-node-active-goal' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Finish the autonomous proof audit.');

    const shared: ToolUseRunShared = toolUseRunShared();
    const createUserFollowUpMessages = vi.fn(
      async (
        messages: ProviderMessage[],
        userMessage: string,
      ): Promise<ProviderMessage[]> => [
        ...messages,
        { role: 'user', content: userMessage },
      ],
    );
    const onFollowUpConsumed = vi.fn();
    const waitForFollowUp = vi.fn();
    const streamStatus = new StreamStatusMachine();
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const interactions = { emit: vi.fn() };
    const services = createWaitNodeServices({
      isSubagent: false,
      modelHandler: {
        createUserFollowUpMessages,
      },
      onFollowUpConsumed,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.RUNNING);
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(
        interactions,
        streamId,
        () => node.exec(prep),
        { session: ownerSession },
      );

      expect(exec.kind).toBe('continue');
      if (exec.kind !== 'continue') return;
      expect(exec.synthetic).toBe(true);
      expect(exec.followUps).toEqual([
        {
          text: expect.stringContaining('Finish the autonomous proof audit.'),
          origin: 'synthetic',
        },
      ]);
      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);

      const transition = await withTestRunContext(
        interactions,
        streamId,
        () => node.post(shared, prep, exec),
        { session: ownerSession },
      );

      expect(transition).toBe(FlowTransition.CONTINUE);
      expect(onFollowUpConsumed).not.toHaveBeenCalled();
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
      expect(createUserFollowUpMessages).toHaveBeenCalledWith(
        [],
        expect.stringContaining('<goal_context>'),
      );
      expect(shared.messages).toEqual([
        {
          role: 'user',
          content: expect.stringContaining(
            'Finish the autonomous proof audit.',
          ),
        },
      ]);
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('keeps injecting active goal continuations across a long run', async () => {
    const streamId = 'wait-node-long-goal' as StreamTabId;
    await installPlatform();

    await GoalStore.start(
      streamId,
      'Keep solving the hard problem until verification is complete.',
    );

    const shared: ToolUseRunShared = toolUseRunShared();
    const createUserFollowUpMessages = vi.fn(
      async (
        messages: ProviderMessage[],
        userMessage: string,
      ): Promise<ProviderMessage[]> => [
        ...messages,
        { role: 'user', content: userMessage },
      ],
    );
    const waitForFollowUp = vi.fn(async () => null);
    const interactions = { emit: vi.fn() };
    const services = createWaitNodeServices({
      isSubagent: false,
      modelHandler: {
        createUserFollowUpMessages,
      },
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const continuationCycles = 25;
      for (let cycle = 0; cycle < continuationCycles; cycle += 1) {
        const prep = await node.prep(shared);
        const exec = await withTestRunContext(interactions, streamId, () =>
          node.exec(prep),
        );

        expect(exec.kind).toBe('continue');
        if (exec.kind !== 'continue') return;
        expect(exec.synthetic).toBe(true);
        expect(exec.followUps[0]?.text).toContain(
          'Keep solving the hard problem until verification is complete.',
        );

        const transition = await withTestRunContext(
          interactions,
          streamId,
          () => node.post(shared, prep, exec),
        );
        expect(transition).toBe(FlowTransition.CONTINUE);
        expect(createUserFollowUpMessages).toHaveBeenCalledTimes(cycle + 1);
      }

      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(createUserFollowUpMessages).toHaveBeenCalledTimes(
        continuationCycles,
      );
      expect(shared.messages).toHaveLength(continuationCycles);

      await GoalStore.setStatus(streamId, 'paused');

      const prep = await node.prep(shared);
      const exec = await withTestRunContext(interactions, streamId, () =>
        node.exec(prep),
      );

      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(exec.kind).toBe('stop');
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('lets queued user follow-up win over an active goal continuation', async () => {
    const streamId = 'wait-node-goal-user-queued' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Keep going autonomously.');

    const waitForFollowUp = vi.fn(async () => ({
      items: [{ text: 'user correction', origin: 'user' as const }],
      synthetic: false,
    }));
    const interactions = { emit: vi.fn() };
    const services = createWaitNodeServices({
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(interactions, streamId, () =>
        node.exec(waitPrep()),
      );

      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(exec).toEqual({
        kind: 'continue',
        followUps: [{ text: 'user correction', origin: 'user' }],
        synthetic: false,
      });
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('does not let a subagent drive the parent goal continuation loop', async () => {
    // A subagent cycle always exits WAITING (never reaches the goal-
    // continuation code path, which is gated `!isSubagent` and only
    // reachable after the subagent-suspend branch) — the invariant this test
    // protects (a subagent must never synthesize a continuation against the
    // PARENT's goal) is now structural, not conditional on waitForFollowUp
    // ever being called.
    const streamId = 'wait-node-goal-subagent' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Parent-owned objective.');

    const waitForFollowUp = vi.fn(async () => null);
    const interactions = { emit: vi.fn() };
    const services = createWaitNodeServices({
      isSubagent: true,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(interactions, streamId, () =>
        node.exec(waitPrep()),
      );

      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(exec.kind).toBe('waiting');
      expect(GoalStore.getForStream(streamId)?.status).toBe('active');
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('updates the run session status while waiting and resuming', async () => {
    const streamId = 'wait-node-owner' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const shared: ToolUseRunShared = toolUseRunShared();
    const createUserFollowUpMessages = vi.fn(async () => []);
    const interactions = { emit: vi.fn() };
    const services = createWaitNodeServices({
      runScope: testRunScope(streamId, { session: ownerSession }),
      modelHandler: {
        createUserFollowUpMessages,
      },
      session: {
        waitForFollowUp: async () => ({
          items: [{ text: 'continue', origin: 'synthetic' }],
          synthetic: true,
        }),
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      const prep = await node.prep(shared);
      const exec = await withTestRunContext(
        interactions,
        streamId,
        () => node.exec(prep),
        { session: ownerSession },
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.WAITING);

      await withTestRunContext(
        interactions,
        streamId,
        () => node.post(shared, prep, exec),
        { session: ownerSession },
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('repairs retry-cancelled parent cycles to waiting before blocking', async () => {
    const streamId = 'wait-node-retry-cancelled-wait' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const interactions = { emit: vi.fn() };
    const logger = Object.assign(new TraceEmitter(), {
      error: vi.fn(),
      info: vi.fn(),
    });
    const recorded = recordRunEvents(logger, streamId);
    const waitForFollowUp = vi.fn(async () => null);
    const services = createWaitNodeServices({
      isSubagent: false,
      logger,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.CANCELLED);

      const exec = await withTestRunContext(
        interactions,
        streamId,
        () => node.exec(waitPrep(true)),
        { session: ownerSession },
      );

      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(runEventsOfType(recorded.events, 'status')).toEqual([
        expect.objectContaining({
          phase: STREAM_PHASE.RUNNING,
          previousPhase: STREAM_PHASE.CANCELLED,
          cause: 'resume',
        }),
        expect.objectContaining({
          phase: STREAM_PHASE.WAITING,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: 'wait',
        }),
      ]);
    } finally {
      recorded.detach();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('appends queued subagent results and user follow-ups as separate turns', async () => {
    const shared: ToolUseRunShared = toolUseRunShared({
      stateSlices: {
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
        workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
        userChannels: {
          input: Object.freeze({ INSTRUCTION: 'initial request' }),
          transient: { INSTRUCTION: 'initial request' },
        },
      },
    });
    const createUserFollowUpMessages = vi.fn(
      async (
        messages: ProviderMessage[],
        userMessage: string,
      ): Promise<ProviderMessage[]> => [
        ...messages,
        { role: 'user', content: userMessage },
      ],
    );
    const sequence: string[] = [];
    const info = vi.fn(() => sequence.push('info'));
    const interactions = { emit: vi.fn() };
    const streamId = 'test-stream' as StreamTabId;
    const logger = Object.assign(new TraceEmitter(), {
      error: vi.fn(),
      info,
    });
    const recorded = recordRunEvents(logger, streamId, (event) => {
      if (event.type === 'status') sequence.push('status');
    });
    const streamStatus = new StreamStatusMachine();
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        capabilities: { supportsVision: true },
        createUserFollowUpMessages,
      },
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp: async () => ({
          items: [
            {
              text: '<subagent-result>done</subagent-result>',
              origin: 'subagent_result',
            },
            {
              text: 'please revise the theorem',
              origin: 'user',
            },
          ],
          synthetic: false,
        }),
      },
    });
    const node = new ToolUseWaitNode().setServices(services);
    seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.WAITING);

    const prep = await node.prep(shared);
    try {
      const transition = await withTestRunContext(
        interactions,
        streamId,
        async () => {
          const exec = await node.exec(prep);
          return node.post(shared, prep, exec);
        },
        { session: ownerSession },
      );

      expect(transition).toBe(FlowTransition.CONTINUE);
      expect(runEventsOfType(recorded.events, 'status')).toContainEqual(
        expect.objectContaining({ phase: STREAM_STATUS.RUNNING }),
      );
      expect(sequence.indexOf('status')).toBeLessThan(sequence.indexOf('info'));
    } finally {
      recorded.detach();
    }
    expect(createUserFollowUpMessages).toHaveBeenNthCalledWith(
      1,
      [],
      '<subagent-result>done</subagent-result>',
    );
    expect(createUserFollowUpMessages).toHaveBeenNthCalledWith(
      2,
      [{ role: 'user', content: '<subagent-result>done</subagent-result>' }],
      'please revise the theorem',
    );
    expect(shared.messages).toEqual([
      { role: 'user', content: '<subagent-result>done</subagent-result>' },
      { role: 'user', content: 'please revise the theorem' },
    ]);
    expect(info).toHaveBeenCalledWith('✓ subagent completed', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    expect(info).toHaveBeenCalledWith('please revise the theorem', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    expect(shared.stateSlices?.userChannels.transient.INSTRUCTION).toBe(
      'please revise the theorem',
    );
  });

  // Regression: #9443. The subagent after-error stop fired before the drained
  // batch was consumed, dropping user input the child-run loop had already
  // taken off the queue — and skipping `post`'s error clear with it. Since
  // consuming the batch continues immediately, an active goal must not be
  // paused or lose its unattended bash approval first.
  it('recovers an errored goal from a drained batch without pausing it', async () => {
    const streamId = 'wait-node-error-drained-goal' as StreamTabId;
    await installPlatform();
    await GoalStore.start(streamId, 'finish the autonomous proof');

    const shared: ToolUseRunShared = toolUseRunShared();
    shared.lastError = {
      message: 'stale failure from the previous cycle',
      userRetryable: false,
    };
    const interactions = { emit: vi.fn() };
    const setApprovalBypassState = vi.fn();
    const ownerSession = sessionWithInteractions({
      setApprovalBypassState,
      cancel: vi.fn(),
    });
    const batch = [{ text: 'try the other lemma', origin: 'user' as const }];
    const services = createWaitNodeServices({
      isSubagent: true,
      runScope: testRunScope(streamId),
      modelHandler: {
        createUserFollowUpMessages: vi.fn(
          async (
            _messages: ProviderMessage[],
            text: string,
          ): Promise<ProviderMessage[]> => [{ role: 'user', content: text }],
        ),
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);

    try {
      const prep = await node.prep(shared);
      expect(prep.afterError).toBe(true);

      const { exec, transition } = await withTestRunContext(
        interactions,
        streamId,
        async () => {
          const exec = await node.exec(prep);
          return { exec, transition: await node.post(shared, prep, exec) };
        },
        { session: ownerSession },
      );

      expect(exec).toEqual({
        kind: 'continue',
        followUps: batch,
        synthetic: false,
      });
      expect(transition).toBe(FlowTransition.CONTINUE);
      // Consuming the batch recovers the error rather than stranding it.
      expect(shared.lastError).toBeUndefined();
      expect(GoalStore.getForStream(streamId)?.status).toBe('active');
      expect(setApprovalBypassState).not.toHaveBeenCalled();
    } finally {
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  it('pauses an errored goal when a drained recovery batch cannot be applied', async () => {
    const streamId = 'wait-node-error-recovery-failed' as StreamTabId;
    await installPlatform();
    await GoalStore.start(streamId, 'finish the autonomous proof');

    const shared: ToolUseRunShared = toolUseRunShared();
    shared.lastError = {
      message: 'stale failure from the previous cycle',
      userRetryable: false,
    };
    const interactions = { emit: vi.fn() };
    const setApprovalBypassState = vi.fn();
    const ownerSession = sessionWithInteractions({
      setApprovalBypassState,
      cancel: vi.fn(),
    });
    const applicationError = new Error('follow-up media is unreadable');
    const batch = [{ text: 'use this diagram', origin: 'user' as const }];
    const services = createWaitNodeServices({
      isSubagent: true,
      runScope: testRunScope(streamId),
      modelHandler: {
        createUserFollowUpMessages: vi.fn(async () => {
          throw applicationError;
        }),
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);

    try {
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(
        interactions,
        streamId,
        () => node.exec(prep),
        { session: ownerSession },
      );

      await expect(
        withTestRunContext(
          interactions,
          streamId,
          () => node.post(shared, prep, exec),
          { session: ownerSession },
        ),
      ).rejects.toBe(applicationError);

      expect(shared.lastError).toEqual({
        message: 'stale failure from the previous cycle',
        userRetryable: false,
      });
      expect(GoalStore.getForStream(streamId)?.status).toBe('paused');
      expect(setApprovalBypassState).toHaveBeenCalledWith({
        streamId,
        kind: 'bash',
        bypassActive: false,
      });
    } finally {
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  // Companion to the above: with no drained batch in hand, the after-error
  // stop must still fire, or a subagent would wait for a follow-up its
  // orchestrator was never told to send.
  it('still stops a subagent after an error when no batch was drained', async () => {
    const shared: ToolUseRunShared = toolUseRunShared();
    shared.lastError = { message: 'boom', userRetryable: false };
    const interactions = { emit: vi.fn() };
    const waitForFollowUp = vi.fn();
    const services = createWaitNodeServices({
      isSubagent: true,
      session: { waitForFollowUp },
    });
    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const exec = await withTestRunContext(interactions, 'test-stream', () =>
      node.exec(prep),
    );

    expect(exec).toEqual({ kind: 'stop' });
    expect(waitForFollowUp).not.toHaveBeenCalled();
  });
});

describe('extractTouchedFiles', () => {
  it('tolerates legacy partial state slices', () => {
    expect(
      extractTouchedFiles({} as Parameters<typeof extractTouchedFiles>[0]),
    ).toEqual([]);
    expect(
      extractTouchedFiles({
        workspaceSnapshot: {},
      } as Parameters<typeof extractTouchedFiles>[0]),
    ).toEqual([]);
  });
});
