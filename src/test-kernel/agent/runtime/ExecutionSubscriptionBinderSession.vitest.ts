// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const requestRuntimeFollowUpMock = vi.hoisted(() =>
  vi.fn(async () => ({ outcome: 'sent' as const, accepted: true })),
);

vi.mock('@agent/runtime/followUpCommands', () => ({
  requestRuntimeFollowUp: requestRuntimeFollowUpMock,
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

      expect(requestRuntimeFollowUpMock).toHaveBeenCalledWith({
        streamId,
        text: expect.stringContaining(executionId),
        runtimeHost: explicit.host,
        session,
      });
    } finally {
      binder.dispose();
      registry.dispose();
    }
  });
});
