import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHeadlessRunContext,
  chooseCliRunModelCandidate,
  selectCliRunModel,
} from '@cli/runtime/runModel';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  type CliConfigValues,
} from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { selectCliRunnableModel } from '@cli/runtime/modelAccess';
import { AgentCategory } from '@shared/schemas/agent';

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

describe('selectCliRunModel precedence', () => {
  beforeEach(() => {
    mocks.initCliPlatform.mockReset();
    mocks.getCliApiMode.mockReset();
    mocks.selectCliRunnableModel.mockReset();
    mocks.writeTextStderr.mockReset();
    mocks.initCliPlatform.mockResolvedValue(undefined);
    mocks.getCliApiMode.mockReturnValue('personal');
    selectCliRunnableModelMock.mockImplementation(async (model) => ({
      model,
    }));
  });

  it('prefers the explicit model over env and config', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(chooseCliRunModelCandidate(context, KNOWN_MODEL, 'run')).toEqual({
      model: KNOWN_MODEL,
      source: 'override',
    });
  });

  it('falls back to env when no explicit model is given', () => {
    const context = makeContext({
      envModel: OTHER_MODEL,
      cliConfig: runConfig('deepseekR'),
    });
    expect(chooseCliRunModelCandidate(context, undefined, 'run')).toEqual({
      model: OTHER_MODEL,
      source: 'env',
    });
  });

  it('uses the configured model when no explicit or env model', () => {
    const context = makeContext({ cliConfig: runConfig('deepseekR') });
    expect(chooseCliRunModelCandidate(context, undefined, 'run')).toEqual({
      model: 'deepseekR',
      source: 'config',
    });
  });

  it('reads the role-specific config section', () => {
    const context = makeContext({
      cliConfig: { chat: { model: OTHER_MODEL }, run: { model: 'deepseekR' } },
    });
    expect(chooseCliRunModelCandidate(context, undefined, 'chat')).toEqual({
      model: OTHER_MODEL,
      source: 'config',
    });
    expect(chooseCliRunModelCandidate(context, undefined, 'run')).toEqual({
      model: 'deepseekR',
      source: 'config',
    });
  });

  it('falls back to the builtin default when nothing else is set', () => {
    expect(chooseCliRunModelCandidate(makeContext(), undefined, 'run')).toEqual(
      {
        model: CLI_BUILTIN_DEFAULT_MODEL,
        source: 'builtin',
      },
    );
  });

  it('suppresses fallback notices for the implicit builtin default', async () => {
    const context = makeContext();

    await selectCliRunModel(context, undefined, 'run');

    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      CLI_BUILTIN_DEFAULT_MODEL,
      {
        agentCategory: AgentCategory.Workflow,
        apiMode: 'personal',
        fallbackSource: 'builtin',
      },
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
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith('opus48T', {
      agentCategory: AgentCategory.Workflow,
      apiMode: 'personal',
      fallbackSource: 'override',
    });
  });

  it('treats TEXRA_MODEL as an explicit model request', async () => {
    const context = makeContext({
      envModel: 'opus48T',
      cliConfig: runConfig('deepseekT'),
    });

    await selectCliRunModel(context, undefined, 'run');

    expect(selectCliRunnableModelMock).toHaveBeenCalledWith('opus48T', {
      agentCategory: AgentCategory.Workflow,
      apiMode: 'personal',
      fallbackSource: 'env',
    });
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
