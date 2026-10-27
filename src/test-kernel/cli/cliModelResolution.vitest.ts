import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { selectCliRunModel } from '@cli/runtime/runModel';
import { CliUsageError } from '@cli/runtime/cliContext';
import { selectCliRunnableModel } from '@cli/runtime/modelAccess';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
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

/** Installs a host whose config carries `texra.run.model` — the tier
 *  `selectCliRunModel` resolves through the workspace roots. */
function withRunModel(model: string): Promise<void> {
  return installPlatform({ config: { 'texra.run': { model } } });
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
  it('does not fall back from an explicit unavailable model', async () => {
    await withRunModel('deepseek/deepseek-v4-flash');
    const stores = storesOf();
    const context = createTestCliContext({ cwd: '/tmp' });
    selectCliRunnableModelMock.mockReturnValueOnce(
      Effect.fail(
        new Error(
          'Model "anthropic/claude-opus-5-5" is not available (missing key). Available models: deepseek/deepseek-v4-flash.',
        ),
      ),
    );

    await expect(
      runSelect(context, 'anthropic/claude-opus-5-5', 'run', stores),
    ).rejects.toThrow(CliUsageError);
    expect(selectCliRunnableModelMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { model: 'anthropic/claude-opus-5-5', reason: 'explicit-override' },
      ]),
      { stores },
    );
  });
});
