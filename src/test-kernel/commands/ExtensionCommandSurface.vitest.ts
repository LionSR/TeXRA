import { describe, expect, it, vi } from 'vitest';

import { EXTENSION_COMMAND_HANDLERS } from '@commands/extensionCommandHandlers';
import { createExtensionCommandActions } from '@commands/extensionCommandSurface';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';
import type * as vscode from 'vscode';

describe('extension command action wiring', () => {
  it('routes the ChatGPT sign-in command through the Settings provider authority', async () => {
    const signInChatGpt = vi.fn(async () => {});
    const settingsViewProvider = {
      signInChatGpt,
      refreshAfterProviderKeyChange: vi.fn(),
      showSettingsView: vi.fn(),
    } as unknown as SettingsViewProvider;

    const actions = createExtensionCommandActions(
      {} as vscode.ExtensionContext,
      settingsViewProvider,
    );
    const result = dispatchCommandFromRegistry(
      'texra.auth.chatgpt.signIn',
      EXTENSION_COMMAND_HANDLERS,
      actions,
      undefined,
    );

    await expect(result).resolves.toBe(true);
    expect(signInChatGpt).toHaveBeenCalledOnce();
  });
});
