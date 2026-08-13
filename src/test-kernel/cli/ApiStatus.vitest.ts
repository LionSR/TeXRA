import { describe, expect, it } from 'vitest';

import {
  formatCliApiStatusActionHint,
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
      'included usage this month: 14.0% used, 86.0% remaining',
    );
  });

  it.each<[Parameters<typeof formatCliAuthStatusLine>[0], string]>([
    [
      { authenticated: true, accountLabel: 'researcher@example.com' },
      'auth: signed in as researcher@example.com',
    ],
    [
      {
        authenticated: true,
        accountLabel: 'user@example.edu',
        tier: 'Ultra',
      },
      'auth: signed in as user@example.edu · tier: Ultra',
    ],
    // Non-email account labels stay readable.
    [
      { authenticated: true, accountLabel: 'github-user' },
      'auth: signed in as github-user',
    ],
    [
      { authenticated: true, accountLabel: 'team@internal' },
      'auth: signed in as team@internal',
    ],
    [{ authenticated: true }, 'auth: signed in'],
    [{ authenticated: false }, 'auth: signed out'],
  ])('formats auth status %j as "%s"', (status, expected) => {
    expect(formatCliAuthStatusLine(status)).toBe(expected);
  });

  it.each<
    [
      Parameters<typeof formatCliApiStatusActionHint>[0],
      Parameters<typeof formatCliApiStatusActionHint>[1],
      Parameters<typeof formatCliApiStatusActionHint>[2] | undefined,
      string,
    ]
  >([
    [
      'included',
      { authenticated: false },
      undefined,
      'actions: choose Model access below; `texra login` signs in with Researcher Access',
    ],
    [
      'included',
      { authenticated: false },
      { hasPersonalKey: true },
      'actions: choose Model access below; `texra login` signs in with Researcher Access',
    ],
    [
      'included',
      { authenticated: true },
      undefined,
      'actions: choose Model access below; `texra login --select-account` changes account',
    ],
    [
      'personal',
      { authenticated: true },
      undefined,
      'actions: choose Model access below; `texra logout` signs out',
    ],
    [
      'personal',
      { authenticated: false },
      undefined,
      'actions: choose Model access below, add a provider key, or sign in with Researcher Access',
    ],
    [
      'personal',
      { authenticated: false },
      { hasPersonalKey: true },
      'actions: choose Model access below; provider keys are configured',
    ],
  ])('formats the %s action hint (%#)', (mode, auth, options, expected) => {
    expect(formatCliApiStatusActionHint(mode, auth, options)).toBe(expected);
  });
});
