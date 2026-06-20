import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHeadlessRunContext,
  resolveCliRunModelCandidate,
  resolveCliRunModel,
} from '@cli/runtime/runModel';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  type CliConfigValues,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { resolveCliRunnableModel } from '@cli/runtime/modelAccess';
import { selectCliRootModel } from '@cli/runtime/rootModelSelection';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  setCliHelperModel: vi.fn(),
  getCliApiMode: vi.fn(),
  resolveCliRunnableModel: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
  setCliHelperModel: mocks.setCliHelperModel,
}));

vi.mock('@cli/runtime/apiAccessMode', () => ({
  effectiveCliApiMode: (source: { readonly apiMode?: string }) =>
    source.apiMode ?? mocks.getCliApiMode(),
  getCliApiMode: mocks.getCliApiMode,
}));

vi.mock('@cli/runtime/modelAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/modelAccess')>();
  return {
    ...actual,
    resolveCliRunnableModel: mocks.resolveCliRunnableModel,
  };
});

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

const resolveCliRunnableModelMock = vi.mocked(resolveCliRunnableModel);

const KNOWN_MODEL = 'gpt5';
const OTHER_MODEL = 'claudeSonnet';

function makeContext(partial: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp',
    colorEnabled: false,
    mode: 'headless',
    outputFormat: 'text',
    stderrIsTty: false,
    quietLogs: false,
    ...partial,
  } as CliContext;
}

const runConfig = (model: string): CliConfigValues => ({ run: { model } });

describe('selectCliRootModel', () => {
  beforeEach(() => {
    mocks.setCliHelperModel.mockReset();
    mocks.resolveCliRunnableModel.mockReset();
    mocks.setCliHelperModel.mockResolvedValue(undefined);
    resolveCliRunnableModelMock.mockImplementation(async (model) => ({
      model,
    }));
  });

  it('resolves the runnable model and persists the selected helper model', async () => {
    resolveCliRunnableModelMock.mockResolvedValueOnce({
      model: 'deepseekT',
      notice: 'Using deepseekT instead.',
    });

    await expect(
      selectCliRootModel({
        model: 'staleConfiguredModel',
        modelSource: 'config',
        apiMode: 'personal',
        noAvailableModelsMessage: 'No personal models.',
      }),
    ).resolves.toEqual({
      model: 'deepseekT',
      notice: 'Using deepseekT instead.',
    });

    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith(
      'staleConfiguredModel',
      {
        apiMode: 'personal',
        fallbackSource: 'config',
        noAvailableModelsMessage: 'No personal models.',
      },
    );
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith('deepseekT');
  });
});

describe('resolveCliRunModel precedence', () => {
  beforeEach(() => {
    mocks.initCliPlatform.mockReset();
    mocks.setCliHelperModel.mockReset();
    mocks.getCliApiMode.mockReset();
    mocks.resolveCliRunnableModel.mockReset();
    mocks.writeTextStderr.mockReset();
    mocks.initCliPlatform.mockResolvedValue(undefined);
    mocks.setCliHelperModel.mockResolvedValue(undefined);
    mocks.getCliApiMode.mockReturnValue('personal');
    resolveCliRunnableModelMock.mockImplementation(async (model) => ({
      model,
    }));
  });

  it('prefers the explicit model over env and config', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(resolveCliRunModelCandidate(context, KNOWN_MODEL, 'run')).toEqual({
      model: KNOWN_MODEL,
      source: 'override',
    });
  });

  it('falls back to env when no explicit model is given', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(resolveCliRunModelCandidate(context, undefined, 'run')).toEqual({
      model: OTHER_MODEL,
      source: 'env',
    });
  });

  it('uses the configured model when no explicit or env model', () => {
    const context = makeContext({ cliConfig: runConfig('deepseekR') });
    expect(resolveCliRunModelCandidate(context, undefined, 'run')).toEqual({
      model: 'deepseekR',
      source: 'config',
    });
  });

  it('reads the role-specific config section', () => {
    const context = makeContext({
      cliConfig: { chat: { model: OTHER_MODEL }, run: { model: 'deepseekR' } },
    });
    expect(resolveCliRunModelCandidate(context, undefined, 'chat')).toEqual({
      model: OTHER_MODEL,
      source: 'config',
    });
    expect(resolveCliRunModelCandidate(context, undefined, 'run')).toEqual({
      model: 'deepseekR',
      source: 'config',
    });
  });

  it('falls back to the builtin default when nothing else is set', () => {
    expect(
      resolveCliRunModelCandidate(makeContext(), undefined, 'run'),
    ).toEqual({
      model: CLI_BUILTIN_DEFAULT_MODEL,
      source: 'builtin',
    });
  });

  it('suppresses fallback notices for the implicit builtin default', async () => {
    const context = makeContext();

    await resolveCliRunModel(context, undefined, 'run');

    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith(
      CLI_BUILTIN_DEFAULT_MODEL,
      {
        apiMode: 'personal',
        fallbackSource: 'builtin',
      },
    );
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith(
      CLI_BUILTIN_DEFAULT_MODEL,
    );
  });

  it('checks active API-mode access before returning the model', async () => {
    const context = makeContext({
      cliConfig: runConfig('staleConfiguredModel'),
    });
    resolveCliRunnableModelMock.mockResolvedValueOnce({
      model: 'deepseekT',
      notice: 'Using deepseekT instead.',
    });

    await expect(resolveCliRunModel(context, undefined, 'run')).resolves.toBe(
      'deepseekT',
    );
    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith(
      'staleConfiguredModel',
      expect.objectContaining({ fallbackSource: 'config' }),
    );
    expect(mocks.initCliPlatform).toHaveBeenCalledWith({
      ...context,
      quietLogs: true,
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Using deepseekT instead.',
    );
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith('deepseekT');
  });

  it('does not fall back from an explicit unavailable model', async () => {
    const context = makeContext({
      cliConfig: runConfig('deepseekT'),
    });
    resolveCliRunnableModelMock.mockRejectedValueOnce(
      new Error(
        'Model "opus48T" is not available in the active API mode (not included). Available models: deepseekT.',
      ),
    );

    await expect(resolveCliRunModel(context, 'opus48T', 'run')).rejects.toThrow(
      CliUsageError,
    );
    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith('opus48T', {
      apiMode: 'personal',
      fallbackSource: 'override',
    });
  });

  it('treats TEXRA_MODEL as an explicit model request', async () => {
    const context = makeContext({
      envModel: 'opus48T',
      cliConfig: runConfig('deepseekT'),
    });

    await resolveCliRunModel(context, undefined, 'run');

    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith('opus48T', {
      apiMode: 'personal',
      fallbackSource: 'env',
    });
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith('opus48T');
  });
});

describe('buildHeadlessRunContext', () => {
  it('sets the helper model, quiet logs, and enables progress for text output', () => {
    const context = makeContext({ outputFormat: 'text', quietLogs: false });
    const runContext = buildHeadlessRunContext(context, KNOWN_MODEL);
    expect(runContext.helperModel).toBe(KNOWN_MODEL);
    expect(runContext.quietLogs).toBe(true);
    expect(runContext.renderRunProgress).toBe(true);
  });

  it('keeps human run progress for json output', () => {
    const context = makeContext({ outputFormat: 'json' });
    const runContext = buildHeadlessRunContext(context, KNOWN_MODEL);
    expect(runContext.renderRunProgress).toBe(true);
  });
});
