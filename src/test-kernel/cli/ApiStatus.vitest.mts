import { describe, expect, it } from 'vitest';

import {
  formatCliApiStatusActionHint,
  formatCliAuthStatusLine,
  formatCliModelAccessOverview,
  formatRelayUsageStatus,
} from '@cli/runtime/apiStatus';
import type { RelayUsageSummary } from '@cli/runtime/relayUsage';

describe('CLI API status text', () => {
  it('reports both accounts, the effective route, and its API fallback', () => {
    expect(
      formatCliModelAccessOverview(
        {
          active: 'chatgpt',
          chatGptSignedIn: true,
          chatGptAccountLabel: 'chatgpt@example.com',
        },
        {
          authenticated: true,
          accountLabel: 'texra@example.com',
        },
        'personal',
      ),
    ).toEqual({
      access: {
        active: 'chatgpt',
        chatGptSignedIn: true,
        chatGptAccountLabel: 'chatgpt@example.com',
        texraSignedIn: true,
      },
      lines: [
        'model access: ChatGPT subscription',
        'ChatGPT: signed in as chatgpt@example.com',
        'TeXRA: signed in as texra@example.com',
        'API fallback: Personal API keys',
      ],
    });
  });

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

  it('shows account labels plainly in auth status', () => {
    expect(
      formatCliAuthStatusLine({
        authenticated: true,
        accountLabel: 'researcher@example.com',
      }),
    ).toBe('auth: signed in as researcher@example.com');
    expect(
      formatCliAuthStatusLine({
        authenticated: true,
        accountLabel: 'user@example.edu',
      }),
    ).toBe('auth: signed in as user@example.edu');
  });

  it('keeps non-email account labels readable', () => {
    expect(
      formatCliAuthStatusLine({
        authenticated: true,
        accountLabel: 'github-user',
      }),
    ).toBe('auth: signed in as github-user');
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

  it('formats startup action hints from API mode and sign-in state', () => {
    expect(
      formatCliApiStatusActionHint('included', { authenticated: false }),
    ).toBe(
      'actions: choose Model access below; `texra login` signs in to Researcher Access',
    );
    expect(
      formatCliApiStatusActionHint(
        'included',
        { authenticated: false },
        { hasPersonalKey: true },
      ),
    ).toBe(
      'actions: choose Model access below; `texra login` signs in to Researcher Access',
    );
    expect(
      formatCliApiStatusActionHint('included', { authenticated: true }),
    ).toBe(
      'actions: choose Model access below; `texra login --select-account` changes account',
    );
    expect(
      formatCliApiStatusActionHint('personal', { authenticated: true }),
    ).toBe('actions: choose Model access below; `texra logout` signs out');
    expect(
      formatCliApiStatusActionHint('personal', { authenticated: false }),
    ).toBe(
      'actions: choose Model access below, add a provider key, or sign in with Researcher Access',
    );
    expect(
      formatCliApiStatusActionHint(
        'personal',
        { authenticated: false },
        { hasPersonalKey: true },
      ),
    ).toBe('actions: choose Model access below; provider keys are configured');
  });
});
