import { describe, expect, it } from 'vitest';

import { formatCliAccountLabelForDisplay } from '@cli/runtime/accountDisplay';
import {
  formatCliAuthStatusLine,
  formatRelayUsageStatus,
} from '@cli/runtime/apiStatus';
import type { RelayUsageSummary } from '@cli/runtime/relayUsage';

describe('CLI API status text', () => {
  it('shows relay quota usage as a percentage', () => {
    const summary: RelayUsageSummary = {
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-06-01T00:00:00.000Z',
      tier: 'Ultra',
      limitUsd: 300,
      costUsd: 42,
      remainingUsd: 258,
      usagePercent: 14,
      streamCount: 3,
      inputTokens: 1,
      netInputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      reasoningTokens: 0,
      modelsUsed: 2,
      providersUsed: 1,
    };

    expect(formatRelayUsageStatus(summary)).toBe(
      'relay usage this month: 14.0% used, 86.0% remaining',
    );
  });

  it('shows account labels plainly in auth status', () => {
    expect(formatCliAccountLabelForDisplay('14889516+LionSR@users.noreply.github.com')).toBe(
      '14889516+LionSR@users.noreply.github.com',
    );
    expect(
      formatCliAuthStatusLine({
        authenticated: true,
        accountLabel: 'user@example.edu',
      }),
    ).toBe('auth: signed in as user@example.edu');
  });

  it('keeps non-email account labels readable', () => {
    expect(formatCliAccountLabelForDisplay('github-user')).toBe('github-user');
    expect(formatCliAccountLabelForDisplay('team@internal')).toBe(
      'team@internal',
    );
    expect(
      formatCliAuthStatusLine({
        authenticated: true,
        accountLabel: 'team@internal',
      }),
    ).toBe('auth: signed in as team@internal');
    expect(formatCliAuthStatusLine({ authenticated: true })).toBe(
      'auth: signed in',
    );
    expect(formatCliAuthStatusLine({ authenticated: false })).toBe(
      'auth: signed out',
    );
  });
});
