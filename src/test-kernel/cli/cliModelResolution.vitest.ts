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
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { hostStores, installPlatform } from '@test/support/setupPlatform';

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

/**
 * The stores each command hands to `selectCliRunModel`: the installed host's,
 * so the `texra.run` row `withRunModel` seeded is the one the command-config
 * tier reads. Built after the install, so each test names its own host.
 */
const storesOf = (): ReturnType<typeof hostStores> & {
  readonly runtime: ReturnType<typeof testRuntime>;
} => ({ ...hostStores(), runtime: testRuntime() });

/** `selectCliRunModel` is an Effect now; the suite is its run boundary. */
const runSelect = (
  ...args: Parameters<typeof selectCliRunModel>
): Promise<string> => testRuntime().runPromise(selectCliRunModel(...args));

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
    const stores = storesOf();
    const context = makeContext({ envModel: OTHER_MODEL });

    await runSelect(context, KNOWN_MODEL, 'run', stores);

    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      [
        { model: KNOWN_MODEL, reason: 'explicit-override' },
        { model: OTHER_MODEL, reason: 'environment' },
        { model: 'deepseekR', reason: 'command-config' },
        { model: CLI_CHEAP_START_MODEL, reason: 'builtin-default' },
      ],
      { stores },
    );
  });

  it('checks model access before returning the model', async () => {
    await withRunModel('staleConfiguredModel');
    const stores = storesOf();
    const context = makeContext();
    selectCliRunnableModelMock.mockReturnValueOnce(
      Effect.succeed({
        model: 'deepseekT',
        notice: 'Using deepseekT instead.',
      }),
    );

    await expect(runSelect(context, undefined, 'run', stores)).resolves.toBe(
      'deepseekT',
    );
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'staleConfiguredModel', reason: 'command-config' },
      ]),
      { stores },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Using deepseekT instead.',
    );
  });

  it('does not fall back from an explicit unavailable model', async () => {
    await withRunModel('deepseekT');
    const stores = storesOf();
    const context = makeContext();
    selectCliRunnableModelMock.mockReturnValueOnce(
      Effect.fail(
        new Error(
          'Model "opus48T" is not available (missing key). Available models: deepseekT.',
        ),
      ),
    );

    await expect(runSelect(context, 'opus48T', 'run', stores)).rejects.toThrow(
      CliUsageError,
    );
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'opus48T', reason: 'explicit-override' },
      ]),
      { stores },
    );
  });
});
