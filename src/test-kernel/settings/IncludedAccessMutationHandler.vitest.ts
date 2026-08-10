import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({ showLoggedInfoMessage: vi.fn() }));
vi.mock('@frontend/ui/errorHandlingUtils', async (original) => ({
  ...(await original<typeof import('@frontend/ui/errorHandlingUtils')>()),
  showLoggedInfoMessage: mocks.showLoggedInfoMessage,
}));

import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';

type Harness = {
  handleSetApiAccessMode(data: {
    command: 'setApiAccessMode';
    mode: 'included';
  }): Promise<void>;
  profileController: {
    setApiAccessMode: ReturnType<typeof vi.fn>;
  };
  sendProfileData: ReturnType<typeof vi.fn>;
  sendProfileAndModelSelectionData: ReturnType<typeof vi.fn>;
};

function createHarness(): Harness {
  const handler = Object.create(
    SettingsViewMessageHandler.prototype,
  ) as Harness;
  handler.profileController = {
    setApiAccessMode: vi.fn(),
  };
  handler.sendProfileData = vi.fn(async () => undefined);
  handler.sendProfileAndModelSelectionData = vi.fn(async () => undefined);
  Reflect.set(handler, 'channel', 'SettingsView');
  Reflect.set(
    handler,
    'withActiveWebview',
    async (callback: (webview: vscode.Webview) => Promise<void>) => {
      await callback({} as vscode.Webview);
    },
  );
  return handler;
}

describe('extension included-access mutation handling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not report success for exhaustion and resumes normal mutation after refresh', async () => {
    const handler = createHarness();
    const showSuccess = vi.spyOn(vscode.window, 'showInformationMessage');
    handler.profileController.setApiAccessMode.mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'quota_exhausted',
    });

    await handler.handleSetApiAccessMode({
      command: 'setApiAccessMode',
      mode: 'included',
    });

    expect(handler.sendProfileData).toHaveBeenCalledOnce();
    expect(handler.sendProfileAndModelSelectionData).not.toHaveBeenCalled();
    expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
      'SettingsView',
      'Included access is unavailable because this month’s quota is exhausted.',
    );
    expect(showSuccess).not.toHaveBeenCalled();

    handler.profileController.setApiAccessMode.mockResolvedValueOnce({
      kind: 'updated',
      mode: 'included',
      openRouterDisabled: false,
    });
    await handler.handleSetApiAccessMode({
      command: 'setApiAccessMode',
      mode: 'included',
    });

    expect(handler.sendProfileAndModelSelectionData).toHaveBeenCalledOnce();
    expect(showSuccess).toHaveBeenCalledWith('Now using included access.');
  });
});
