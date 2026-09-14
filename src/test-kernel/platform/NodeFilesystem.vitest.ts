// Node imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { FileType, type FileSystemProvider } from '@platform/interfaces';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';

type ProviderCase = {
  provider: FileSystemProvider;
  resolve(testPath: string): string;
  expectedRealPath(testPath: string): Promise<string>;
};

/**
 * Runs `run` against `nodeFilesystem` rooted in a fresh temp directory, so a
 * test can name paths as if the provider owned `/`.
 */
async function withProvider(
  run: (ctx: ProviderCase) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-fs-'));
  const resolve = (testPath: string): string =>
    path.join(root, testPath.slice(1));
  try {
    await run({
      provider: nodeFilesystem,
      resolve,
      expectedRealPath: (testPath) => fs.realpath(resolve(testPath)),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function text(content: Uint8Array): string {
  return Buffer.from(content).toString('utf8');
}

function sortedEntries(entries: [string, number][]): [string, number][] {
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

async function rejectsWithCode(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (err: unknown) => {
    assert.equal((err as NodeJS.ErrnoException).code, code);
    return true;
  });
}

describe('nodeFilesystem', () => {
  it('reads, writes, stats, and lists directories', async () => {
    await withProvider(async ({ provider, resolve, expectedRealPath }) => {
      await provider.createDirectory(resolve('/workspace/docs'));
      await provider.writeFile(
        resolve('/workspace/docs/a.txt'),
        Buffer.from('A'),
      );
      await provider.appendFile(
        resolve('/workspace/docs/a.txt'),
        Buffer.from('B'),
      );
      await provider.writeFileAtomic(
        resolve('/workspace/docs/atomic.txt'),
        Buffer.from('atomic'),
      );

      assert.equal(
        text(await provider.readFile(resolve('/workspace/docs/a.txt'))),
        'AB',
      );
      assert.deepEqual(
        sortedEntries(await provider.readDirectory(resolve('/workspace/docs'))),
        [
          ['a.txt', FileType.File],
          ['atomic.txt', FileType.File],
        ],
      );
      assert.equal(
        (await provider.stat(resolve('/workspace/docs'))).type,
        FileType.Directory,
      );
      assert.equal(
        (await provider.stat(resolve('/workspace/docs/a.txt'))).size,
        2,
      );
      assert.equal(
        await provider.isSymlink(resolve('/workspace/docs/a.txt')),
        false,
      );
      assert.equal(
        await provider.realPath(resolve('/workspace/docs/a.txt')),
        await expectedRealPath('/workspace/docs/a.txt'),
      );
    });
  });

  it('copies, renames, and deletes', async () => {
    await withProvider(async ({ provider, resolve }) => {
      await provider.createDirectory(resolve('/workspace/source/nested'));
      await provider.writeFile(
        resolve('/workspace/source/a.txt'),
        Buffer.from('A'),
      );
      await provider.writeFile(
        resolve('/workspace/source/nested/b.txt'),
        Buffer.from('B'),
      );

      await provider.copy(
        resolve('/workspace/source'),
        resolve('/workspace/dest'),
        {
          overwrite: true,
        },
      );
      assert.equal(
        text(await provider.readFile(resolve('/workspace/dest/a.txt'))),
        'A',
      );
      assert.equal(
        text(await provider.readFile(resolve('/workspace/dest/nested/b.txt'))),
        'B',
      );
      await provider.copy(
        resolve('/workspace/source/a.txt'),
        resolve('/workspace/file-copy.txt'),
      );
      assert.equal(
        text(await provider.readFile(resolve('/workspace/file-copy.txt'))),
        'A',
      );
      await rejectsWithCode(
        () =>
          provider.copy(
            resolve('/workspace/source/a.txt'),
            resolve('/workspace/file-copy.txt'),
          ),
        'EEXIST',
      );

      await provider.rename(
        resolve('/workspace/dest/a.txt'),
        resolve('/workspace/dest/c.txt'),
        {
          overwrite: true,
        },
      );
      await rejectsWithCode(
        () => provider.stat(resolve('/workspace/dest/a.txt')),
        'ENOENT',
      );
      assert.equal(
        text(await provider.readFile(resolve('/workspace/dest/c.txt'))),
        'A',
      );

      await provider.delete(resolve('/workspace/dest'), { recursive: true });
      await rejectsWithCode(
        () => provider.stat(resolve('/workspace/dest/c.txt')),
        'ENOENT',
      );
      await provider.delete(resolve('/workspace/dest'), { recursive: true });
    });
  });

  it('reports errno codes for common failures', async () => {
    await withProvider(async ({ provider, resolve }) => {
      await rejectsWithCode(
        () =>
          provider.writeFile(
            resolve('/workspace/missing/a.txt'),
            Buffer.from('A'),
          ),
        'ENOENT',
      );

      await provider.createDirectory(resolve('/workspace/source'));
      await provider.writeFile(
        resolve('/workspace/source/a.txt'),
        Buffer.from('A'),
      );
      await provider.writeFile(
        resolve('/workspace/source/b.txt'),
        Buffer.from('B'),
      );

      await rejectsWithCode(
        () => provider.readFile(resolve('/workspace/source')),
        'EISDIR',
      );
      await rejectsWithCode(
        () =>
          provider.rename(
            resolve('/workspace/source/a.txt'),
            resolve('/workspace/source/b.txt'),
          ),
        'EEXIST',
      );
      await rejectsWithCode(
        () =>
          provider.copy(
            resolve('/workspace/source'),
            resolve('/workspace/source/nested'),
          ),
        'ERR_FS_CP_EINVAL',
      );
      await rejectsWithCode(
        () =>
          provider.copy(
            resolve('/workspace/missing'),
            resolve('/workspace/missing/nested'),
          ),
        'ENOENT',
      );
      await rejectsWithCode(
        () =>
          provider.rename(
            resolve('/workspace/missing'),
            resolve('/workspace/missing/nested'),
          ),
        'ENOENT',
      );
    });
  });
});
