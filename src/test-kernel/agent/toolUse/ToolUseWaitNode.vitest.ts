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
});
