import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('@shared/hostBridge', () => ({ postMessage: mocks.postMessage }));

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
  _ticker: { now: number };
  updateComplete: Promise<boolean>;
};

type SubscriptionUsageRowElement = HTMLElement & {
  snapshot: SubscriptionUsageSnapshot | null;
  now: number;
  updateComplete: Promise<boolean>;
};

/** The ChatGPT section's meter: the tab's ticker feeds it through the section. */
async function getChatgptUsageRow(
  tab: SubscriptionsTabElement,
): Promise<SubscriptionUsageRowElement | null> {
  const section = tab.shadowRoot?.querySelector<
    HTMLElement & { updateComplete: Promise<boolean> }
  >('subscription-section');
  await section?.updateComplete;
  return (
    section?.shadowRoot?.querySelector<SubscriptionUsageRowElement>(
      'subscription-usage-row',
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

  it('advances one tab clock while connected and stops it after disconnect', async () => {
    const tab = await mountTabWithFakeTimers();
    expect(tab._ticker.now).toBe(NOW);

    // The async variant yields to microtasks between each due timer, which
    // also drains every <wa-progress-bar>'s one-shot percentage-sync timer
    // along the way — so only the tab's own recurring ticker interval is
    // left pending below, without pinning the assertion to how many of
    // those third-party timers exist.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(tab._ticker.now).toBe(NOW + 3 * 60_000);
    expect(vi.getTimerCount()).toBe(1);
    const chatgptRow = await getChatgptUsageRow(tab);
    await chatgptRow?.updateComplete;
    expect(chatgptRow?.now).toBe(tab._ticker.now);
    expect(chatgptRow?.shadowRoot?.textContent).toContain(
      'stale · updated 3m ago',
    );

    tab.remove();
    const disconnectedNow = tab._ticker.now;
    vi.advanceTimersByTime(2 * 60_000);
    expect(tab._ticker.now).toBe(disconnectedNow);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the tab clock when fresh usage arrives', async () => {
    const tab = await mountTabWithFakeTimers();
    vi.setSystemTime(NOW + 30_000);
    tab.usage = {
      ...snapshots,
      chatgpt: { ...snapshots.chatgpt, fetchedAt: NOW + 30_000 },
    };
    await tab.updateComplete;
    const chatgptRow = await getChatgptUsageRow(tab);
    await chatgptRow?.updateComplete;

    expect(tab._ticker.now).toBe(NOW + 30_000);
    expect(chatgptRow?.shadowRoot?.textContent).toContain('updated just now');
  });
});
