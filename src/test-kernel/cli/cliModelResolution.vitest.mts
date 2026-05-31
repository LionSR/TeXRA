import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHeadlessRunContext,
  resolveCliRunModelCandidate,
  resolveCliRunModel,
} from '@cli/commands/_helpers/modelArg';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  type CliConfigValues,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { resolveCliRunnableModel } from '@cli/runtime/modelAccess';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  resolveCliRunnableModel: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/modelAccess', () => ({
  resolveCliRunnableModel: mocks.resolveCliRunnableModel,
}));

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

describe('resolveCliRunModel precedence', () => {
  beforeEach(() => {
    mocks.initCliPlatform.mockReset();
    mocks.resolveCliRunnableModel.mockReset();
    mocks.writeTextStderr.mockReset();
    mocks.initCliPlatform.mockResolvedValue(undefined);
    resolveCliRunnableModelMock.mockImplementation(async (model) => ({
      model,
    }));
  });

  it('prefers the explicit model over env and config', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(resolveCliRunModelCandidate(context, KNOWN_MODEL, 'run')).toBe(
      KNOWN_MODEL,
    );
  });

  it('falls back to env when no explicit model is given', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(resolveCliRunModelCandidate(context, undefined, 'run')).toBe(
      OTHER_MODEL,
    );
  });

  it('uses the configured model when no explicit or env model', () => {
    const context = makeContext({ cliConfig: runConfig('deepseekR') });
    expect(resolveCliRunModelCandidate(context, undefined, 'run')).toBe(
      'deepseekR',
    );
  });

  it('reads the role-specific config section', () => {
    const context = makeContext({
      cliConfig: { chat: { model: OTHER_MODEL }, run: { model: 'deepseekR' } },
    });
    expect(resolveCliRunModelCandidate(context, undefined, 'chat')).toBe(
      OTHER_MODEL,
    );
    expect(resolveCliRunModelCandidate(context, undefined, 'run')).toBe(
      'deepseekR',
    );
  });

  it('falls back to the builtin default when nothing else is set', () => {
    expect(resolveCliRunModelCandidate(makeContext(), undefined, 'run')).toBe(
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
      { allowFallback: true },
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
    resolveCliRunnableModelMock.mockRejectedValueOnce(
      new Error(
        'Model "opus48T" is not available in the active API mode (not included). Available models: deepseekT.',
      ),
    );

    await expect(resolveCliRunModel(context, 'opus48T', 'run')).rejects.toThrow(
      CliUsageError,
    );
    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith('opus48T', {
      allowFallback: false,
    });
  });

  it('treats TEXRA_MODEL as an explicit model request', async () => {
    const context = makeContext({
      envModel: 'opus48T',
      cliConfig: runConfig('deepseekT'),
    });

    await resolveCliRunModel(context, undefined, 'run');

    expect(resolveCliRunnableModelMock).toHaveBeenCalledWith('opus48T', {
      allowFallback: false,
    });
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

  it('disables run progress for non-text output formats', () => {
    const context = makeContext({ outputFormat: 'json' });
    const runContext = buildHeadlessRunContext(context, KNOWN_MODEL);
    expect(runContext.renderRunProgress).toBe(false);
  });
});
