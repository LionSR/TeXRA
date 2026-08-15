import '@test/support/defaultSessionTestSetup';

import { DEFAULT_MODEL_CAPABILITIES } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type AgentTrace } from '@agent/trace';
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
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
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

import {
  recordSessionEvents,
  runEventsOfType,
  sessionFactsOfType,
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
  Pick<ToolUseServices, 'isSubagent' | 'onFollowUpConsumed' | 'onIdle'>
> & {
  fileService?: Partial<ToolUseServices['fileService']>;
  logger?: AgentTrace;
  modelHandler?: WaitNodeModelHandlerOverrides;
  session?: Partial<ToolUseServices['session']>;
  /** Run identity the node reads off `services.runScope`. */
  streamId?: string;
  /** Session owning this run's status machine and approvals. */
  ownerSession?: SessionHandle;
  signal?: AbortSignal;
  /** Injected tool policy the wait node reads instead of the ambient RunContext. */
  stopAfterCycle?: boolean;
};

function createWaitNodeServices(
  overrides: WaitNodeServiceOverrides = {},
): ToolUseServices {
  const {
    fileService,
    modelHandler,
    ownerSession,
    session,
    signal,
    stopAfterCycle,
    streamId = 'test-stream',
    ...topLevel
  } = overrides;
  const { capabilities, ...modelHandlerOverrides } = modelHandler ?? {};
  return {
    runScope: testRunScope(streamId, { session: ownerSession, signal }),
    toolPolicy: { stopAfterCycle },
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

/** Follow-up mock that appends each text to the running message list. */
function appendUserFollowUpMessages() {
  return vi.fn(
    async (
      messages: ProviderMessage[],
      userMessage: string,
    ): Promise<ProviderMessage[]> => [
      ...messages,
      { role: 'user', content: userMessage },
    ],
  );
}

/** Follow-up mock that returns each text as a standalone user message. */
function singleUserFollowUpMessage() {
  return vi.fn(
    async (
      _messages: ProviderMessage[],
      text: string,
    ): Promise<ProviderMessage[]> => [{ role: 'user', content: text }],
  );
}

/**
 * Starts a goal whose latest cycle failed, with an owner session recording
 * approval bypass-state changes.
 */
async function startErroredGoal(
  streamId: StreamTabId,
  goal: string,
  errorMessage: string,
): Promise<{
  shared: ToolUseRunShared;
  setApprovalBypassState: ReturnType<typeof vi.fn>;
  ownerSession: SessionHandle;
}> {
  await installPlatform();
  await GoalStore.start(streamId, goal);
  const shared = toolUseRunShared();
  shared.lastError = { message: errorMessage, userRetryable: false };
  const setApprovalBypassState = vi.fn();
  const ownerSession = sessionWithInteractions({
    setApprovalBypassState,
    cancel: vi.fn(),
  });
  return { shared, setApprovalBypassState, ownerSession };
}

describe('ToolUseWaitNode', () => {
  it.each([false, true] as const)(
    'always suspends a subagent cycle at WAITING (queued follow-up: %s)',
    async (hasQueuedFollowUp) => {
      // Subagent mode suspends unconditionally and symmetrically. A follow-up
      // already queued is the child-run loop's concern (it resumes immediately
      // instead of genuinely waiting), and the node never blocks on
      // session.waitForFollowUp — the loop owns the next-turn wait.
      const shared = toolUseRunShared();
      const waitForFollowUp = vi.fn();

      const services = createWaitNodeServices({
        isSubagent: true,
        session: {
          ...(hasQueuedFollowUp ? { hasQueuedFollowUp: () => true } : {}),
          waitForFollowUp,
        },
      });

      const node = new ToolUseWaitNode().setServices(services);
      const prep = await node.prep(shared);
      // The child-run loop reads the turn facts off the flow result and
      // delivers them after suspension (see childRunLoop.ts), so the node
      // carries none.
      expect(prep.lastResponse).toBeUndefined();

      const transition = await withTestRunContext(
        services.runScope,
        async () => {
          const exec = await node.exec(prep);
          expect(exec.kind).toBe('waiting');
          return node.post(shared, prep, exec);
        },
      );

      expect(transition).toBe(FlowTransition.WAITING);
      expect(waitForFollowUp).not.toHaveBeenCalled();
    },
  );

  it('advances a drained child-loop batch once without reading the session queue', async () => {
    const shared = toolUseRunShared();
    const waitForFollowUp = vi.fn();
    const createUserFollowUpMessages = singleUserFollowUpMessage();
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

    const first = await withTestRunContext(services.runScope, async () => {
      const exec = await node.exec(prep);
      const transition = await node.post(shared, prep, exec);
      return { exec, transition };
    });
    const second = await withTestRunContext(services.runScope, () =>
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
    const shared = toolUseRunShared();

    // `stopAfterCycle` is injected through `services.toolPolicy`; no
    // AsyncLocalStorage frame is installed for this cycle.
    const services = createWaitNodeServices({
      isSubagent: true,
      stopAfterCycle: true,
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    const exec = await node.exec(prep);
    expect(exec.kind).toBe('stop');
    const transition = await node.post(shared, prep, exec);

    expect(transition).toBe(FlowTransition.COMPLETE);
  });

  it('stops immediately on interruption instead of suspending a subagent', async () => {
    const shared = toolUseRunShared();

    const services = createWaitNodeServices({
      signal: AbortSignal.abort(),
      isSubagent: true,
    });

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const transition = await withTestRunContext(services.runScope, async () => {
      const exec = await node.exec(prep);
      return node.post(shared, prep, exec);
    });

    expect(transition).toBe(FlowTransition.COMPLETE);
  });

  it('fires the root-only onIdle notification every cycle without suspending', async () => {
    const shared = toolUseRunShared({
      messages: [{ role: 'assistant', content: 'partial response' } as never],
    });
    const onIdle = vi.fn();
    const waitForFollowUp = vi.fn(async () => null);

    const services = createWaitNodeServices({
      isSubagent: false,
      modelHandler: { extractAssistantText: () => 'partial response' },
      onIdle,
      session: { waitForFollowUp },
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    await withTestRunContext(services.runScope, () => node.exec(prep));

    expect(onIdle).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledWith('partial response');
    expect(waitForFollowUp).toHaveBeenCalledOnce();
  });

  it('warns when follow-up media cannot be attached to a non-vision model', async () => {
    const shared = toolUseRunShared();
    const info = vi.fn();
    const warn = vi.fn();
    const addMediaToUserMessage = vi.fn(async () => []);
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
    const transition = await withTestRunContext(services.runScope, () =>
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
    const shared = toolUseRunShared();
    const info = vi.fn();
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
    await withTestRunContext(services.runScope, () =>
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
    const { shared, setApprovalBypassState, ownerSession } =
      await startErroredGoal(streamId, 'finish the refactor', 'cycle failed');

    const logger = new TraceEmitter();
    const hub = new SessionEventHub();
    const recorded = recordSessionEvents(hub, { scope: 'run' });
    const detachTrace = logger.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const waitForFollowUp = vi.fn();
    const services = createWaitNodeServices({
      isSubagent: false,
      logger,
      ownerSession,
      streamId,
      stopAfterCycle: true,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      // `pauseActiveGoal` resolves `currentSession()` through the active run
      // context, so the ALS frame stays (stopAfterCycle is still read from
      // `services.toolPolicy`, not from the ambient context).
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(waitPrep(true)),
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
      detachTrace();
      recorded.detach();
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  it('injects an active goal continuation before the blocking wait', async () => {
    const streamId = 'wait-node-active-goal' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Finish the autonomous proof audit.');

    const shared = toolUseRunShared();
    const createUserFollowUpMessages = appendUserFollowUpMessages();
    const onFollowUpConsumed = vi.fn();
    const waitForFollowUp = vi.fn();
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const services = createWaitNodeServices({
      isSubagent: false,
      modelHandler: {
        createUserFollowUpMessages,
      },
      onFollowUpConsumed,
      ownerSession,
      streamId,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(prep),
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

      const transition = await withTestRunContext(services.runScope, () =>
        node.post(shared, prep, exec),
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

    const shared = toolUseRunShared();
    const createUserFollowUpMessages = appendUserFollowUpMessages();
    const waitForFollowUp = vi.fn(async () => null);
    const services = createWaitNodeServices({
      isSubagent: false,
      modelHandler: {
        createUserFollowUpMessages,
      },
      streamId,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const continuationCycles = 25;
      for (let cycle = 0; cycle < continuationCycles; cycle += 1) {
        const prep = await node.prep(shared);
        const exec = await withTestRunContext(services.runScope, () =>
          node.exec(prep),
        );

        expect(exec.kind).toBe('continue');
        if (exec.kind !== 'continue') return;
        expect(exec.synthetic).toBe(true);
        expect(exec.followUps[0]?.text).toContain(
          'Keep solving the hard problem until verification is complete.',
        );

        const transition = await withTestRunContext(services.runScope, () =>
          node.post(shared, prep, exec),
        );
        expect(transition).toBe(FlowTransition.CONTINUE);
        expect(createUserFollowUpMessages).toHaveBeenCalledTimes(cycle + 1);
      }

      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(shared.messages).toHaveLength(continuationCycles);

      await GoalStore.setStatus(streamId, 'paused');

      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
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
    const services = createWaitNodeServices({
      streamId,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(services.runScope, () =>
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
    // A subagent cycle always exits WAITING before the goal-continuation path,
    // which is gated `!isSubagent` and sits after the subagent-suspend branch.
    // So a subagent can never synthesize a continuation against the PARENT's
    // goal, structurally rather than by any check on waitForFollowUp.
    const streamId = 'wait-node-goal-subagent' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Parent-owned objective.');

    const waitForFollowUp = vi.fn(async () => null);
    const services = createWaitNodeServices({
      isSubagent: true,
      streamId,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(services.runScope, () =>
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
    const streamStatus = new StreamStatusMachine(new SessionEventHub());
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const shared = toolUseRunShared();
    const createUserFollowUpMessages = vi.fn(async () => []);
    const services = createWaitNodeServices({
      ownerSession,
      streamId,
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
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(prep),
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.WAITING);

      await withTestRunContext(services.runScope, () =>
        node.post(shared, prep, exec),
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('repairs retry-cancelled parent cycles to waiting before blocking', async () => {
    const streamId = 'wait-node-retry-cancelled-wait' as StreamTabId;
    const statusHub = new SessionEventHub();
    const streamStatus = new StreamStatusMachine(statusHub);
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    // Status is a session fact on the machine's own hub — the single rail.
    const recorded = recordSessionEvents(statusHub);
    const waitForFollowUp = vi.fn(async () => null);
    const services = createWaitNodeServices({
      isSubagent: false,
      ownerSession,
      streamId,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.CANCELLED,
      });

      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(waitPrep(true)),
      );

      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(sessionFactsOfType(recorded.events, 'status')).toEqual([
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
    const shared = toolUseRunShared({
      stateSlices: {
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
        workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
        userChannels: {
          input: Object.freeze({ INSTRUCTION: 'initial request' }),
          transient: { INSTRUCTION: 'initial request' },
        },
      },
    });
    const createUserFollowUpMessages = appendUserFollowUpMessages();
    const sequence: string[] = [];
    const info = vi.fn(() => sequence.push('info'));
    const streamId = 'test-stream' as StreamTabId;
    const logger = Object.assign(new TraceEmitter(), {
      error: vi.fn(),
      info,
    });
    const statusHub = new SessionEventHub();
    // Status is a session fact on the machine's own hub — the single rail.
    const recorded = recordSessionEvents(statusHub);
    const detachSequence = statusHub.subscribeStatus(() =>
      sequence.push('status'),
    );
    const streamStatus = new StreamStatusMachine(statusHub);
    const ownerSession = sessionWithInteractions(undefined, streamStatus);
    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        capabilities: { supportsVision: true },
        createUserFollowUpMessages,
      },
      ownerSession,
      streamId,
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
    seedStreamStatusForTest(streamStatus, streamId, {
      phase: STREAM_PHASE.WAITING,
    });

    const prep = await node.prep(shared);
    try {
      const transition = await withTestRunContext(
        services.runScope,
        async () => {
          const exec = await node.exec(prep);
          return node.post(shared, prep, exec);
        },
      );

      expect(transition).toBe(FlowTransition.CONTINUE);
      expect(sessionFactsOfType(recorded.events, 'status')).toContainEqual(
        expect.objectContaining({ phase: STREAM_STATUS.RUNNING }),
      );
      expect(sequence.indexOf('status')).toBeLessThan(sequence.indexOf('info'));
    } finally {
      detachSequence();
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

  // Regression #9443: a drained batch is consumed before the subagent
  // after-error stop, so user input the child-run loop already took off the
  // queue reaches the model and `post` clears the error. Since consuming the
  // batch continues immediately, an active goal must not be paused or lose its
  // unattended bash approval first.
  it('recovers an errored goal from a drained batch without pausing it', async () => {
    const streamId = 'wait-node-error-drained-goal' as StreamTabId;
    const { shared, setApprovalBypassState, ownerSession } =
      await startErroredGoal(
        streamId,
        'finish the autonomous proof',
        'stale failure from the previous cycle',
      );

    const batch = [{ text: 'try the other lemma', origin: 'user' as const }];
    const services = createWaitNodeServices({
      isSubagent: true,
      ownerSession,
      streamId,
      modelHandler: {
        createUserFollowUpMessages: singleUserFollowUpMessage(),
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);

    try {
      const prep = await node.prep(shared);
      expect(prep.afterError).toBe(true);

      const { exec, transition } = await withTestRunContext(
        services.runScope,
        async () => {
          const exec = await node.exec(prep);
          return { exec, transition: await node.post(shared, prep, exec) };
        },
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
    const { shared, setApprovalBypassState, ownerSession } =
      await startErroredGoal(
        streamId,
        'finish the autonomous proof',
        'stale failure from the previous cycle',
      );

    const applicationError = new Error('follow-up media is unreadable');
    const batch = [{ text: 'use this diagram', origin: 'user' as const }];
    const services = createWaitNodeServices({
      isSubagent: true,
      ownerSession,
      streamId,
      modelHandler: {
        createUserFollowUpMessages: vi.fn(async () => {
          throw applicationError;
        }),
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);

    try {
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(prep),
      );

      await expect(
        withTestRunContext(services.runScope, () =>
          node.post(shared, prep, exec),
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
    const shared = toolUseRunShared();
    shared.lastError = { message: 'boom', userRetryable: false };
    const waitForFollowUp = vi.fn();
    const services = createWaitNodeServices({
      isSubagent: true,
      session: { waitForFollowUp },
    });
    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const exec = await withTestRunContext(services.runScope, () =>
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
