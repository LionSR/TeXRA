// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';

// Local imports - event bus
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - tools
import { emitGitHubSubscriptionChanged } from '@tools/github/subscriptionEventEmitter';

// Local imports - test
import { createRecordingHost } from '../progressTestUtils';

describe('GitHub subscription progress events', () => {
  it('publishes binding changes to the bus and scoped runtime host', () => {
    const active = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const busEvents: unknown[] = [];
    const off = bus.on('repoSubscriptionBindingsChanged', (payload) => {
      busEvents.push(payload);
    });
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      withRunContext(createRunContext({ runtimeHost: active.host }), () => {
        emitGitHubSubscriptionChanged(
          'repoSubscriptionBindingsChanged',
          undefined,
        );
      });
    } finally {
      off();
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(busEvents).toEqual([undefined]);
    expect(active.events).toEqual([
      { event: 'repoSubscriptionBindingsChanged', payload: undefined },
    ]);
    expect(fallback.events).toEqual([]);
  });

  it('does not duplicate binding changes through the default runtime host', () => {
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const busEvents: unknown[] = [];
    const off = bus.on('issueSubscriptionBindingsChanged', (payload) => {
      busEvents.push(payload);
    });
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      emitGitHubSubscriptionChanged(
        'issueSubscriptionBindingsChanged',
        undefined,
      );
    } finally {
      off();
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(busEvents).toEqual([undefined]);
    expect(fallback.events).toEqual([]);
  });
});
