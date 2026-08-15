import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { withTempDir } from '@test/support/tempDirPlatform';

describe('nodeFilesystem.writeFileAtomic', () => {
  it('writes content, overwrites in place, and leaves no temp residue', async () => {
    await withTempDir('texra-atomic-', async (dir) => {
      const target = path.join(dir, 'flow.json');

      await nodeFilesystem.writeFileAtomic(target, Buffer.from('{"step":1}'));
      expect(await readFile(target, 'utf8')).toBe('{"step":1}');

      // Overwrite — the crash-sensitive path (re-serialized flow state).
      await nodeFilesystem.writeFileAtomic(target, Buffer.from('{"step":2}'));
      expect(await readFile(target, 'utf8')).toBe('{"step":2}');

      // The temp file must have been renamed away, not abandoned.
      const entries = await readdir(dir);
      expect(entries).toEqual(['flow.json']);
    });
  });
});
