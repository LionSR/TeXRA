import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import { moveToTarget } from '@utils/files/taskRunStorage';

suite('taskRunStorage moveToTarget', () => {
  async function createTempDir(prefix: string): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async function withPatchedRename(
    code: NodeJS.ErrnoException['code'],
    run: () => Promise<void>,
  ): Promise<void> {
    const originalRename = fs.rename;
    const originalCopyFile = fs.copyFile;
    const originalCp = (fs as any).cp;

    let patched = false;
    try {
      let callCount = 0;
      (fs as unknown as { rename: typeof fs.rename }).rename = async (
        source,
        destination,
      ) => {
        callCount += 1;
        if (callCount === 1) {
          const err = new Error('fail') as NodeJS.ErrnoException;
          err.code = code;
          patched = true;
          throw err;
        }
        return originalRename(source, destination);
      };

      (fs as unknown as { copyFile: typeof fs.copyFile }).copyFile =
        async () => {
          throw new Error('copyFile should not be invoked when retrying move');
        };

      if (originalCp) {
        (fs as any).cp = async () => {
          throw new Error('cp should not be invoked when retrying move');
        };
      }

      await run();
      assert.ok(patched, 'expected rename to be patched for first call');
    } finally {
      (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
      (fs as unknown as { copyFile: typeof fs.copyFile }).copyFile =
        originalCopyFile;
      if ((fs as any).cp !== undefined) {
        (fs as any).cp = originalCp;
      }
    }
  }

  test('retries directory move when destination exists (EISDIR)', async () => {
    const tmpRoot = await createTempDir('texra-run-');
    const sourceDir = path.join(tmpRoot, 'source');
    const destDir = path.join(tmpRoot, 'dest');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content');
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, 'old.txt'), 'old');

    await withPatchedRename('EISDIR', async () => {
      await moveToTarget(sourceDir, destDir);
    });

    const destEntries = await fs.readdir(destDir);
    assert.deepEqual(destEntries.sort(), ['file.txt']);

    await assert.rejects(fs.stat(sourceDir));
  });

  test('retries directory move when destination not empty (ENOTEMPTY)', async () => {
    const tmpRoot = await createTempDir('texra-run-');
    const sourceDir = path.join(tmpRoot, 'source2');
    const destDir = path.join(tmpRoot, 'dest2');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content');
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, 'stale.txt'), 'old');

    await withPatchedRename('ENOTEMPTY', async () => {
      await moveToTarget(sourceDir, destDir);
    });

    const destEntries = await fs.readdir(destDir);
    assert.deepEqual(destEntries.sort(), ['file.txt']);

    await assert.rejects(fs.stat(sourceDir));
  });
});
