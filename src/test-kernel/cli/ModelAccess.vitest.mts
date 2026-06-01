import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCliModelAccessList,
  resolveCliRunnableModel,
  resolveCliRunnableModelFromAccessList,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelOptionData } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
}));

vi.mock('llm-zoo', () => ({
  MODEL_CONFIGS: {
    hiddenFixtureModel: {},
  },
}));

const computeModelOptionsDataMock = vi.mocked(computeModelOptionsData);

function model(
  value: string,
  overrides: Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: { value, label: value },
    available: true,
    status: 'available',
    ...overrides,
  };
}

describe('CLI model access resolution', () => {
  beforeEach(() => {
    computeModelOptionsDataMock.mockReset();
    mocks.authProvider.isAuthenticated.mockReset();
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
  });

  it('keeps the requested model when it is currently runnable', () => {
    expect(
      resolveCliRunnableModelFromAccessList(
        [model('sonnet46T'), model('opus48T')],
        'opus48T',
        { allowFallback: false },
      ),
    ).toEqual({ model: 'opus48T' });
  });

  it('rejects an explicit model that is unavailable in the active API mode', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [
          model('sonnet46T'),
          model('opus48T', { available: false, status: 'not included' }),
        ],
        'opus48T',
        { allowFallback: false },
      ),
    ).toThrow(
      'Model "opus48T" is not available in the active API mode (not included). Available models: sonnet46T.',
    );
  });

  it('falls back from stale defaults to the first currently runnable model', () => {
    expect(
      resolveCliRunnableModelFromAccessList(
        [
          model('opus48T', { available: false, status: 'not included' }),
          model('deepseekT'),
          model('sonnet46T'),
        ],
        'opus48T',
        { allowFallback: true },
      ),
    ).toEqual({
      model: 'deepseekT',
      notice:
        'Model "opus48T" is not available in the active API mode (not included). Available models: deepseekT, sonnet46T. Using "deepseekT" instead.',
    });
  });

  it('reports when no fallback model is runnable', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [model('gemini31p', { available: false, status: 'missing api key' })],
        'gemini31p',
        { allowFallback: true },
      ),
    ).toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Retry with `--api-mode included` to try included relay access, run `texra login`, or configure a provider API key.',
    );
  });

  it('can format command-specific recovery hints for interactive chat', () => {
    expect(() =>
      resolveCliRunnableModelFromAccessList(
        [model('gemini31p', { available: false, status: 'missing api key' })],
        'gemini31p',
        {
          allowFallback: true,
          noAvailableModelsMessage:
            'Run `texra login` for included relay access.',
        },
      ),
    ).toThrow(
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available. Run `texra login` for included relay access.',
    );
  });

  it('marks explicitly included-mode models as login-required when signed out', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('deepseekT', {
        availability: 'missing-key',
        availabilityLabel: 'Missing API key',
        requiresKey: true,
        disabled: true,
      }),
    ]);
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(false);

    await expect(
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'login required',
        model: {
          value: 'deepseekT',
          availability: 'included-login-required',
          availabilityLabel: 'Login required',
          requiresKey: false,
          disabled: true,
        },
      },
    ]);
  });

  it('preserves relay quota status for signed-in included-mode users', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      modelOption('deepseekT', {
        availability: 'relay-quota-exhausted',
        availabilityLabel: 'Relay quota exhausted',
        requiresKey: false,
        disabled: true,
      }),
    ]);
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(true);

    await expect(
      getCliModelAccessList({ apiMode: 'included' }),
    ).resolves.toMatchObject([
      {
        available: false,
        status: 'relay quota exhausted',
        model: {
          value: 'deepseekT',
          availability: 'relay-quota-exhausted',
          availabilityLabel: 'Relay quota exhausted',
        },
      },
    ]);
  });

  it('checks access for explicit models hidden from the visible model list', async () => {
    computeModelOptionsDataMock
      .mockResolvedValueOnce([
        modelOption('sonnet46T', { availabilityLabel: 'Included access' }),
      ])
      .mockResolvedValueOnce([
        modelOption('hiddenFixtureModel', { availabilityLabel: 'API key set' }),
      ]);

    await expect(
      resolveCliRunnableModel('HIDDENFIXTUREMODEL', { allowFallback: false }),
    ).resolves.toEqual({ model: 'hiddenFixtureModel' });
    expect(computeModelOptionsDataMock).toHaveBeenNthCalledWith(2, [
      'hiddenFixtureModel',
    ]);
  });

  it('reports stale hidden model configuration directly', async () => {
    computeModelOptionsDataMock
      .mockResolvedValueOnce([
        modelOption('sonnet46T', { availabilityLabel: 'Included access' }),
      ])
      .mockResolvedValueOnce([]);

    await expect(
      resolveCliRunnableModel('hiddenFixtureModel', { allowFallback: false }),
    ).rejects.toThrow(
      'Model "hiddenFixtureModel" is configured but has no option data.',
    );
  });
});

function modelOption(
  value: string,
  overrides: Partial<ModelOptionData> = {},
): ModelOptionData {
  return {
    value,
    label: value,
    ...overrides,
  };
}
