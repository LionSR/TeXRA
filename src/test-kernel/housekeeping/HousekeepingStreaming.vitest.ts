// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { WorkspaceFS } from '@utils/files/workspaceFS';

const mocks = vi.hoisted(() => ({
  globIterate: vi.fn(),
}));

vi.mock('glob', () => ({
  globIterate: mocks.globIterate,
}));

vi.mock('llm-zoo', async (importActual) => ({
  ...(await importActual<typeof import('llm-zoo')>()),
  MODELS: ['test-model'],
}));

const { runCleanOutput } = await import('@housekeeping/clean');

describe('housekeeping streaming cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    vi.spyOn(WorkspaceFS, 'getPath').mockReturnValue('/workspace');
    const deleteFile = vi
      .spyOn(WorkspaceFS, 'delete')
      .mockImplementation(async (file: string) => {
        if (file === 'first.tex') {
          expect(requestedSecondMatch).toBe(false);
          releaseSecondMatch?.();
        }
      });

    await runCleanOutput();

    expect(deleteFile).toHaveBeenNthCalledWith(1, 'first.tex');
    expect(deleteFile).toHaveBeenNthCalledWith(2, 'second.tex');
  });
});
