// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invalidateModelOptionsCache: vi.fn(),
  invalidateRuntimeModelRegistry: vi.fn(),
  requestRuntimeModelAccess: vi.fn(),
  safeExecuteCommand: vi.fn(async () => undefined),
  sendModelSelectionData: vi.fn(async () => undefined),
  setCopilotRoutePreference: vi.fn(async () => undefined),
  showLoggedErrorMessage: vi.fn(async () => undefined),
  showLoggedInfoMessage: vi.fn(async () => undefined),
}));

vi.mock('@model/runtimeModelRegistry', async (original) => {
  const actual = await original<typeof import('@model/runtimeModelRegistry')>();
  return {
    ...actual,
    invalidateRuntimeModelRegistry: mocks.invalidateRuntimeModelRegistry,
    requestRuntimeModelAccess: mocks.requestRuntimeModelAccess,
  };
});

vi.mock('@model/copilotRouting', async (original) => {
  const actual = await original<typeof import('@model/copilotRouting')>();
  return {
    ...actual,
    setCopilotRoutePreference: mocks.setCopilotRoutePreference,
  };
});

vi.mock('@model/computeModelOptions', async (original) => {
  const actual = await original<typeof import('@model/computeModelOptions')>();
  return {
    ...actual,
    invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
  };
});

vi.mock('@frontend/system/commandUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/system/commandUtils')>();
  return { ...actual, safeExecuteCommand: mocks.safeExecuteCommand };
});

vi.mock('@frontend/ui/errorHandlingUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/ui/errorHandlingUtils')>();
  return {
    ...actual,
    showLoggedErrorMessage: mocks.showLoggedErrorMessage,
    showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  };
});

// Local imports
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';

type CopilotPreferenceHarness = {
  handleRequestModelAccess(modelName: string): Promise<void>;
  handleClearCopilotRoute(modelName: string): Promise<void>;
};

function createHarness(): CopilotPreferenceHarness {
  const handler = Object.create(SettingsViewMessageHandler.prototype);
  Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
  Reflect.set(handler, 'viewName', 'SettingsView');
  Reflect.set(handler, 'sendModelSelectionData', mocks.sendModelSelectionData);
  Reflect.set(
    handler,
    'withActiveWebview',
    vi.fn(async (fn: (webview: object) => Promise<void>) => fn({})),
  );
  return handler as CopilotPreferenceHarness;
}

describe('Copilot route preference handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revalidates and persists an allowed opt-in', async () => {
    mocks.requestRuntimeModelAccess.mockResolvedValueOnce('already-allowed');
    const handler = createHarness();

    await handler.handleRequestModelAccess('sonnet46');

    expect(mocks.requestRuntimeModelAccess).toHaveBeenCalledWith('sonnet46');
    expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
      'sonnet46',
      true,
    );
    expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
  });

  it('uses the current consent flow before persisting a stale allowed opt-in', async () => {
    mocks.requestRuntimeModelAccess.mockResolvedValueOnce('requested');
    const handler = createHarness();

    await handler.handleRequestModelAccess('sonnet46');

    expect(mocks.requestRuntimeModelAccess).toHaveBeenCalledWith('sonnet46');
    expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
      'sonnet46',
      true,
    );
  });

  it('rejects an opt-in that has become unavailable with actionable feedback', async () => {
    mocks.requestRuntimeModelAccess.mockResolvedValueOnce('unavailable');
    const handler = createHarness();

    await handler.handleRequestModelAccess('sonnet46');

    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
    expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
      'SettingsViewMessageHandler',
      'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
    );
  });

  it('allows opt-out without consulting current Copilot access', async () => {
    const handler = createHarness();

    await handler.handleClearCopilotRoute('sonnet46');

    expect(mocks.requestRuntimeModelAccess).not.toHaveBeenCalled();
    expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
      'sonnet46',
      false,
    );
  });
});
