// Test composition imports
import '@test/support/defaultSessionTestSetup';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  apiMode: 'included' as 'included' | 'personal',
  setCliApiMode: vi.fn(),
}));

vi.mock('@cli/runtime/apiAccessMode', async (importActual) => {
  const actual =
    await importActual<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    getCliApiMode: () => mocks.apiMode,
    setCliApiMode: mocks.setCliApiMode,
  };
});

import { clearApprovals } from '@cli/chat/tui/state/approvalQueue';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  apiKeySecretName,
  invalidateApiKeyCache,
  lookupApiKey,
} from '@model/apiProviders';
import { platform } from '@platform/platform';
import type { RetryPermission } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { installPlatform } from '@test/support/setupPlatform';

function interactions(): ReturnType<typeof createTuiHostInteractions> {
  const tui = createTuiHostInteractions(
    {
      emit: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as CliRuntimeHost,
    createTestCliContext({
      cwd: '/work',
      mode: 'interactive',
      approvalPolicy: 'ask',
      version: 'test',
      resourcesPath: '/resources',
    }),
  );
  onTestFinished(() => tui.dispose?.());
  return tui;
}

function relayLimitRetry(requestId: string, streamId: string): RetryPermission {
  return {
    requestId,
    streamId,
    operation: 'model request',
    errorMessage: 'Relay monthly limit reached.',
    errorDetails: {
      message: 'Relay monthly limit reached.',
      exhaustionReason: 'relay-limit',
      isRelayError: true,
      provider: 'openai',
    },
  };
}

describe('TUI retry API-key cache boundary', () => {
  beforeEach(async () => {
    mocks.apiMode = 'included';
    mocks.setCliApiMode.mockImplementation(async (mode) => {
      mocks.apiMode = mode;
    });
    await installPlatform({
      secrets: { [apiKeySecretName('openai')]: 'sk-old-current-key' },
    });
    invalidateApiKeyCache();
  });

  afterEach(() => {
    clearApprovals();
    invalidateApiKeyCache();
    mocks.setCliApiMode.mockReset();
  });

  it('constructs the retry from a rotated key rather than the cached key', async () => {
    await expect(lookupApiKey(platform().secrets, 'openai')).resolves.toBe(
      'sk-old-current-key',
    );
    await platform().secrets.set(
      apiKeySecretName('openai'),
      'sk-rotated-current-key',
    );
    await expect(lookupApiKey(platform().secrets, 'openai')).resolves.toBe(
      'sk-old-current-key',
    );

    const preparedKeys: Array<string | undefined> = [];
    const tui = interactions();
    const result = tui.requestRetry?.(
      relayLimitRetry('retry-rotated-key', 'rotated-key'),
      {
        prepareRetry: async (selection) => {
          expect(selection).toBe('personal');
          preparedKeys.push(await lookupApiKey(platform().secrets, 'openai'));
        },
      },
    );

    await expect(result).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(preparedKeys).toEqual(['sk-rotated-current-key']);
    expect(mocks.apiMode).toBe('personal');
  });

  it('rejects a deleted key even when presentation cached it as present', async () => {
    await expect(lookupApiKey(platform().secrets, 'openai')).resolves.toBe(
      'sk-old-current-key',
    );
    await platform().secrets.delete(apiKeySecretName('openai'));

    const prepareRetry = vi.fn(async () => undefined);
    const tui = interactions();
    const result = tui.requestRetry?.(
      relayLimitRetry('retry-deleted-key', 'deleted-key'),
      { prepareRetry },
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason:
        'No OpenAI API key is configured. Press n to dismiss, then use `/key` to add one.',
    });
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(prepareRetry).not.toHaveBeenCalled();
  });
});
