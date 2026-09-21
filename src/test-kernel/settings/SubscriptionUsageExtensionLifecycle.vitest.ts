import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Composed by the refresh tail, so the double answers with an Effect.
  safeExecuteCommand: vi.fn(() => Effect.succeed(undefined)),
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
  // A bare `vi.fn()` would be yielded as an `Effect` and fail at runtime.
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
  it.effect(
    'invalidates only coding-plan providers and replaces visible usage after key changes',
    () =>
      Effect.gen(function* () {
        const { handler, posted, usage } = createHarness();

        yield* handler.refreshAfterProviderKeyChange('glm');

        expect(usage.invalidate).toHaveBeenCalledExactlyOnceWith(
          'glmCodingPlan',
        );
        expect(usage.getAllUsage).toHaveBeenCalledOnce();
        expect(posted).toContainEqual(
          expect.objectContaining({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
          }),
        );

        usage.invalidate.mockClear();
        usage.getAllUsage.mockClear();
        yield* handler.refreshAfterProviderKeyChange('openai');
        expect(usage.invalidate).not.toHaveBeenCalled();
        expect(usage.getAllUsage).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'invalidates coding-plan usage when no Settings view is active',
    () =>
      Effect.gen(function* () {
        const { handler, posted, usage } = createHarness(false);

        yield* handler.refreshAfterProviderKeyChange('kimiCode');
        yield* handler.refreshAfterProviderKeyChange('glm');

        expect(usage.invalidate.mock.calls).toStrictEqual([
          ['kimiCode'],
          ['glmCodingPlan'],
        ]);
        expect(usage.getAllUsage).not.toHaveBeenCalled();
        expect(posted).toStrictEqual([]);
      }),
  );

  it.effect('invalidates ChatGPT usage after account auth changes', () =>
    Effect.gen(function* () {
      const { handler, posted, usage } = createHarness();

      yield* handler.refreshAfterSubscriptionAuthChange('chatgpt');

      expect(usage.invalidate).toHaveBeenCalledExactlyOnceWith('chatgpt');
      expect(posted).toContainEqual(
        expect.objectContaining({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
        }),
      );
    }),
  );
});
