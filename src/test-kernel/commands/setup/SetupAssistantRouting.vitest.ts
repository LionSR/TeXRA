// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verify that the setup assistant surfaces the OpenRouter-without-key
 * routing mismatch BEFORE the credential prompt, so a ChatGPT-subscription
 * user who has "Use OpenRouter" enabled (and no OR key) sees the routing
 * warning instead of a confusing "no credential" picker.
 */

const agentHandles = vi.fn<() => { agentName: string }[]>();

// Single source of truth for the mocked provider list — both the
// `SecretManager` mock and the `hasUsableSetupCredential` stand-in below
// scan this same list, so they can't drift from each other. Declared via
// `vi.hoisted` (not a plain `const`) because `vi.mock` factories run before
// ordinary module-scope bindings are initialized.
const MOCK_API_PROVIDERS = vi.hoisted(() => [
  'openRouter',
  'openai',
  'anthropic',
  'google',
  'kimiCode',
]);

const mocks = vi.hoisted(() => ({
  getUseOpenRouter: vi.fn<() => boolean>(),
  hasUsableApiKey: vi.fn<(provider: string) => Promise<boolean>>(),
  showWarningMessage: vi.fn<() => Promise<string | undefined>>(),
  showQuickPick: vi.fn<() => Promise<unknown>>(),
  showInformationMessage: vi.fn<() => Promise<unknown>>(),
  showErrorMessage: vi.fn<() => Promise<unknown>>(),
  executeCommand: vi.fn<() => Promise<unknown>>(),
  selectSetupCredentialModelExcludingOpenRouter:
    vi.fn<(useOpenRouter?: boolean) => Promise<string | null>>(),
  logError: vi.fn(),
}));

/**
 * Mirrors `resolveSetupLaunchModel`'s real router-config / credential /
 * access-list-fallback precedence using the same mocked primitives this
 * suite already drives (`getUseOpenRouter`, `hasUsableApiKey`,
 * `selectSetupCredentialModelExcludingOpenRouter`) — the real function lives
 * in the mocked `@controllers/onboarding/setupLaunch` module, so this suite
 * (which is about `launchSetupAssistant`'s routing/credential ordering, not
 * model-precedence itself) needs a faithful stand-in to keep exercising that
 * ordering past the model-selection step.
 */
const OPENROUTER_MODEL = 'openrouter/mock-model';

async function resolveSetupModelMock(
  includeAccessListFallback: boolean,
): Promise<{ model: string; reason: string } | null> {
  const useOpenRouter = mocks.getUseOpenRouter();
  const openRouterModel = (await mocks.hasUsableApiKey('openRouter'))
    ? OPENROUTER_MODEL
    : null;

  if (useOpenRouter) {
    if (openRouterModel) {
      return { model: openRouterModel, reason: 'router-config' };
    }
    const directModel =
      await mocks.selectSetupCredentialModelExcludingOpenRouter(true);
    return directModel ? { model: directModel, reason: 'credential' } : null;
  }

  const credentialModel =
    await mocks.selectSetupCredentialModelExcludingOpenRouter();
  if (credentialModel) {
    return { model: credentialModel, reason: 'credential' };
  }
  if (includeAccessListFallback && openRouterModel) {
    return { model: openRouterModel, reason: 'access-list-default' };
  }
  return null;
}

vi.mock('@utils/config/providerConfig', () => ({
  getUseOpenRouter: mocks.getUseOpenRouter,
}));

vi.mock('@frontend/secretManager', () => ({
  SecretManager: {
    hasUsableApiKey: mocks.hasUsableApiKey,
    API_PROVIDERS: MOCK_API_PROVIDERS,
    getApiKeySecretName: (provider: string) => `apiKey.${provider}`,
  },
}));

// The guard's sole touchpoint is `defaultSession().executions.getAgentHandles()`
// — a full stub replacement (not `importOriginal`) keeps this suite's
// isolation: the real module eagerly constructs a `createChannelTrace`
// logger at import time (`ToolUseFollowUpQueueManager.ts`), which needs more
// of `@logger/logUtils` than this suite's minimal mock provides. No other
// module in this test's import graph (all deps otherwise mocked away, and
// `apiKeyCommands`/`codexSubscriptionSignIn` don't import SessionHandle)
// touches this module's other exports.
vi.mock('@agent/runtime/SessionHandle', () => ({
  defaultSession: () => ({
    executions: { getAgentHandles: () => agentHandles() },
  }),
}));

vi.mock('@controllers/onboarding/setupLaunch', () => ({
  SETUP_INSTRUCTION:
    'Please help me finish installing TeXRA. Probe my environment, install anything missing, and get me a working credential.',
  selectSetupCredentialModelExcludingOpenRouter:
    mocks.selectSetupCredentialModelExcludingOpenRouter,
  resolveSetupLaunchModel: (
    _secrets: unknown,
    includeAccessListFallback: boolean,
  ) => resolveSetupModelMock(includeAccessListFallback),
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    canUseServerSideKeys: () => Promise.resolve(false),
    canUseServerSideKeysForModel: () => Promise.resolve(false),
    canUseModelSync: () => false,
  }),
}));

