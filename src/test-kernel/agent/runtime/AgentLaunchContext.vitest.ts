// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { getAgentPath } from '@agent/runtime/AgentLaunchContext';

import { createRecordingHost } from '../progressTestUtils';

describe('AgentLaunchContext', () => {
  it('publishes missing-agent banners through the explicit runtime host', async () => {
    const explicit = createRecordingHost();

    await expect(
      getAgentPath('__missing_agent_for_launch_context_test__', explicit.host),
    ).rejects.toThrow('Could not find agent');

    expect(explicit.events).toEqual([
      {
        event: 'showAgentConfigBanner',
        payload: {
          agentName: '__missing_agent_for_launch_context_test__',
        },
      },
    ]);
  });
});
