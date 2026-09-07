// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Cause } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  selectChatModels: vi.fn(),
  canSendRequest: vi.fn(),
  sendRequest: vi.fn(),
  safeExecuteCommand: vi.fn(async () => undefined),
  setCopilotRoutePreference: vi.fn(async () => undefined),
  showLoggedErrorMessage: vi.fn<
    (channel: string, message: string, error: unknown) => Promise<void>
  >(async () => undefined),
  showLoggedInfoMessage: vi.fn(async () => undefined),
}));

vi.mock('@model/copilotRouting', async (original) => ({
  ...(await original<typeof import('@model/copilotRouting')>()),
  setCopilotRoutePreference: mocks.setCopilotRoutePreference,
}));

vi.mock('@frontend/system/commandUtils', async (original) => ({
  ...(await original<typeof import('@frontend/system/commandUtils')>()),
  safeExecuteCommand: mocks.safeExecuteCommand,
}));

vi.mock('@frontend/ui/errorHandlingUtils', async (original) => ({
  ...(await original<typeof import('@frontend/ui/errorHandlingUtils')>()),
  showLoggedErrorMessage: mocks.showLoggedErrorMessage,
  showLoggedInfoMessage: mocks.showLoggedInfoMessage,
}));

vi.mock('vscode', async (original) => {
  const actual = await original<typeof import('vscode')>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    lm: { selectChatModels: mocks.selectChatModels },
    LanguageModelTextPart: class {
      constructor(public value: string) {}
    },
    LanguageModelChatMessage: {
      User: (content: unknown[]) => ({ role: 'user', content }),
      Assistant: (content: unknown[]) => ({ role: 'assistant', content }),
    },
    CancellationError: class extends Error {},
    CancellationTokenSource: class {
      private readonly listeners = new Set<() => void>();
      readonly token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        },
      };
      cancel() {
        this.token.isCancellationRequested = true;
        for (const listener of this.listeners) listener();
      }
      dispose() {
        this.listeners.clear();
      }
    },
  };
});

// Local imports
import {
  copilotRouteForModel,
  discoveredCopilotRoutes,
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
} from '@model/runtimeModelRegistry';
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { createDeferred } from '@test/support/asyncTestUtils';
import { installPlatform } from '@test/support/setupPlatform';

const GEMINI_PRO: LanguageModelInfo = {
  id: 'gemini-3.1-pro-preview',
  name: 'Gemini 3.1 Pro',
  family: 'gemini-3.1-pro-preview',
  vendor: 'copilot',
  version: '2026-07',
  maxInputTokens: 160_000,
  access: 'allowed',
};

function languageModelPort(
  models: readonly LanguageModelInfo[],
): LanguageModelPort {
  return {
    isAvailable: () => true,
    selectModels: vi.fn(async () => models),
    onDidChange: () => ({ dispose() {} }),
    sendRequest: vi.fn(() => {
      throw new Error('Grant must not use the retired request grammar.');
    }),
    countTokens: async () => 0,
  };
}

async function installModels(...models: readonly LanguageModelInfo[]) {
  const port = languageModelPort(models);
  await installPlatform({}, { languageModel: port });
  return port;
}

type RefreshSurface = {
  sendModelSelectionData(webview: vscode.Webview): Promise<void>;
};

const subscriptions: vscode.Disposable[] = [];

function createHandler(): SettingsViewMessageHandler {
  const handler = new SettingsViewMessageHandler({
    subscriptions,
    extensionPath: '/ext',
    languageModelAccessInformation: { canSendRequest: mocks.canSendRequest },
  } as unknown as vscode.ExtensionContext);
  vi.spyOn(
    handler as unknown as RefreshSurface,
    'sendModelSelectionData',
  ).mockResolvedValue(undefined);
  return handler;
}

function createWebviewView(): vscode.WebviewView {
  return {
    visible: false,
    onDidChangeVisibility: () => ({ dispose() {} }),
    webview: { postMessage: vi.fn(async () => true) },
  } as unknown as vscode.WebviewView;
}

async function requestModelAccess(handler = createHandler()): Promise<void> {
  const refreshed = createDeferred<void>();
  vi.spyOn(
    handler as unknown as RefreshSurface,
    'sendModelSelectionData',
  ).mockImplementation(async () => {
    refreshed.resolve();
  });
  await handler.handleMessage(
    {
      command: SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS,
      modelName: 'gemini31p',
    },
    createWebviewView(),
  );
  // The inbound dispatcher starts the handler asynchronously. Observe its
  // existing final refresh, not merely acknowledgement of the inbound message.
  await refreshed.promise;
}

