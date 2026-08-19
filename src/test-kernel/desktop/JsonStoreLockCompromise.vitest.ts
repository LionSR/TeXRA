import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
}));

vi.mock('proper-lockfile', () => ({ lock: mocks.lock }));

// Local imports - test support
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { loadSourceModule } from './loadSourceModule.ts';

describe('JsonStore lock compromise boundary', () => {
  const tempDirs = useTempDirs();

  it('rejects set() through the compromise path instead of crashing the process', async () => {
    const tempDir = await makeTempDir('texra-json-store-compromise-', tempDirs);
    const filePath = join(tempDir, 'state.json');
    await writeFile(filePath, '{}\n');

    const compromised = Object.assign(new Error('lock directory disappeared'), {
      code: 'ECOMPROMISED',
    });
    const alreadyReleased = Object.assign(new Error('lock already released'), {
      code: 'ERELEASED',
    });
    mocks.lock.mockImplementationOnce(
      async (
        _path: string,
        options: { onCompromised: (error: Error) => void },
      ) => {
        // Simulate proper-lockfile's renewal timer firing mid-flush: this
        // must not throw synchronously (that would escape as an uncaught
        // exception outside JsonStore.set()'s promise), and its error must
        // still surface through set() rather than being silently dropped.
        expect(() => options.onCompromised(compromised)).not.toThrow();
        return async () => {
          throw alreadyReleased;
        };
      },
    );

    const { JsonStore } = await loadSourceModule(
      '@platform/defaults/jsonStore',
    );
    const store = await JsonStore.open(filePath);

    await expect(store.set('key', 'value')).rejects.toBe(compromised);
  });
});
