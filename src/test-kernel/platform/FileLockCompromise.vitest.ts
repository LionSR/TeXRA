import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
}));

vi.mock('proper-lockfile', () => ({ lock: mocks.lock }));

import { nodeFileLocks } from '@platform/defaults/fileLocks';

describe('nodeFileLocks compromise boundary', () => {
  it('rejects through runExclusive instead of throwing from the renewal callback', async () => {
    const compromised = Object.assign(new Error('lock directory disappeared'), {
      code: 'ECOMPROMISED',
    });
    const alreadyReleased = Object.assign(new Error('lock already released'), {
      code: 'ERELEASED',
    });
    mocks.lock.mockImplementationOnce(async () => async () => {
      throw alreadyReleased;
    });

    const result = nodeFileLocks.runExclusive(
      join(tmpdir(), 'texra-file-lock-compromise'),
      async () => {
        const options = mocks.lock.mock.calls[0]?.[1] as {
          onCompromised: (error: Error) => void;
        };
        expect(() => options.onCompromised(compromised)).not.toThrow();
      },
    );

    await expect(result).rejects.toBe(compromised);
  });
});
