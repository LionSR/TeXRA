import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendSubscriptionUsage } from '@settingsView/handlers/subscriptionUsageHandlers';
import { settingsViewHandlers } from '@settingsView/frontend/messageDispatcher';
import {
  resetSettingsState,
  subscriptionUsage,
} from '@settingsView/frontend/settingsState';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { formatSubscriptionUsagePercent } from '@shared/subscriptionUsagePresentation';
import {
  dispatchSettingsViewOutbound,
  SettingsViewInboundMessageSchema,
  SUBSCRIPTION_USAGE_PROVIDERS,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageSnapshots,
} from '@shared/schemas';

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
      },
    ],
  };
}

const snapshots: SubscriptionUsageSnapshots = {
  chatgpt: snapshot('chatgpt', 'ChatGPT'),
  kimiCode: snapshot('kimiCode', 'Kimi Code'),
  glmCodingPlan: snapshot('glmCodingPlan', 'GLM'),
};

describe('subscription usage settings IPC', () => {
  beforeEach(() => resetSettingsState());

  it('validates refresh IPC and stores all three sanitized snapshots', () => {
    expect(
      SettingsViewInboundMessageSchema.safeParse({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
        forceRefresh: true,
      }).success,
    ).toBe(true);

    const message = {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      snapshots,
    } as const;
    expect(dispatchSettingsViewOutbound(message, settingsViewHandlers)).toBe(
      true,
    );
    expect(subscriptionUsage.get()).toStrictEqual(snapshots);
  });

  it.each([
    [99.95, '99.9%'],
    [0.05, '0.1%'],
    [100, '100%'],
    [0, '0%'],
  ] as const)('formats boundary usage %s as %s', (percent, expected) => {
    expect(formatSubscriptionUsagePercent(percent)).toBe(expected);
  });

  it('fetches every provider through the injected reader and posts no raw data', async () => {
    const getUsage = vi.fn(
      async (provider: SubscriptionUsageProvider) => snapshots[provider],
    );
    const postMessage = vi.fn(async () => true);

    await sendSubscriptionUsage(
      { postMessage } as never,
      { getUsage, invalidate: vi.fn() },
      true,
    );

    expect(getUsage.mock.calls).toStrictEqual(
      SUBSCRIPTION_USAGE_PROVIDERS.map((provider) => [
        provider,
        { forceRefresh: true },
      ]),
    );
    expect(postMessage).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      snapshots,
    });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('secret');
  });
});
