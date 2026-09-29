import { describe, expect, it } from 'vitest';

import { firstRunSetupAgentOverride } from '@cli/onboarding/setupContinuation';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';

describe('firstRunSetupAgentOverride', () => {
  it.each([
    {
      scenario: 'hands the session to the setup agent on a true first run',
      input: { onboardingConfigured: true, firstRunDone: false },
      expected: SETUP_AGENT_NAME as string | undefined,
    },
    {
      scenario:
        'does nothing when onboarding did not just configure a credential',
      input: { onboardingConfigured: false, firstRunDone: false },
      expected: undefined,
    },
    {
      scenario: 'does nothing once the first run is done',
      input: { onboardingConfigured: true, firstRunDone: true },
      expected: undefined,
    },
    {
      scenario: 'never displaces an agent the user pinned themselves',
      input: {
        onboardingConfigured: true,
        firstRunDone: false,
        pinnedAgent: 'research',
      },
      expected: undefined,
    },
    {
      scenario: 'ignores a blank pinned agent',
      input: {
        onboardingConfigured: true,
        firstRunDone: false,
        pinnedAgent: '   ',
      },
      expected: SETUP_AGENT_NAME as string | undefined,
    },
  ])('$scenario', ({ input, expected }) => {
    expect(firstRunSetupAgentOverride(input)).toBe(expected);
  });
});