describe('Copilot route preference handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRuntimeModelRegistry();
    mocks.canSendRequest.mockReturnValue(undefined);
    mocks.selectChatModels.mockResolvedValue([
      { ...GEMINI_PRO, sendRequest: mocks.sendRequest },
    ]);
    mocks.sendRequest.mockImplementation(async () => ({
      stream: (async function* () {
        yield new vscode.LanguageModelTextPart('OK');
      })(),
    }));
  });

  afterEach(() => {
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    vi.restoreAllMocks();
    invalidateRuntimeModelRegistry();
  });

  it.each(['allowed', 'consent-required'] as const)(
    'revalidates and persists an opt-in whose current access is %s',
    async (access) => {
      const port = await installModels({ ...GEMINI_PRO, access });
      await requestModelAccess();
      expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
        'gemini31p',
        true,
      );
      expect(port.sendRequest).not.toHaveBeenCalled();
      expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
      if (access === 'allowed') {
        expect(mocks.selectChatModels).not.toHaveBeenCalled();
        expect(mocks.sendRequest).not.toHaveBeenCalled();
      } else {
        expect(mocks.selectChatModels).toHaveBeenCalledWith({
          vendor: GEMINI_PRO.vendor,
          id: GEMINI_PRO.id,
          version: GEMINI_PRO.version,
        });
        expect(mocks.sendRequest).toHaveBeenCalledWith(
          [
            {
              role: 'user',
              content: [
                new vscode.LanguageModelTextPart(
                  'Reply with OK to confirm language-model access for TeXRA.',
                ),
              ],
            },
          ],
          { justification: 'Use Copilot models in TeXRA.' },
          expect.anything(),
        );
      }
      expect(mocks.safeExecuteCommand).toHaveBeenCalledWith(
        'texra.refreshAllOptions',
        [],
        'SettingsView',
      );
    },
  );

  it.each([
    { access: 'consent-required' as const, sends: true },
    { access: 'unavailable' as const, sends: false },
  ])(
    're-discovers stale allowed access before acting on $access',
    async ({ access, sends }) => {
      let models: readonly LanguageModelInfo[] = [GEMINI_PRO];
      const port = {
        ...languageModelPort([]),
        selectModels: vi.fn(async () => models),
      };
      await installPlatform({}, { languageModel: port });
      await refreshRuntimeModelRegistry();
      expect(copilotRouteForModel('gemini31p')?.access).toBe('allowed');
      models = [{ ...GEMINI_PRO, access }];
      await requestModelAccess();
      expect(port.selectModels).toHaveBeenCalledTimes(2);
      expect(mocks.sendRequest).toHaveBeenCalledTimes(sends ? 1 : 0);
      expect(mocks.setCopilotRoutePreference).toHaveBeenCalledTimes(
        sends ? 1 : 0,
      );
      if (!sends)
        expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
          'SettingsViewMessageHandler',
          'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
        );
    },
  );

  it('retries when invalidation supersedes a forced allowed probe', async () => {
    const port = await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();
    const forced = createDeferred<readonly LanguageModelInfo[]>();
    vi.mocked(port.selectModels)
      .mockReturnValueOnce(forced.promise)
      .mockResolvedValueOnce([{ ...GEMINI_PRO, access: 'unavailable' }]);
    const request = requestModelAccess();
    await vi.waitFor(() => expect(port.selectModels).toHaveBeenCalledTimes(2));
    invalidateRuntimeModelRegistry();
    forced.resolve([GEMINI_PRO]);
    await request;
    expect(port.selectModels).toHaveBeenCalledTimes(3);
    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it('fails closed after two superseded forced probes', async () => {
    const port = await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();
    const forced = createDeferred<readonly LanguageModelInfo[]>();
    const retry = createDeferred<readonly LanguageModelInfo[]>();
    vi.mocked(port.selectModels)
      .mockReturnValueOnce(forced.promise)
      .mockReturnValueOnce(retry.promise);
    const request = requestModelAccess();
    await vi.waitFor(() => expect(port.selectModels).toHaveBeenCalledTimes(2));
    invalidateRuntimeModelRegistry();
    forced.resolve([GEMINI_PRO]);
    await vi.waitFor(() => expect(port.selectModels).toHaveBeenCalledTimes(3));
    invalidateRuntimeModelRegistry();
    retry.resolve([GEMINI_PRO]);
    await request;
    expect(port.selectModels).toHaveBeenCalledTimes(3);
    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it('does not let superseded ordinary discovery authorize a forced opt-in', async () => {
    const ordinary = createDeferred<readonly LanguageModelInfo[]>();
    const forced = createDeferred<readonly LanguageModelInfo[]>();
    const port = {
      ...languageModelPort([]),
      selectModels: vi
        .fn<() => Promise<readonly LanguageModelInfo[]>>()
        .mockReturnValueOnce(ordinary.promise)
        .mockReturnValueOnce(forced.promise),
    };
    await installPlatform({}, { languageModel: port });
    const stale = refreshRuntimeModelRegistry();
    const request = requestModelAccess();
    await vi.waitFor(() => expect(port.selectModels).toHaveBeenCalledTimes(2));
    forced.resolve([{ ...GEMINI_PRO, access: 'unavailable' }]);
    await request;
    ordinary.resolve([GEMINI_PRO]);
    await stale;
    expect(copilotRouteForModel('gemini31p')?.access).toBe('unavailable');
    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
    expect(mocks.sendRequest).not.toHaveBeenCalled();
  });

  it('coalesces overlapping user-initiated fresh discoveries', async () => {
    const port = await installModels(GEMINI_PRO);
    await refreshRuntimeModelRegistry();
    const discovery = createDeferred<readonly LanguageModelInfo[]>();
    vi.mocked(port.selectModels).mockReturnValueOnce(discovery.promise);
    const first = requestModelAccess();
    const second = requestModelAccess();
    await vi.waitFor(() => expect(port.selectModels).toHaveBeenCalledTimes(2));
    discovery.resolve([{ ...GEMINI_PRO, access: 'unavailable' }]);
    await Promise.all([first, second]);
    expect(port.selectModels).toHaveBeenCalledTimes(2);
    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
  });

  it('retains presentation but does not authorize after failed fresh discovery', async () => {
    const failure = new Error('fresh discovery failed');
    let fail = false;
    const port = {
      ...languageModelPort([]),
      selectModels: vi.fn(async () => {
        if (fail) throw failure;
        return [GEMINI_PRO];
      }),
    };
    await installPlatform({}, { languageModel: port });
    await refreshRuntimeModelRegistry();
    fail = true;
    await requestModelAccess();
    expect(mocks.showLoggedErrorMessage).toHaveBeenCalled();
    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
    expect((await discoveredCopilotRoutes()).get('gemini31p')?.access).toBe(
      'allowed',
    );
    expect(port.selectModels).toHaveBeenCalledTimes(3);
  });

  it.each([
    'denied',
    'denied-with-cleanup-failure',
    'deadline',
    'deadline-with-cleanup-failure',
  ] as const)(
    'observes complete native consumption and release for %s',
    async (scenario) => {
      await installModels({ ...GEMINI_PRO, access: 'consent-required' });
      const controller = new AbortController();
      const deadline = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(controller.signal);
      const pending =
        createDeferred<IteratorResult<vscode.LanguageModelTextPart>>();
      const started = createDeferred<void>();
      const denial = Object.assign(new Error('permission denied'), {
        code: 'NoPermissions',
      });
      const cleanup = new Error('distinct iterator cleanup');
      const close = vi.fn(async () => {
        if (scenario.endsWith('with-cleanup-failure')) throw cleanup;
        return { done: true as const, value: undefined };
      });
      let token: vscode.CancellationToken | undefined;
      mocks.sendRequest.mockImplementation(
        async (_messages, _options, requestToken) => {
          token = requestToken;
          return {
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () => {
                  started.resolve();
                  return pending.promise;
                },
                return: close,
              }),
            },
          };
        },
      );
      let settled = false;
      const request = requestModelAccess().then(() => {
        settled = true;
      });
      await started.promise;
      expect(deadline).toHaveBeenCalledWith(120_000);
      expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
      if (scenario.startsWith('deadline')) {
        controller.abort();
        await vi.waitFor(() =>
          expect(token?.isCancellationRequested).toBe(true),
        );
        expect(settled).toBe(false);
        pending.reject(new vscode.CancellationError());
      } else {
        pending.reject(denial);
      }
      await request;
      expect(close).toHaveBeenCalledOnce();
      expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
      if (scenario === 'denied') {
        expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
          'SettingsViewMessageHandler',
          'Copilot access was not granted. TeXRA will leave these models disabled.',
        );
        expect(mocks.showLoggedErrorMessage).not.toHaveBeenCalled();
      } else {
        expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
        const reported = mocks.showLoggedErrorMessage.mock.calls[0]?.[2];
        expect(reported).toBeInstanceOf(Error);
        if (!(reported instanceof Error) || !Cause.isCause(reported.cause)) {
          throw new Error('The host must retain the complete native cause.');
        }
        const cause = reported.cause;
        if (scenario === 'deadline') {
          expect(reported.message).toBe(
            'The Copilot access request was cancelled.',
          );
          expect(Cause.hasInterruptsOnly(cause)).toBe(true);
        } else {
          expect(
            cause.reasons.some((reason) => Cause.isDieReason(reason)),
          ).toBe(true);
          expect(Cause.pretty(cause)).toContain(cleanup.message);
        }
        if (scenario === 'denied-with-cleanup-failure') {
          expect(
            cause.reasons.some((reason) => Cause.isFailReason(reason)),
          ).toBe(true);
          expect(Cause.pretty(cause)).toContain(denial.message);
        } else {
          expect(
            cause.reasons.some((reason) => Cause.isInterruptReason(reason)),
          ).toBe(true);
        }
      }
      expect(mocks.safeExecuteCommand).toHaveBeenCalledWith(
        'texra.refreshAllOptions',
        [],
        'SettingsView',
      );
    },
  );

  it('allows opt-out without consulting current Copilot access', async () => {
    const port = await installModels(GEMINI_PRO);
    await createHandler().handleMessage(
      {
        command: SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE,
        modelName: 'gemini31p',
      },
      createWebviewView(),
    );
    expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
      'gemini31p',
      false,
    );
    expect(port.selectModels).not.toHaveBeenCalled();
    expect(mocks.selectChatModels).not.toHaveBeenCalled();
  });
});
