import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '@cli/runtime/runModel';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  type CliConfigValues,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { selectCliRunnableModel } from '@cli/runtime/modelAccess';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';

const mocks = vi.hoisted(() => ({
  selectCliRunnableModel: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@cli/runtime/modelAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/modelAccess')>();
  return {
    ...actual,
    selectCliRunnableModel: mocks.selectCliRunnableModel,
  };
});

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

const selectCliRunnableModelMock = vi.mocked(selectCliRunnableModel);

const KNOWN_MODEL = 'gpt5';
const OTHER_MODEL = 'claudeSonnet';

function makeContext(partial: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    cwd: '/tmp',
    ...partial,
  });
}

const runConfig = (model: string): CliConfigValues => ({ run: { model } });

/** The stores each command hands to `selectCliRunModel`; model access is mocked. */
const STORES: ModelOptionStores = {
  secrets: new FakeSecrets(),
  globalState: new FakeStateStore(),
};

describe('selectCliRunModel precedence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    selectCliRunnableModelMock.mockImplementation(async (request) => ({
      model: Array.isArray(request)
        ? (request.find((candidate) => candidate.model)?.model ??
          CLI_BUILTIN_DEFAULT_MODEL)
        : request,
    }));
  });

  it('passes the full run-model candidate list to model access', async () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });

    await selectCliRunModel(context, KNOWN_MODEL, 'run', STORES);

    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      [
        { model: KNOWN_MODEL, reason: 'explicit-override' },
        { model: OTHER_MODEL, reason: 'environment' },
        { model: 'deepseekR', reason: 'command-config' },
        { model: CLI_BUILTIN_DEFAULT_MODEL, reason: 'builtin-default' },
      ],
      { stores: STORES },
    );
  });

  it('checks model access before returning the model', async () => {
    const context = makeContext({
      cliConfig: runConfig('staleConfiguredModel'),
    });
    selectCliRunnableModelMock.mockResolvedValueOnce({
      model: 'deepseekT',
      notice: 'Using deepseekT instead.',
    });

    await expect(
      selectCliRunModel(context, undefined, 'run', STORES),
    ).resolves.toBe('deepseekT');
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'staleConfiguredModel', reason: 'command-config' },
      ]),
      { stores: STORES },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Using deepseekT instead.',
    );
  });

  it('does not fall back from an explicit unavailable model', async () => {
    const context = makeContext({
      cliConfig: runConfig('deepseekT'),
    });
    selectCliRunnableModelMock.mockRejectedValueOnce(
      new Error(
        'Model "opus48T" is not available (missing key). Available models: deepseekT.',
      ),
    );

    await expect(
      selectCliRunModel(context, 'opus48T', 'run', STORES),
    ).rejects.toThrow(CliUsageError);
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'opus48T', reason: 'explicit-override' },
      ]),
      { stores: STORES },
    );
  });
});
