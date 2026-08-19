import { describe, expect, it, vi } from 'vitest';

import { EXTENSION_COMMAND_HANDLERS } from '@commands/extensionCommandHandlers';
import { createExtensionCommandActions } from '@commands/extensionCommandSurface';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';
import type * as vscode from 'vscode';

describe('extension command action wiring', () => {
  it.each([
    ['texra.auth.chatgpt.signIn', 'chatgpt'],
    ['texra.auth.grok.signIn', 'grok'],
  ] as const)(
    'routes %s through the Settings provider authority',
    async (commandId, providerId) => {
      const signInSubscription = vi.fn(async () => {});
      const settingsViewProvider = {
        signInSubscription,
        refreshAfterProviderKeyChange: vi.fn(),
        showSettingsView: vi.fn(),
      } as unknown as SettingsViewProvider;

      const actions = createExtensionCommandActions(
        {} as vscode.ExtensionContext,
        settingsViewProvider,
      );
      const result = dispatchCommandFromRegistry(
        commandId,
        EXTENSION_COMMAND_HANDLERS,
        actions,
        undefined,
      );

      await expect(result).resolves.toBe(true);
      expect(signInSubscription).toHaveBeenCalledExactlyOnceWith(providerId);
    },
  );
});
