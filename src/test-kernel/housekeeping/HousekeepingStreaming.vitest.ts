// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  getPath: vi.fn(() => '/workspace'),
  globIterate: vi.fn(),
}));

vi.mock('glob', () => ({
  globIterate: mocks.globIterate,
}));

vi.mock('llm-zoo', async (importActual) => ({
  ...(await importActual<typeof import('llm-zoo')>()),
  MODELS: ['test-model'],
}));

vi.mock('@utils/files', () => ({
  WorkspaceFS: {
    delete: mocks.delete,
    getPath: mocks.getPath,
  },
}));

const { runCleanOutput } = await import('@housekeeping/clean');

describe('housekeeping streaming cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes each output before requesting the next match', async () => {
    let releaseSecondMatch: (() => void) | undefined;
    const secondMatchReady = new Promise<void>((resolve) => {
      releaseSecondMatch = resolve;
    });
    let requestedSecondMatch = false;

    mocks.globIterate.mockImplementation(async function* () {
      yield 'first.tex';
      requestedSecondMatch = true;
      await secondMatchReady;
      yield 'second.tex';
    });

    mocks.delete.mockImplementation(async (file: string) => {
      if (file === 'first.tex') {
        expect(requestedSecondMatch).toBe(false);
        releaseSecondMatch?.();
      }
    });

    await runCleanOutput();

    expect(mocks.delete).toHaveBeenNthCalledWith(1, 'first.tex');
    expect(mocks.delete).toHaveBeenNthCalledWith(2, 'second.tex');
  });
});
