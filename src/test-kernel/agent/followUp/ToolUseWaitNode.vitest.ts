// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { installPlatform } from '@test/support/setupPlatform';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { TraceEmitter } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import {
  extractTouchedFiles,
  type ToolUseRunShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import {
  StreamStatusMachine,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
import {
  MESSAGE_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { cleanupApprovalsForStream } from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { withTestRunContext } from '../progressTestUtils';
import { attachSessionProgressEventProjectionForTest } from '../sessionProgressTestUtils';

describe('ToolUseWaitNode', () => {
  it('marks a delivered native subagent cycle before suspending at WAITING', async () => {
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    let interrupted = false;
    const onBeforeWaiting = vi.fn(async () => {});
    const memoryMisses: AttachedMemoryMiss[] = [
      { path: '/memories/missing.md', reason: 'not found' },
    ];
    const runtimeHost = { emit: vi.fn() };

    const services = {
      attachedMemoryMisses: memoryMisses,
      checkInterruption: () => interrupted,
      isSubagent: true,
      logger: { emit: vi.fn(), error: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      onBeforeWaiting,
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp: async () => {
          interrupted = true;
          return null;
        },
      },
      streamStatus: new StreamStatusMachine(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const transition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        return node.post(shared, prep, exec);
      },
    );

    expect(onBeforeWaiting).toHaveBeenCalledOnce();
    expect(onBeforeWaiting).toHaveBeenCalledWith(
      undefined,
      [],
      memoryMisses,
      undefined,
    );
    expect(transition).toBe(FlowTransition.WAITING);
    expect(shared.deliveredToOrchestrator).toBe(true);
  });

  it('keeps an already delivered synthetic continuation delivered across interruption', async () => {
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    let interrupted = false;
    let waitCalls = 0;
    const onBeforeWaiting = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true);
    const runtimeHost = { emit: vi.fn() };

    const services = {
      checkInterruption: () => interrupted,
      isSubagent: true,
      logger: { emit: vi.fn(), error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages: vi.fn(async () => []),
        extractAssistantText: () => undefined,
      },
      onBeforeWaiting,
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => waitCalls === 0,
        waitForFollowUp: async () => {
          waitCalls += 1;
          if (waitCalls === 1) {
            return {
              items: [{ text: 'synthetic continuation', origin: 'synthetic' }],
              synthetic: true,
            };
          }
          interrupted = true;
          return null;
        },
      },
      streamStatus: new StreamStatusMachine(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const firstPrep = await node.prep(shared);
    const firstTransition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      async () => {
        const firstExec = await node.exec(firstPrep);
        return node.post(shared, firstPrep, firstExec);
      },
    );
    expect(firstTransition).toBe(FlowTransition.CONTINUE);
    expect(shared.deliveredToOrchestrator).toBe(true);

    const secondPrep = await node.prep(shared);
    const secondTransition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      async () => {
        const secondExec = await node.exec(secondPrep);
        return node.post(shared, secondPrep, secondExec);
      },
    );

    expect(onBeforeWaiting).toHaveBeenCalledOnce();
    expect(secondTransition).toBe(FlowTransition.WAITING);
    expect(shared.deliveredToOrchestrator).toBe(true);
  });

  it('does not redeliver an already delivered wait when replay consumes follow-up', async () => {
    const shared: ToolUseRunShared = {
      deliveredToOrchestrator: true,
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const onBeforeWaiting = vi.fn(async () => true);
    const onFollowUpConsumed = vi.fn();
    const runtimeHost = { emit: vi.fn() };

    const services = {
      checkInterruption: () => false,
      isSubagent: true,
      logger: { emit: vi.fn(), error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages: vi.fn(async () => []),
        extractAssistantText: () => undefined,
      },
      onBeforeWaiting,
      onFollowUpConsumed,
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp: async () => ({
          items: [{ text: 'continue the proof', origin: 'user' }],
        }),
      },
      streamStatus: new StreamStatusMachine(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    const transition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        return node.post(shared, prep, exec);
      },
    );

    expect(onBeforeWaiting).not.toHaveBeenCalled();
    expect(onFollowUpConsumed).toHaveBeenCalledOnce();
    expect(transition).toBe(FlowTransition.CONTINUE);
    expect(shared.deliveredToOrchestrator).toBeUndefined();
  });

  it('preserves delivered state when interruption is already set before waiting', async () => {
    const shared: ToolUseRunShared = {
      deliveredToOrchestrator: true,
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const onBeforeWaiting = vi.fn(async () => true);
    const runtimeHost = { emit: vi.fn() };

    const services = {
      checkInterruption: () => true,
      isSubagent: true,
      logger: { emit: vi.fn(), error: vi.fn(), info: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      onBeforeWaiting,
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp: vi.fn(),
      },
      streamStatus: new StreamStatusMachine(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const transition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        return node.post(shared, prep, exec);
      },
    );

    expect(onBeforeWaiting).not.toHaveBeenCalled();
    expect(transition).toBe(FlowTransition.COMPLETE);
    expect(shared.deliveredToOrchestrator).toBe(true);
  });

  it('warns when follow-up media cannot be attached to a non-vision model', async () => {
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const warn = vi.fn();
    const addMediaToUserMessage = vi.fn(async () => {});
    const runtimeHost = { emit: vi.fn() };

    const services = {
      checkInterruption: () => false,
      fileService: {
        createLocation: (filePath: string) => ({ absolutePath: filePath }),
      },
      logger: { emit: vi.fn(), info: vi.fn(), warn },
      modelHandler: {
        addMediaToUserMessage,
        capabilities: {
          supportsNativeAudio: true,
          supportsVision: false,
        },
        createUserFollowUpMessages: vi.fn(async () => []),
      },
      runtimeHost,
      streamStatus: new StreamStatusMachine(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);
    const transition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      () =>
        node.post(
          shared,
          {
            afterError: false,
            lastResponse: undefined,
            previouslyDeliveredToOrchestrator: false,
            touchedFiles: [],
          },
          {
            followUps: [
              {
                text: 'please inspect this figure',
                mediaFiles: ['/tmp/figure.png'],
                origin: 'user',
              },
            ],
            kind: 'continue',
          },
        ),
    );

    expect(transition).toBe(FlowTransition.CONTINUE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Model has no vision support'),
    );
    expect(addMediaToUserMessage).toHaveBeenCalledOnce();
  });

  it('pauses the goal after a failed parent cycle', async () => {
    const streamId = 'wait-node-error-goal' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'finish the refactor');

    const shared: ToolUseRunShared = {
      lastError: { message: 'cycle failed', userRetryable: false },
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const runtimeHost = { emit: vi.fn() };
    const logger = new TraceEmitter();
    const hub = new SessionEventHub();
    const detachTrace = logger.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const detachProjection = attachSessionProgressEventProjectionForTest(
      hub,
      runtimeHost,
    );
    const waitForFollowUp = vi.fn();
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger,
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      stopAfterCycle: true,
      streamId,
      streamStatus: new StreamStatusMachine(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(runtimeHost, streamId, () =>
        node.exec({
          afterError: true,
          lastResponse: undefined,
          previouslyDeliveredToOrchestrator: false,
          touchedFiles: [],
        }),
      );

      const goal = GoalStore.getForStream(streamId);
      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(goal?.status).toBe('paused');
      expect(runtimeHost.emit).toHaveBeenCalledWith('goalPaused', {
        streamId,
      });
      expect(runtimeHost.emit).toHaveBeenCalledWith(
        'updateBashApprovalBypassState',
        { streamId, bypassActive: false },
      );
      expect(runtimeHost.emit).not.toHaveBeenCalledWith(
        'updateToolEditApprovalBypassState',
        { streamId, bypassActive: false },
      );
    } finally {
      detachProjection();
      detachTrace();
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  it('injects an active goal continuation before the blocking wait', async () => {
    const streamId = 'wait-node-active-goal' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Finish the autonomous proof audit.');

    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const createUserFollowUpMessages = vi.fn(
      async (messages: unknown[], userMessage: string) => [
        ...messages,
        { role: 'user', content: userMessage },
      ],
    );
    const onFollowUpConsumed = vi.fn();
    const waitForFollowUp = vi.fn();
    const streamStatus = new StreamStatusMachine();
    const runtimeHost = { emit: vi.fn() };
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger: { emit: vi.fn(), error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      onFollowUpConsumed,
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus,
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.RUNNING);
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(runtimeHost, streamId, () =>
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

      const transition = await withTestRunContext(runtimeHost, streamId, () =>
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

    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const createUserFollowUpMessages = vi.fn(
      async (messages: unknown[], userMessage: string) => [
        ...messages,
        { role: 'user', content: userMessage },
      ],
    );
    const waitForFollowUp = vi.fn(async () => null);
    const runtimeHost = { emit: vi.fn() };
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger: { emit: vi.fn(), error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus: new StreamStatusMachine(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const continuationCycles = 25;
      for (let cycle = 0; cycle < continuationCycles; cycle += 1) {
        const prep = await node.prep(shared);
        const exec = await withTestRunContext(runtimeHost, streamId, () =>
          node.exec(prep),
        );

        expect(exec.kind).toBe('continue');
        if (exec.kind !== 'continue') return;
        expect(exec.synthetic).toBe(true);
        expect(exec.followUps[0]?.text).toContain(
          'Keep solving the hard problem until verification is complete.',
        );

        const transition = await withTestRunContext(runtimeHost, streamId, () =>
          node.post(shared, prep, exec),
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
      const exec = await withTestRunContext(runtimeHost, streamId, () =>
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
      items: [{ text: 'user correction', origin: 'user' }],
      synthetic: false,
    }));
    const runtimeHost = { emit: vi.fn() };
    const services = {
      checkInterruption: () => false,
      logger: { emit: vi.fn(), error: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp,
      },
      streamId,
      streamStatus: new StreamStatusMachine(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(runtimeHost, streamId, () =>
        node.exec({
          afterError: false,
          lastResponse: undefined,
          previouslyDeliveredToOrchestrator: false,
          touchedFiles: [],
        }),
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
    const streamId = 'wait-node-goal-subagent' as StreamTabId;
    await installPlatform();

    await GoalStore.start(streamId, 'Parent-owned objective.');

    const waitForFollowUp = vi.fn(async () => null);
    const runtimeHost = { emit: vi.fn() };
    const services = {
      checkInterruption: () => false,
      isSubagent: true,
      logger: { emit: vi.fn(), error: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus: new StreamStatusMachine(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(runtimeHost, streamId, () =>
        node.exec({
          afterError: false,
          lastResponse: undefined,
          previouslyDeliveredToOrchestrator: false,
          touchedFiles: [],
        }),
      );

      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(exec.kind).toBe('stop');
      expect(GoalStore.getForStream(streamId)?.status).toBe('active');
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('updates the injected stream status owner while waiting and resuming', async () => {
    const streamId = 'wait-node-owner' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const createUserFollowUpMessages = vi.fn(async () => []);
    const runtimeHost = { emit: vi.fn() };
    const services = {
      checkInterruption: () => false,
      logger: { emit: vi.fn(), error: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp: async () => ({
          items: [{ text: 'continue', origin: 'synthetic' }],
          synthetic: true,
        }),
      },
      streamId,
      streamStatus,
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);
      seedStreamStatusForTest(
        StreamStatusService,
        streamId,
        STREAM_PHASE.CANCELLED,
      );

      const prep = await node.prep(shared);
      const exec = await withTestRunContext(runtimeHost, streamId, () =>
        node.exec(prep),
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.WAITING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_PHASE.CANCELLED);

      await withTestRunContext(runtimeHost, streamId, () =>
        node.post(shared, prep, exec),
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
      clearStreamStatusForTest(StreamStatusService, streamId);
    }
  });

  it('repairs retry-cancelled parent cycles to waiting before blocking', async () => {
    const streamId = 'wait-node-retry-cancelled-wait' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const runtimeHost = { emit: vi.fn() };
    const waitForFollowUp = vi.fn(async () => null);
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger: { emit: vi.fn(), error: vi.fn(), info: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus,
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.CANCELLED);

      const exec = await withTestRunContext(runtimeHost, streamId, () =>
        node.exec({
          afterError: true,
          lastResponse: undefined,
          previouslyDeliveredToOrchestrator: false,
          touchedFiles: [],
        }),
      );

      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(runtimeHost.emit).toHaveBeenCalledWith(
        'updateStreamStatus',
        expect.objectContaining({
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.CANCELLED,
          cause: 'resume',
        }),
      );
      expect(runtimeHost.emit).toHaveBeenCalledWith(
        'updateStreamStatus',
        expect.objectContaining({
          status: STREAM_PHASE.WAITING,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'wait',
        }),
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('appends queued subagent results and user follow-ups as separate turns', async () => {
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const createUserFollowUpMessages = vi.fn(
      async (messages: unknown[], userMessage: string) => [
        ...messages,
        { role: 'user', content: userMessage },
      ],
    );
    const info = vi.fn();
    const runtimeHost = { emit: vi.fn() };
    const streamStatus = new StreamStatusMachine();
    const services = {
      checkInterruption: () => false,
      logger: { emit: vi.fn(), error: vi.fn(), info },
      modelHandler: {
        capabilities: { supportsVision: true },
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      runtimeHost,
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
      streamStatus,
      streamId: 'test-stream',
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);
    seedStreamStatusForTest(
      streamStatus,
      'test-stream' as StreamTabId,
      STREAM_PHASE.WAITING,
    );

    const prep = await node.prep(shared);
    const transition = await withTestRunContext(
      runtimeHost,
      'test-stream',
      async () => {
        const exec = await node.exec(prep);
        return node.post(shared, prep, exec);
      },
    );

    expect(transition).toBe(FlowTransition.CONTINUE);
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateStreamStatus',
      expect.objectContaining({ status: STREAM_STATUS.RUNNING }),
    );
    expect(runtimeHost.emit.mock.invocationCallOrder[0]).toBeLessThan(
      info.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
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
