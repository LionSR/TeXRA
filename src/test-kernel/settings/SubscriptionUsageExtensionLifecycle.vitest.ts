import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // The refresh tail lifts this host command once; the double answers with
  // the promise the real one returns.
  safeExecuteCommand: vi.fn(async () => undefined),
}));
vi.mock('@frontend/system/commandUtils', () => ({
  safeExecuteCommand: mocks.safeExecuteCommand,
}));

import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SubscriptionUsageProvider } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import type * as vscode from 'vscode';

interface Harness {
  refreshAfterProviderKeyChange(provider: string): Effect.Effect<void, Error>;
  refreshAfterSubscriptionAuthChange(
    provider?: 'chatgpt',
  ): Effect.Effect<void, Error>;
}

function createHarness(activeView = true) {
  const posted: unknown[] = [];
  const unavailable = (provider: SubscriptionUsageProvider) => ({
    state: 'unavailable' as const,
    provider,
    providerName: provider,
    planName: provider,
    fetchedAt: 0,
    windows: [] as [],
    reason: 'missing_credentials' as const,
  });
  const usage = {
    invalidate: vi.fn(),
    getAllUsage: vi.fn(() =>
      Effect.succeed({
        chatgpt: unavailable('chatgpt'),
        kimiCode: unavailable('kimiCode'),
        glmCodingPlan: unavailable('glmCodingPlan'),
      }),
    ),
  };
  const handler = Object.create(
    SettingsViewMessageHandler.prototype,
  ) as Harness;
  Reflect.set(handler, 'viewName', 'SettingsView');
  Reflect.set(handler, 'subscriptionUsage', usage);
  Reflect.set(handler, 'runtime', testRuntime());
  // Every `send*` the refresh tail composes is a program, so a double is one
  // too: a bare `vi.fn()` would be yielded as an `Effect` and fail.
  Reflect.set(
    handler,
    'sendProfileData',
    vi.fn(() => Effect.void),
  );
  Reflect.set(
    handler,
    'sendProfileAndModelSelectionData',
    vi.fn(() => Effect.void),
  );
  Reflect.set(
    handler,
    'sendModelSelectionData',
    vi.fn(() => Effect.void),
  );
  Reflect.set(
    handler,
    'withActiveWebview',
    (callback: (webview: vscode.Webview) => Effect.Effect<void, Error>) =>
      activeView
        ? callback({
            postMessage: async (message: unknown) => {
              posted.push(message);
              return true;
            },
          } as unknown as vscode.Webview)
        : Effect.void,
  );
  return { handler, posted, usage };
}

describe('extension subscription usage credential lifecycle', () => {
  it('invalidates only coding-plan providers and replaces visible usage after key changes', async () => {
    const { handler, posted, usage } = createHarness();

    await testRuntime().runPromise(
      handler.refreshAfterProviderKeyChange('glm'),
    );

    expect(usage.invalidate).toHaveBeenCalledExactlyOnceWith('glmCodingPlan');
    expect(usage.getAllUsage).toHaveBeenCalledOnce();
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      }),
    );

    usage.invalidate.mockClear();
    usage.getAllUsage.mockClear();
    await testRuntime().runPromise(
      handler.refreshAfterProviderKeyChange('openai'),
    );
    expect(usage.invalidate).not.toHaveBeenCalled();
    expect(usage.getAllUsage).not.toHaveBeenCalled();
  });

  it('invalidates coding-plan usage when no Settings view is active', async () => {
    const { handler, posted, usage } = createHarness(false);

    await testRuntime().runPromise(
      handler.refreshAfterProviderKeyChange('kimiCode'),
    );
    await testRuntime().runPromise(
      handler.refreshAfterProviderKeyChange('glm'),
    );

    expect(usage.invalidate.mock.calls).toStrictEqual([
      ['kimiCode'],
      ['glmCodingPlan'],
    ]);
    expect(usage.getAllUsage).not.toHaveBeenCalled();
    expect(posted).toStrictEqual([]);
  });

  it('invalidates ChatGPT usage after account auth changes', async () => {
    const { handler, posted, usage } = createHarness();

    await testRuntime().runPromise(
      handler.refreshAfterSubscriptionAuthChange('chatgpt'),
    );

    expect(usage.invalidate).toHaveBeenCalledExactlyOnceWith('chatgpt');
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      }),
    );
  });
});
