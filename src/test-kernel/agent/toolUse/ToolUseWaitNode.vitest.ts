// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import type { ToolUseRunShared } from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';

describe('ToolUseWaitNode', () => {
  it('marks a delivered subagent cycle before stopping on interruption', async () => {
    const shared: ToolUseRunShared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };
    let interrupted = false;
    const onBeforeWaiting = vi.fn(async () => {});

    const services = {
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
      streamId: 'test-stream',
    } as unknown as ToolUseServices;

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const exec = await node.exec(prep);
    const transition = await node.post(shared, prep, exec);

    expect(onBeforeWaiting).toHaveBeenCalledOnce();
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
              items: ['synthetic continuation'],
              synthetic: true,
            };
          }
          interrupted = true;
          return null;
        },
      },
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
});
