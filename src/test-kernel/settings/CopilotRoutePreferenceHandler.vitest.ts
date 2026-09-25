// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  selectChatModels: vi.fn(),
  canSendRequest: vi.fn(),
  sendRequest: vi.fn(),
  safeExecuteCommand: vi.fn(() => Effect.succeed(undefined)),
  refreshCatalogs: vi.fn(() => Effect.void),
  // The real writer hands back a program, not a promise.
  setCopilotRoutePreference: vi.fn(() => Effect.void),
  showLoggedErrorMessage: vi.fn<
    (channel: string, message: string, error: unknown) => Effect.Effect<string>
  >(() => Effect.succeed('')),
  showLoggedInfoMessage: vi.fn(() => Effect.succeed('')),
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
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';
import { withProcessServices } from '@platform/processRuntime';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createDeferred } from '@test/support/asyncTestUtils';
import { installedHost, installPlatform } from '@test/support/setupPlatform';

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
    selectModels: vi.fn(() => Effect.succeed(models)),
    onDidChange: () => ({ dispose() {} }),
  };
}

async function installModels(...models: readonly LanguageModelInfo[]) {
  const port = languageModelPort(models);
  await installPlatform({}, { languageModel: port });
  return port;
}

type RefreshSurface = {
  sendModelSelectionData(webview: vscode.Webview): Effect.Effect<void>;
};

const subscriptions: vscode.Disposable[] = [];

function createHandler(): SettingsViewMessageHandler {
  const { secrets, roots } = installedHost();
  const { globalState } = roots;
  const handler = new SettingsViewMessageHandler(
    {
      subscriptions,
      extensionPath: '/ext',
      globalState,
      languageModelAccessInformation: { canSendRequest: mocks.canSendRequest },
    } as unknown as vscode.ExtensionContext,
    globalState,
    secrets,
    testRuntime(),
    testDefaultSession(),
    {
      refreshCatalogs: mocks.refreshCatalogs,
      refreshApiKeyStatus: Effect.void,
      refreshOnboardingFunnel: () => Effect.void,
    },
  );
  vi.spyOn(
    handler as unknown as RefreshSurface,
    'sendModelSelectionData',
  ).mockReturnValue(Effect.void);
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
  ).mockImplementation(() =>
    Effect.sync(() => {
      refreshed.resolve();
    }),
  );
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
  });

  it.each(['allowed', 'consent-required'] as const)(
    'revalidates and persists an opt-in whose current access is %s',
    async (access) => {
      await installModels({ ...GEMINI_PRO, access });
      await requestModelAccess();
      expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
        'gemini31p',
        true,
        installedHost().roots.globalState,
      );
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
      expect(mocks.refreshCatalogs).toHaveBeenCalled();
    },
  );

  it.effect.each([
    { access: 'consent-required' as const, sends: true },
    { access: 'unavailable' as const, sends: false },
  ])(
    'acts on the access discovered for the request ($access)',
    ({ access, sends }) =>
      Effect.gen(function* () {
        const port = {
          ...languageModelPort([]),
          selectModels: vi.fn(() =>
            Effect.succeed([{ ...GEMINI_PRO, access }]),
          ),
        };
        yield* Effect.promise(() =>
          installPlatform({}, { languageModel: port }),
        );
        yield* Effect.promise(() => requestModelAccess());
        expect(port.selectModels).toHaveBeenCalledTimes(1);
        expect(mocks.sendRequest).toHaveBeenCalledTimes(sends ? 1 : 0);
        expect(mocks.setCopilotRoutePreference).toHaveBeenCalledTimes(
          sends ? 1 : 0,
        );
        if (!sends)
          expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
            'SettingsViewMessageHandler',
            'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
          );
      }),
  );

  it.effect('does not authorize after a failed discovery', () =>
    Effect.gen(function* () {
      const port = {
        ...languageModelPort([]),
        selectModels: vi.fn(() =>
          Effect.fail(new Error('fresh discovery failed')),
        ),
      };
      yield* Effect.promise(() => installPlatform({}, { languageModel: port }));
      yield* Effect.promise(() => requestModelAccess());
      expect(mocks.showLoggedErrorMessage).toHaveBeenCalled();
      expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
    }),
  );

  it.each([
    'denied',
    'denied-with-cleanup-failure',
    'deadline',
    'deadline-with-cleanup-failure',
  ] as const)(
    'observes complete native consumption and release for %s',
    async (scenario) => {
      await installModels({ ...GEMINI_PRO, access: 'consent-required' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
      expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
      if (scenario.startsWith('deadline')) {
        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() =>
          expect(token?.isCancellationRequested).toBe(true),
        );
        expect(settled).toBe(false);
        pending.reject(new vscode.CancellationError());
      } else {
        pending.reject(denial);
      }
      await request;
      vi.useRealTimers();
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
          expect(reported.message).toContain(
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
      expect(mocks.refreshCatalogs).toHaveBeenCalled();
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
      installedHost().roots.globalState,
    );
    expect(port.selectModels).not.toHaveBeenCalled();
    expect(mocks.selectChatModels).not.toHaveBeenCalled();
  });
});
