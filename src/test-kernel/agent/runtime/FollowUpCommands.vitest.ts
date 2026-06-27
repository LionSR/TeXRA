import { describe, expect, it, vi } from 'vitest';

import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { requestRuntimeFollowUp } from '@agent/runtime/followUpCommands';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { StreamTabId } from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime follow-up commands', () => {
  it('sends user follow-ups to the live tool-use flow for a stream', async () => {
    const session = new SessionHandle();
    const streamId = 'runtime-follow-up-stream' as StreamTabId;
    const host = createRecordingHost();
    const appended: FollowUpQueueInput[] = [];

    try {
      const handle = new AgentExecutionHandle(
        'runtime-follow-up-execution',
        streamId,
        streamId,
        'test-tool-use',
        'toolUse',
        host,
      );
      handle.attachToolUseFlow({
        session: {
          appendFollowUp: (followUp) => appended.push(followUp),
        },
        modelHandler: {
          supportsManualCompaction: true,
        },
        runtimeHost: host,
        requestImmediateCompaction: vi.fn(),
        modelSwitchDisabledReason: vi.fn(),
        switchModel: vi.fn(),
      });
      session.executions.track(handle);

      const result = await requestRuntimeFollowUp({
        streamId,
        text: 'Continue with the proof.',
        displayText: 'Continue.',
        mediaFiles: ['diagram.png'],
        session,
      });

      expect(result).toEqual({ status: 'sent' });
      expect(appended).toEqual([
        {
          text: 'Continue with the proof.',
          displayText: 'Continue.',
          mediaFiles: ['diagram.png'],
        },
      ]);
    } finally {
      session.dispose();
    }
  });
});
