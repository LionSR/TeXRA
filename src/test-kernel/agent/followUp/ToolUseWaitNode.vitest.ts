// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { createFakePlatform } from '@test/support/FakePlatform';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import {
  extractTouchedFiles,
  type ToolUseRunShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import {
  StreamStatusRegistry,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
import {
  MESSAGE_TYPES,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { cleanupApprovalsForStream } from '@tools/approval';
import { GoalStore } from '@tools/goal';

describe('ToolUseWaitNode', () => {
  it('marks a delivered subagent cycle before stopping on interruption', async () => {
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

    const services = {
      attachedMemoryMisses: memoryMisses,
      checkInterruption: () => interrupted,
      isSubagent: true,
      logger: { error: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      onBeforeWaiting,
      runtimeHost: { emit: vi.fn() },
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp: async () => {
          interrupted = true;
          return null;
        },
      },
      streamStatus: new StreamStatusRegistry(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const exec = await node.exec(prep);
    const transition = await node.post(shared, prep, exec);

    expect(onBeforeWaiting).toHaveBeenCalledOnce();
    expect(onBeforeWaiting).toHaveBeenCalledWith(undefined, [], memoryMisses);
    expect(transition).toBe(FlowTransition.COMPLETE);
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

    const services = {
      checkInterruption: () => interrupted,
      isSubagent: true,
      logger: { error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages: vi.fn(async () => []),
        extractAssistantText: () => undefined,
      },
      onBeforeWaiting,
      runtimeHost: { emit: vi.fn() },
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
      streamStatus: new StreamStatusRegistry(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const firstPrep = await node.prep(shared);
    const firstExec = await node.exec(firstPrep);
    const firstTransition = await node.post(shared, firstPrep, firstExec);
    expect(firstTransition).toBe(FlowTransition.CONTINUE);
    expect(shared.deliveredToOrchestrator).toBe(true);

    const secondPrep = await node.prep(shared);
    const secondExec = await node.exec(secondPrep);
    const secondTransition = await node.post(shared, secondPrep, secondExec);

    expect(onBeforeWaiting).toHaveBeenCalledTimes(2);
    expect(secondTransition).toBe(FlowTransition.COMPLETE);
    expect(shared.deliveredToOrchestrator).toBe(true);
  });

  it('preserves delivered state when interruption is already set before waiting', async () => {
    const shared: ToolUseRunShared = {
      deliveredToOrchestrator: true,
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const onBeforeWaiting = vi.fn(async () => true);

    const services = {
      checkInterruption: () => true,
      isSubagent: true,
      logger: { error: vi.fn(), info: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      onBeforeWaiting,
      runtimeHost: { emit: vi.fn() },
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp: vi.fn(),
      },
      streamStatus: new StreamStatusRegistry(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const exec = await node.exec(prep);
    const transition = await node.post(shared, prep, exec);

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

    const services = {
      checkInterruption: () => false,
      fileService: {
        createLocation: (filePath: string) => ({ absolutePath: filePath }),
      },
      logger: { info: vi.fn(), warn },
      modelHandler: {
        addMediaToUserMessage,
        capabilities: {
          supportsNativeAudio: true,
          supportsVision: false,
        },
        createUserFollowUpMessages: vi.fn(async () => []),
      },
      runtimeHost: { emit: vi.fn() },
      streamStatus: new StreamStatusRegistry(),
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);
    const transition = await node.post(
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
    );

    expect(transition).toBe(FlowTransition.CONTINUE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Model has no vision support'),
    );
    expect(addMediaToUserMessage).toHaveBeenCalledOnce();
  });

  it('pauses the goal after a failed parent cycle', async () => {
    const streamId = 'wait-node-error-goal' as StreamTabId;
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));

    await GoalStore.start(streamId, 'finish the refactor');

    const shared: ToolUseRunShared = {
      lastError: { message: 'cycle failed', userRetryable: false },
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const runtimeHost = { emit: vi.fn() };
    const waitForFollowUp = vi.fn();
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger: { error: vi.fn(), info: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost,
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      stopAfterCycle: true,
      streamId,
      streamStatus: new StreamStatusRegistry(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await node.exec({
        afterError: true,
        lastResponse: undefined,
        previouslyDeliveredToOrchestrator: false,
        touchedFiles: [],
      });

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
      await GoalStore.forget(streamId);
      cleanupApprovalsForStream(streamId);
    }
  });

  it('injects an active goal continuation before the blocking wait', async () => {
    const streamId = 'wait-node-active-goal' as StreamTabId;
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));

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
    const streamStatus = new StreamStatusRegistry();
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger: { error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      onFollowUpConsumed,
      runtimeHost: { emit: vi.fn() },
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus,
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const prep = await node.prep(shared);
      const exec = await node.exec(prep);

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
      expect(streamStatus.get(streamId)).toBeUndefined();

      const transition = await node.post(shared, prep, exec);

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
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));

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
    const services = {
      checkInterruption: () => false,
      isSubagent: false,
      logger: { error: vi.fn(), info: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      runtimeHost: { emit: vi.fn() },
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus: new StreamStatusRegistry(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const continuationCycles = 25;
      for (const cycle of Array.from(
        { length: continuationCycles },
        (_, index) => index,
      )) {
        const prep = await node.prep(shared);
        const exec = await node.exec(prep);

        expect(exec.kind).toBe('continue');
        if (exec.kind !== 'continue') return;
        expect(exec.synthetic).toBe(true);
        expect(exec.followUps[0]?.text).toContain(
          'Keep solving the hard problem until verification is complete.',
        );

        const transition = await node.post(shared, prep, exec);
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
      const exec = await node.exec(prep);

      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(exec.kind).toBe('stop');
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('lets queued user follow-up win over an active goal continuation', async () => {
    const streamId = 'wait-node-goal-user-queued' as StreamTabId;
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));

    await GoalStore.start(streamId, 'Keep going autonomously.');

    const waitForFollowUp = vi.fn(async () => ({
      items: [{ text: 'user correction', origin: 'user' }],
      synthetic: false,
    }));
    const services = {
      checkInterruption: () => false,
      logger: { error: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost: { emit: vi.fn() },
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp,
      },
      streamId,
      streamStatus: new StreamStatusRegistry(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await node.exec({
        afterError: false,
        lastResponse: undefined,
        previouslyDeliveredToOrchestrator: false,
        touchedFiles: [],
      });

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
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}));

    await GoalStore.start(streamId, 'Parent-owned objective.');

    const waitForFollowUp = vi.fn(async () => null);
    const services = {
      checkInterruption: () => false,
      isSubagent: true,
      logger: { error: vi.fn() },
      modelHandler: { extractAssistantText: () => undefined },
      runtimeHost: { emit: vi.fn() },
      session: {
        hasQueuedFollowUp: () => false,
        waitForFollowUp,
      },
      streamId,
      streamStatus: new StreamStatusRegistry(),
    } as unknown as ToolUseServices;
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await node.exec({
        afterError: false,
        lastResponse: undefined,
        previouslyDeliveredToOrchestrator: false,
        touchedFiles: [],
      });

      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(exec.kind).toBe('stop');
      expect(GoalStore.getForStream(streamId)?.status).toBe('active');
    } finally {
      await GoalStore.forget(streamId);
    }
  });

  it('updates the injected stream status owner while waiting and resuming', async () => {
    const streamId = 'wait-node-owner' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    const createUserFollowUpMessages = vi.fn(async () => []);
    const services = {
      checkInterruption: () => false,
      logger: { error: vi.fn() },
      modelHandler: {
        createUserFollowUpMessages,
        extractAssistantText: () => undefined,
      },
      runtimeHost: { emit: vi.fn() },
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
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });
      StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });

      const prep = await node.prep(shared);
      const exec = await node.exec(prep);
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.WAITING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);

      await node.post(shared, prep, exec);
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.RUNNING);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    } finally {
      streamStatus.clear(streamId, { emit: false });
      StreamStatusService.clear(streamId, { emit: false });
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
    const streamStatus = new StreamStatusRegistry();
    const services = {
      checkInterruption: () => false,
      logger: { error: vi.fn(), info },
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

    const prep = await node.prep(shared);
    const exec = await node.exec(prep);
    const transition = await node.post(shared, prep, exec);

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
