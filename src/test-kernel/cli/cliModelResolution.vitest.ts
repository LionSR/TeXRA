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
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  getCliApiMode: vi.fn(),
  selectCliRunnableModel: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
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

describe('selectCliRunModel precedence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.initCliPlatform.mockResolvedValue(undefined);
    mocks.getCliApiMode.mockReturnValue('personal');
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

    await selectCliRunModel(context, KNOWN_MODEL, 'run');

    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      [
        { model: KNOWN_MODEL, reason: 'explicit-override' },
        { model: OTHER_MODEL, reason: 'environment' },
        { model: 'deepseekR', reason: 'command-config' },
        { model: CLI_BUILTIN_DEFAULT_MODEL, reason: 'builtin-default' },
      ],
      {
        apiMode: 'personal',
      },
    );
  });

  it('reads the role-specific config section', async () => {
    const context = makeContext({
      cliConfig: { chat: { model: OTHER_MODEL }, run: { model: 'deepseekR' } },
    });

    await selectCliRunModel(context, undefined, 'chat');
    await selectCliRunModel(context, undefined, 'run');

    expect(selectCliRunnableModelMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        { model: OTHER_MODEL, reason: 'command-config' },
      ]),
      expect.objectContaining({ apiMode: 'personal' }),
    );
    expect(selectCliRunnableModelMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        { model: 'deepseekR', reason: 'command-config' },
      ]),
      expect.objectContaining({ apiMode: 'personal' }),
    );
  });

  it('checks active API-mode access before returning the model', async () => {
    const context = makeContext({
      cliConfig: runConfig('staleConfiguredModel'),
    });
    selectCliRunnableModelMock.mockResolvedValueOnce({
      model: 'deepseekT',
      notice: 'Using deepseekT instead.',
    });

    await expect(selectCliRunModel(context, undefined, 'run')).resolves.toBe(
      'deepseekT',
    );
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'staleConfiguredModel', reason: 'command-config' },
      ]),
      expect.objectContaining({ apiMode: 'personal' }),
    );
    expect(mocks.initCliPlatform).toHaveBeenCalledWith({
      ...context,
      quietLogs: true,
    });
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
        'Model "opus48T" is not available in the active API mode (not included). Available models: deepseekT.',
      ),
    );

    await expect(selectCliRunModel(context, 'opus48T', 'run')).rejects.toThrow(
      CliUsageError,
    );
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'opus48T', reason: 'explicit-override' },
      ]),
      {
        apiMode: 'personal',
      },
    );
  });
});

describe('buildHeadlessRunContext', () => {
  it('preserves the helper model, quiets logs, and enables progress for text output', () => {
    const context = makeContext({
      helperModel: 'configured-helper',
      outputFormat: 'text',
      quietLogs: false,
    });
    const runContext = buildHeadlessRunContext(context);
    expect(runContext.helperModel).toBe('configured-helper');
    expect(runContext.quietLogs).toBe(true);
    expect(runContext.renderRunProgress).toBe(true);
  });

  it('keeps human run progress for json output', () => {
    const context = makeContext({ outputFormat: 'json' });
    const runContext = buildHeadlessRunContext(context);
    expect(runContext.renderRunProgress).toBe(true);
  });
});
