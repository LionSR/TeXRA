import { describe, expect, it } from 'vitest';

import {
  currentModelFromUserChannels,
  setToolUseSharedModel,
} from '@agent/implementations/flows/tooluse/modelSwitchState';
import type { ToolUseRunShared } from '@agent/implementations/flows/tooluse/nodes/types';
import { toolUseRunShared } from '../progressTestUtils';

describe('tool-use model switch state helpers', () => {
  it('prefers the transient model over the launch model', () => {
    expect(
      currentModelFromUserChannels({
        input: Object.freeze({ MODEL: 'gpt54' }),
        transient: { MODEL: 'gpt55' },
      }),
    ).toBe('gpt55');
  });

  it('writes the model id and reprojects MODEL without rewriting input variables', () => {
    const input = Object.freeze({ MODEL: 'gpt54' });
    const shared = {
      messages: [],
      modelId: 'gpt54',
      shouldSkipCycle: false,
      stateSlices: {
        runStateSnapshot: {},
        workspaceSnapshot: {},
        userChannels: { input, transient: { MODEL: 'gpt54' } },
      },
    } as unknown as ToolUseRunShared;

    const updated = setToolUseSharedModel(shared, 'gpt55');

    expect(updated).toBe(true);
    expect(shared.modelId).toBe('gpt55');
    expect(shared.stateSlices?.userChannels.input).toBe(input);
    expect(shared.stateSlices?.userChannels.transient.MODEL).toBe('gpt55');
  });

  it('returns false when the flow has not reached resumable state', () => {
    const shared = toolUseRunShared();

    expect(setToolUseSharedModel(shared, 'gpt55')).toBe(false);
    expect(shared.modelId).toBeUndefined();
  });
});
