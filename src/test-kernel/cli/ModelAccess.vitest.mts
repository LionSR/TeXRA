import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCliRunnableModel,
  resolveCliRunnableModelFromAccessList,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type { ModelOptionData } from '@shared/schemas';

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: vi.fn(),
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
      'Model "gemini31p" is not available in the active API mode (missing api key). No models are currently available.',
    );
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
