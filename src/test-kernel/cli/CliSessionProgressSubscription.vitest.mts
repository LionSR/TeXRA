import { describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { toRunFactDomainKey } from '@agent/runtime/runFactEvents';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import type { StreamTabId } from '@shared/schemas';

const streamId = 'stream:cli-session-projection' as StreamTabId;

function hostWithInteractions(
  interactions?: Partial<HostInteractions>,
): AgentRuntimeHost {
  return {
    emit: vi.fn(),
    interactions: {
      handleProgressEvent: () => false,
      resolve: () => false,
      cancel: () => {},
      ...interactions,
    },
  };
}

describe('attachCliSessionProgressProjection', () => {
  it('re-emits retained session facts through the headless CLI host rail', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId },
        },
      });

      expect(host.emit).toHaveBeenCalledWith('setActiveStream', { streamId });

      detach();
      events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'stream:after-detach' as StreamTabId },
        },
      });

      expect(host.emit).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it('keeps followUpSent session-local', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'followUpSent',
          payload: { streamId },
        },
      });

      expect(host.emit).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('offers removeStream to host interactions before legacy emission', () => {
    const events = new SessionEventHub();
    const handleProgressEvent = vi.fn(() => true);
    const host = hostWithInteractions({ handleProgressEvent });
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'session',
        event: {
          type: 'removeStream',
          payload: { streamId },
        },
      });

      expect(handleProgressEvent).toHaveBeenCalledWith('removeStream', {
        streamId,
      });
      expect(host.emit).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it('re-emits valid retained run facts through the headless CLI host rail', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'usage',
          stats: {},
          data: {
            streamId,
            storageKey: 'run-a',
            usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
          },
        },
      });

      expect(host.emit).toHaveBeenCalledWith('updateStreamUsage', {
        streamId,
        storageKey: 'run-a',
        usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
      });
    } finally {
      detach();
    }
  });

  it('drops malformed retained run facts instead of forwarding unchecked payloads', () => {
    const events = new SessionEventHub();
    const host = hostWithInteractions();
    const detach = attachCliSessionProgressProjection(events, host);

    try {
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'usage',
          stats: {},
          data: {
            streamId,
            usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
          },
        },
      });
      events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'domain',
          key: toRunFactDomainKey('updateTodos'),
          data: {
            streamId,
            todos: 'not-an-array',
          },
        },
      });

      expect(host.emit).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });
});
