import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '@cli/runtime/runModel';
import { CLI_CHEAP_START_MODEL } from '@cli/runtime/cliConfig';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { selectCliRunnableModel } from '@cli/runtime/modelAccess';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeConfigProvider, fakeStores } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

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

/** Installs a host whose config carries `texra.run.model` — the tier
 *  `selectCliRunModel` resolves through the workspace roots. */
function withRunModel(model: string): Promise<void> {
  return installPlatform(
    {},
    { config: new FakeConfigProvider({ 'texra.run': { model } }) },
  );
}

/** The stores each command hands to `selectCliRunModel`; model access is mocked. */
const STORES = { ...fakeStores(), runtime: testRuntime() };

/** `selectCliRunModel` is an Effect now; the suite is its run boundary. */
const runSelect = (
  ...args: Parameters<typeof selectCliRunModel>
): Promise<string> => STORES.runtime.runPromise(selectCliRunModel(...args));

describe('selectCliRunModel precedence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    selectCliRunnableModelMock.mockImplementation((request) =>
      Effect.succeed({
        model: Array.isArray(request)
          ? (request.find((candidate) => candidate.model)?.model ??
            CLI_CHEAP_START_MODEL)
          : request,
      }),
    );
  });

  it('passes the full run-model candidate list to model access', async () => {
    await withRunModel('deepseekR');
    const context = makeContext({ envModel: OTHER_MODEL });

    await runSelect(context, KNOWN_MODEL, 'run', STORES);

    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      [
        { model: KNOWN_MODEL, reason: 'explicit-override' },
        { model: OTHER_MODEL, reason: 'environment' },
        { model: 'deepseekR', reason: 'command-config' },
        { model: CLI_CHEAP_START_MODEL, reason: 'builtin-default' },
      ],
      { stores: STORES },
    );
  });

  it('checks model access before returning the model', async () => {
    await withRunModel('staleConfiguredModel');
    const context = makeContext();
    selectCliRunnableModelMock.mockReturnValueOnce(
      Effect.succeed({
        model: 'deepseekT',
        notice: 'Using deepseekT instead.',
      }),
    );

    await expect(runSelect(context, undefined, 'run', STORES)).resolves.toBe(
      'deepseekT',
    );
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
    await withRunModel('deepseekT');
    const context = makeContext();
    selectCliRunnableModelMock.mockReturnValueOnce(
      Effect.fail(
        new Error(
          'Model "opus48T" is not available (missing key). Available models: deepseekT.',
        ),
      ),
    );

    await expect(
      runSelect(context, 'opus48T', 'run', STORES),
    ).rejects.toThrow(CliUsageError);
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'opus48T', reason: 'explicit-override' },
      ]),
      { stores: STORES },
    );
  });
});