// `hasAnyUsableSetupCredential` now delegates to the shared host-neutral
// predicate; stand it in with the same provider-key mock this suite already
// drives, so the credential check keeps tracking `mocks.hasUsableApiKey`
// instead of hitting the (unstubbed) fake platform secrets store.
vi.mock('@model/setupCredentialAccess', () => ({
  hasUsableSetupCredential: async () => {
    for (const provider of MOCK_API_PROVIDERS) {
      if (await mocks.hasUsableApiKey(provider)) return true;
    }
    return false;
  },
}));

vi.mock('@common/state', () => ({
  GlobalStateKey: {
    USE_OPENROUTER: 'useOpenRouter',
  },
  globalSM: {
    get: () => undefined,
    update: () => Promise.resolve(),
  },
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p, path: p }),
    parse: (s: string) => ({ fsPath: s, toString: () => s, path: s }),
  },
  EventEmitter: class {
    event = () => ({ dispose: () => {} });
    fire() {}
    dispose() {}
  },
  Disposable: {
    from: (..._: unknown[]) => ({ dispose: () => {} }),
  },
  window: {
    showWarningMessage: mocks.showWarningMessage,
    showQuickPick: mocks.showQuickPick,
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
  commands: {
    executeCommand: mocks.executeCommand,
  },
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  ProgressLocation: { Notification: 15, Window: 10 },
  ThemeColor: class {},
  StatusBarAlignment: { Left: 1, Right: 2 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
}));

vi.mock('@agent/index', () => ({
  loadAgents: () => Promise.resolve(),
}));

vi.mock('@agent/runtime/runAgent', () => ({
  runAgent: () => Promise.resolve(),
}));

vi.mock('@logger/logUtils', () => ({
  createChannelWriter: () => () => {},
  createLog: () => ({ warn: () => {} }),
  initialize: () => {},
  error: mocks.logError,
  warn: () => {},
  info: () => {},
}));

// Force materialization of hoisted mocks into vitest's module graph
// before the module under test imports them. Without this, dynamic
// imports inside setupAssistantCommand may resolve the real modules
// (or the alias-resolved stubs) before the mock factories execute.
await import('vscode');
await import('@utils/config/providerConfig');
await import('@frontend/secretManager');
await import('@agent/runtime/SessionHandle');
await import('@controllers/onboarding/setupLaunch');
await import('@auth/serverKeys');
await import('@model/setupCredentialAccess');
await import('@common/state');

// Module under test — imported after all mock factories are materialized.
const { launchSetupAssistant } =
  await import('@commands/setup/setupAssistantCommand');

describe('setup assistant routing check ordering', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no OpenRouter, no keys — safe baseline.
    agentHandles.mockReturnValue([]);
    mocks.getUseOpenRouter.mockReturnValue(false);
    mocks.hasUsableApiKey.mockResolvedValue(false);
    mocks.showWarningMessage.mockResolvedValue(undefined);
    mocks.showQuickPick.mockResolvedValue(undefined);
    mocks.showInformationMessage.mockResolvedValue(undefined);
    mocks.showErrorMessage.mockResolvedValue(undefined);
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.selectSetupCredentialModelExcludingOpenRouter.mockResolvedValue(null);
  });

  it('shows routing warning before credential prompt when OpenRouter is on without a key', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);

    const result = await launchSetupAssistant();

    expect(result).toBe('not-started');
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Use OpenRouter'),
      expect.objectContaining({ modal: true }),
      expect.any(String),
      expect.any(String),
    );
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
  });

  it('proceeds to credential check when routing is correctly configured', async () => {
    const result = await launchSetupAssistant();

    expect(result).toBe('not-started');
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'chatgpt' })]),
      expect.objectContaining({
        placeHolder: expect.stringContaining('reaches models'),
      }),
    );
  });

  it('passes routing check when OR is on with a key, then reaches credential check', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mocks.hasUsableApiKey.mockImplementation(
      async (provider: string) => provider === 'openRouter',
    );

    const result = await launchSetupAssistant();

    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    expect(result).toBe('launched');
  });

  it('passes routing check for a managed direct credential when OpenRouter has no key', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mocks.hasUsableApiKey.mockImplementation(
      async (provider: string) => provider === 'kimiCode',
    );
    mocks.selectSetupCredentialModelExcludingOpenRouter.mockResolvedValue(
      'kimiCodeCoding',
    );

    const result = await launchSetupAssistant();

    expect(result).toBe('launched');
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
  });

  it('does not scan non-OpenRouter credentials when OpenRouter routing is already on', async () => {
    mocks.getUseOpenRouter.mockReturnValue(true);
    mocks.hasUsableApiKey.mockImplementation(
      async (provider: string) => provider === 'openRouter',
    );
    mocks.selectSetupCredentialModelExcludingOpenRouter.mockRejectedValue(
      new Error('credential scan unavailable'),
    );

    const result = await launchSetupAssistant();

    expect(result).toBe('launched');
    expect(
      mocks.selectSetupCredentialModelExcludingOpenRouter,
    ).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
  });
});
