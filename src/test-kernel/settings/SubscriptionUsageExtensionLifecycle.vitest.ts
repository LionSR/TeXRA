import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMainWebview: vi.fn(async () => undefined),
  safeExecuteCommand: vi.fn(),
}));
vi.mock('@frontend/system/commandUtils', () => ({
  getMainWebview: mocks.getMainWebview,
  safeExecuteCommand: mocks.safeExecuteCommand,
}));

import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SubscriptionUsageProvider } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type * as vscode from 'vscode';

interface Harness {
  handleSetProviderSetting(data: {
    key: string;
    value: boolean;
  }): Promise<void>;
  refreshAfterProviderKeyChange(provider: string): Promise<void>;
  refreshAfterSubscriptionAuthChange(provider?: 'chatgpt'): Promise<void>;
}

function createHarness(activeView = true) {
  const posted: unknown[] = [];
  const usage = {
    invalidate: vi.fn(),
    getUsage: vi.fn(async (provider: SubscriptionUsageProvider) => ({
      state: 'unavailable' as const,
      provider,
      providerName: provider,
      planName: provider,
      fetchedAt: 0,
      windows: [] as [],
      reason: 'missing_credentials' as const,
    })),
  };
  const handler = Object.create(
    SettingsViewMessageHandler.prototype,
  ) as Harness;
  Reflect.set(handler, 'viewName', 'SettingsView');
  Reflect.set(handler, 'subscriptionUsage', usage);
  Reflect.set(handler, 'profileController', {
    setProviderSetting: vi.fn(async () => ({
      kind: 'updated',
      affectsModelAvailability: false,
    })),
  });
  Reflect.set(handler, 'sendProfileData', vi.fn());
  Reflect.set(handler, 'sendProfileAndModelSelectionData', vi.fn());
  Reflect.set(handler, 'sendModelSelectionData', vi.fn());
  Reflect.set(handler, 'sendReliabilityAndOrchestrationSettings', vi.fn());
  Reflect.set(
    handler,
    'withActiveWebview',
    async (callback: (webview: vscode.Webview) => Promise<void>) => {
      if (!activeView) return;
      await callback({
        postMessage: async (message: unknown) => {
          posted.push(message);
          return true;
        },
      } as unknown as vscode.Webview);
    },
  );
  return { handler, posted, usage };
}

describe('extension subscription usage credential lifecycle', () => {
  it('invalidates only coding-plan providers and replaces visible usage after key changes', async () => {
    const { handler, posted, usage } = createHarness();

    await handler.refreshAfterProviderKeyChange('glm');

    expect(usage.invalidate).toHaveBeenCalledExactlyOnceWith('glmCodingPlan');
    expect(usage.getUsage).toHaveBeenCalledTimes(3);
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      }),
    );

    usage.invalidate.mockClear();
    usage.getUsage.mockClear();
    await handler.refreshAfterProviderKeyChange('openai');
    expect(usage.invalidate).not.toHaveBeenCalled();
    expect(usage.getUsage).not.toHaveBeenCalled();
  });

  it('invalidates coding-plan usage when no Settings view is active', async () => {
    const { handler, posted, usage } = createHarness(false);

    await handler.refreshAfterProviderKeyChange('kimiCode');
    await handler.refreshAfterProviderKeyChange('glm');

    expect(usage.invalidate.mock.calls).toStrictEqual([
      ['kimiCode'],
      ['glmCodingPlan'],
    ]);
    expect(usage.getUsage).not.toHaveBeenCalled();
    expect(posted).toStrictEqual([]);
  });

  it('replaces GLM usage after the region changes', async () => {
    const { handler, posted, usage } = createHarness();

    await handler.handleSetProviderSetting({
      key: GlobalStateKey.GLM_USE_CHINA,
      value: false,
    });

    expect(usage.invalidate).not.toHaveBeenCalled();
    expect(usage.getUsage).toHaveBeenCalledTimes(3);
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      }),
    );
  });

  it('invalidates ChatGPT usage after account auth changes', async () => {
    const { handler, posted, usage } = createHarness();

    await handler.refreshAfterSubscriptionAuthChange('chatgpt');

    expect(usage.invalidate).toHaveBeenCalledExactlyOnceWith('chatgpt');
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      }),
    );
  });
});
