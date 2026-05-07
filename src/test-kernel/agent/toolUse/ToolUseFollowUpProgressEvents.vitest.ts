// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import type { StreamTabId } from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:follow-up' as StreamTabId;

describe('tool-use follow-up progress events', () => {
  afterEach(() => {
    unregisterInterruptible(streamId);
  });

  it('publishes sent follow-up events through the active runtime host', async () => {
    const { events, host } = createRecordingHost();
    const appendFollowUp = vi.fn();

    registerInterruptible(streamId, {
      session: { appendFollowUp },
      modelHandler: {},
      runtimeHost: host,
      interrupt: vi.fn(),
    } as unknown as ToolUseFlowContext);

    const result = await sendFollowUp(streamId, 'please continue');

    expect(result).toEqual({ status: 'sent' });
    expect(appendFollowUp).toHaveBeenCalledWith('please continue');
    expect(events).toEqual([
      {
        event: 'followUpSent',
        payload: { streamId },
      },
    ]);
  });
});
