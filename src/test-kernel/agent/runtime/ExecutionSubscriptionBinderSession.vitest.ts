// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const sendFollowUpMock = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'sent' as const })),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: sendFollowUpMock,
}));

// Local imports - runtime
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { ExecutionSubscriptionBinder } from '@agent/runtime/ExecutionSubscriptionBinder';
import {
  AgentExecutionHandle,
  ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:subscription-session' as StreamTabId;
const childStreamId = 'child:subscription-session' as StreamTabId;

function createReleaseSource() {
  return {
    onRelease(): () => void {
      return () => {};
    },
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('ExecutionSubscriptionBinder session routing', () => {
  it('passes the owning session to subscription follow-ups', async () => {
    const registry = new ExecutionRegistry();
    const session = { tag: 'window-session' } as unknown as SessionHandle;
    const explicit = createRecordingHost();
    const binder = new ExecutionSubscriptionBinder({
      registry,
      releaseSource: createReleaseSource(),
      logger: createLogger(),
      session,
    });
    const executionId = 'exec-subscription-session-test';
    const handle = new AgentExecutionHandle(
      executionId,
      streamId,
      childStreamId,
      'search',
      'toolUse',
      explicit.host,
    );

    try {
      registry.track(handle);
      binder.bind(streamId, executionId, explicit.host);

      registry.untrack(executionId);
      await new Promise((resolve) => setImmediate(resolve));

      expect(sendFollowUpMock).toHaveBeenCalledWith(
        streamId,
        expect.stringContaining(executionId),
        undefined,
        undefined,
        session,
      );
    } finally {
      binder.dispose();
      registry.dispose();
    }
  });
});
