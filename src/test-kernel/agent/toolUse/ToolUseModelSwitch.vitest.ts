import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import {
  registerInterruptible,
  switchToolUseModel,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@shared/schemas';

const streamId = 'stream-model-switch' as StreamTabId;

afterEach(() => {
  unregisterInterruptible(streamId);
});

describe('switchToolUseModel', () => {
  it('delegates model changes to the active tool-use flow', async () => {
    let model = 'deepseekT';
    const switchModel = vi.fn(async (nextModel: string) => {
      model = nextModel;
    });

    registerInterruptible(streamId, {
      session: { appendFollowUp: vi.fn() },
      get model() {
        return model;
      },
      modelHandler: {},
      runtimeHost: {},
      interrupt: vi.fn(),
      requestImmediateCompaction: vi.fn(),
      switchModel,
    } as unknown as ToolUseFlowContext);

    await expect(switchToolUseModel(streamId, 'deepseek')).resolves.toEqual({
      status: 'switched',
    });
    expect(switchModel).toHaveBeenCalledWith('deepseek');
  });

  it('does not call the flow when the requested model is already active', async () => {
    const switchModel = vi.fn();

    registerInterruptible(streamId, {
      session: { appendFollowUp: vi.fn() },
      model: 'deepseekT',
      modelHandler: {},
      runtimeHost: {},
      interrupt: vi.fn(),
      requestImmediateCompaction: vi.fn(),
      switchModel,
    } as unknown as ToolUseFlowContext);

    await expect(switchToolUseModel(streamId, 'deepseekT')).resolves.toEqual({
      status: 'unchanged',
    });
    expect(switchModel).not.toHaveBeenCalled();
  });
});
