// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';

// Local imports - tools
import { emitGitHubSubscriptionChanged } from '@tools/github/subscriptionEventEmitter';

// Local imports - test
import { createRecordingHost } from '../progressTestUtils';

describe('GitHub subscription progress events', () => {
  it('publishes binding changes through the scoped runtime host', () => {
    const active = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      withRunContext(createRunContext({ runtimeHost: active.host }), () => {
        emitGitHubSubscriptionChanged(
          'repoSubscriptionBindingsChanged',
          undefined,
        );
      });
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(active.events).toEqual([
      { event: 'repoSubscriptionBindingsChanged', payload: undefined },
    ]);
    expect(fallback.events).toEqual([]);
  });

  it('uses the default runtime host outside a scoped run context', () => {
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      emitGitHubSubscriptionChanged(
        'issueSubscriptionBindingsChanged',
        undefined,
      );
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(fallback.events).toEqual([
      { event: 'issueSubscriptionBindingsChanged', payload: undefined },
    ]);
  });
});
