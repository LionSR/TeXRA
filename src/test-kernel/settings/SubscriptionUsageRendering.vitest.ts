import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('@shared/hostBridge', () => ({ postMessage: mocks.postMessage }));

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SubscriptionUsageSnapshot,
  SubscriptionUsageSnapshots,
} from '@shared/schemas';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

const NOW = 1_800_000_000_000;

function snapshot(
  provider: SubscriptionUsageSnapshot['provider'],
  providerName: string,
): SubscriptionUsageSnapshot {
  return {
    state: 'available',
    provider,
    providerName,
    planName: `${providerName} plan`,
    fetchedAt: NOW,
    windows: [
      {
        name: 'five_hour',
        percentUsed: 25,
        percentRemaining: 75,
        resetAt: NOW + 2 * 60 * 60_000,
      },
      {
        name: 'seven_day',
        percentUsed: 100,
        percentRemaining: 0,
        resetAt: NOW + (24 + 21) * 60 * 60_000,
      },
    ],
  };
}

const snapshots: SubscriptionUsageSnapshots = {
  chatgpt: snapshot('chatgpt', 'ChatGPT'),
  kimiCode: snapshot('kimiCode', 'Kimi Code'),
  glmCodingPlan: snapshot('glmCodingPlan', 'GLM'),
  grok: {
    state: 'unavailable',
    provider: 'grok',
    providerName: 'Grok',
    planName: 'Grok subscription',
    fetchedAt: NOW,
    windows: [],
    reason: 'unsupported',
  },
};

type SubscriptionsTabElement = HTMLElement & {
  usage: SubscriptionUsageSnapshots | null;
  updateComplete: Promise<boolean>;
};

describe('subscription usage rendering', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/tabs/SubscriptionsTab'),
  );

  beforeEach(() => mocks.postMessage.mockClear());

  it('renders native collapsed summaries, accessible meters, and one refresh action', async () => {
    const tab = await mountComponent<SubscriptionsTabElement>(
      'subscriptions-tab',
      { usage: snapshots },
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
      { forceRefresh: false },
    );
    const refreshButtons = [
      ...(tab.shadowRoot?.querySelectorAll<HTMLElement>('wa-button') ?? []),
    ].filter((button) => button.textContent?.includes('Refresh usage'));
    expect(refreshButtons).toHaveLength(1);
    refreshButtons[0]?.click();
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
      { forceRefresh: true },
    );

    const kimiRow = tab.shadowRoot?.querySelector<HTMLElement>(
      '#kimi-code-subscription subscription-usage-row',
    ) as
      (HTMLElement & { now: number; updateComplete: Promise<boolean> }) | null;
    expect(kimiRow).not.toBeNull();
    if (!kimiRow) return;
    kimiRow.now = NOW;
    await kimiRow.updateComplete;
    const details = kimiRow.shadowRoot?.querySelector('wa-details');
    expect(details?.closest('.settings-row-text')).not.toBeNull();
    const styleText = (
      kimiRow.constructor as unknown as {
        styles: readonly { cssText: string }[];
      }
    ).styles
      .map((style) => style.cssText)
      .join('\n');
    expect(styleText).toContain('flex: 1 1 100%');
    expect(styleText).toContain('min-width: 0');
    expect(details?.getAttribute('summary')).toContain(
      '5-hour: 25% · 7-day: 100%',
    );
    const meters = kimiRow.shadowRoot?.querySelectorAll('progress');
    expect(meters).toHaveLength(2);
    expect(meters?.[0]?.getAttribute('aria-label')).toBe(
      'Kimi Code 5-hour usage: 25% used',
    );
    expect(kimiRow.shadowRoot?.textContent).toContain('resets in 1d 21h');
    expect(tab.shadowRoot?.textContent).not.toContain('Grok usage unavailable');
  });
});
