import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
};

type SubscriptionsTabElement = HTMLElement & {
  usage: SubscriptionUsageSnapshots | null;
  now: number;
  updateComplete: Promise<boolean>;
};

type SubscriptionUsageRowElement = HTMLElement & {
  snapshot: SubscriptionUsageSnapshot | null;
  now: number;
  updateComplete: Promise<boolean>;
};

function getKimiUsageRow(
  tab: SubscriptionsTabElement,
): SubscriptionUsageRowElement | null {
  return (
    tab.shadowRoot?.querySelector<SubscriptionUsageRowElement>(
      '#kimi-code-subscription subscription-usage-row',
    ) ?? null
  );
}

function mountTab(): Promise<SubscriptionsTabElement> {
  return mountComponent<SubscriptionsTabElement>('subscriptions-tab', {
    usage: snapshots,
  });
}

function mountTabWithFakeTimers(): Promise<SubscriptionsTabElement> {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return mountTab();
}

describe('subscription usage rendering', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/tabs/SubscriptionsTab'),
  );

  beforeEach(() => mocks.postMessage.mockClear());
  afterEach(() => vi.useRealTimers());

  it('renders accessible meters and one refresh action', async () => {
    const tab = await mountTab();

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

    tab.now = NOW;
    await tab.updateComplete;
    const kimiRow = getKimiUsageRow(tab);
    expect(kimiRow).not.toBeNull();
    await kimiRow!.updateComplete;
    expect(kimiRow!.shadowRoot?.querySelector('wa-details')).toBeNull();
    const styleText = (
      kimiRow!.constructor as unknown as {
        styles: readonly { cssText: string }[];
      }
    ).styles
      .map((style) => style.cssText)
      .join('\n');
    expect(styleText).toContain('flex: 1 1 100%');
    expect(styleText).toContain('min-width: 0');
    const text = kimiRow!.shadowRoot?.textContent ?? '';
    expect(text).toContain('Kimi Code plan usage');
    expect(text.split('5-hour: 25%')).toHaveLength(2);
    expect(text.split('7-day: 100%')).toHaveLength(2);
    const meters = kimiRow!.shadowRoot?.querySelectorAll('progress');
    expect(meters).toHaveLength(2);
    expect(meters?.[0]?.getAttribute('aria-label')).toBe(
      'Kimi Code 5-hour usage: 25% used',
    );
    expect(text).toContain('resets in 1d 21h');
    expect(tab.shadowRoot?.textContent).not.toContain('Grok usage unavailable');
  });

  it('advances one tab clock while connected and stops it after disconnect', async () => {
    const tab = await mountTabWithFakeTimers();
    expect(tab.now).toBe(NOW);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3 * 60_000);
    await tab.updateComplete;
    expect(tab.now).toBe(NOW + 3 * 60_000);
    const kimiRow = getKimiUsageRow(tab);
    await kimiRow?.updateComplete;
    expect(kimiRow?.now).toBe(tab.now);
    expect(kimiRow?.shadowRoot?.textContent).toContain(
      'stale · updated 3m ago',
    );

    tab.remove();
    const disconnectedNow = tab.now;
    vi.advanceTimersByTime(2 * 60_000);
    expect(tab.now).toBe(disconnectedNow);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts one fresh clock when the same tab reconnects', async () => {
    const tab = await mountTabWithFakeTimers();

    tab.remove();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(NOW + 5 * 60_000);
    document.body.append(tab);
    await tab.updateComplete;

    expect(tab.now).toBe(NOW + 5 * 60_000);
    expect(vi.getTimerCount()).toBe(1);

    tab.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the tab clock when fresh usage arrives', async () => {
    const tab = await mountTabWithFakeTimers();
    tab.now = NOW - 10 * 60_000;
    vi.setSystemTime(NOW + 30_000);
    tab.usage = {
      ...snapshots,
      kimiCode: { ...snapshots.kimiCode, fetchedAt: NOW + 30_000 },
    };
    await tab.updateComplete;
    const kimiRow = getKimiUsageRow(tab);
    await kimiRow?.updateComplete;

    expect(tab.now).toBe(NOW + 30_000);
    expect(kimiRow?.shadowRoot?.textContent).toContain('updated just now');
  });
});
