import { describe, expect, it } from 'vitest';

import {
  currentModelFromUserChannels,
  withToolUseSharedModel,
} from '@agent/implementations/flows/tooluse/modelSwitchState';
import type { ToolUseRunShared } from '@agent/implementations/flows/tooluse/nodes/types';

describe('tool-use model switch state helpers', () => {
  it('prefers the transient model over the launch model', () => {
    expect(
      currentModelFromUserChannels({
        input: Object.freeze({ MODEL: 'gpt54' }),
        transient: { MODEL: 'gpt55' },
      }),
    ).toBe('gpt55');
  });

  it('updates the persisted transient model without rewriting input variables', () => {
    const input = Object.freeze({ MODEL: 'gpt54' });
    const shared = {
      messages: [],
      shouldSkipCycle: false,
      stateSlices: {
        runStateSnapshot: {},
        workspaceSnapshot: {},
        userChannels: { input, transient: { MODEL: 'gpt54' } },
      },
    } as unknown as ToolUseRunShared;

    const updated = withToolUseSharedModel(shared, 'gpt55');

    expect(updated?.stateSlices?.userChannels.input).toBe(input);
    expect(updated?.stateSlices?.userChannels.transient.MODEL).toBe('gpt55');
  });

  it('returns null when the flow has not reached resumable state', () => {
    expect(
      withToolUseSharedModel(
        { messages: [], shouldSkipCycle: false, stateSlices: null },
        'gpt55',
      ),
    ).toBeNull();
  });
});
