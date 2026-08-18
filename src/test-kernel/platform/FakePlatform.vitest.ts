// Node imports
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { FileType, type FileSystemProvider } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';

// Local file imports
import {
  FakeFileSystemProvider,
  createFakePlatform,
} from '../support/FakePlatform';

type ProviderCase = {
  provider: FileSystemProvider;
  resolve(testPath: string): string;
  expectedRealPath(testPath: string): Promise<string>;
  cleanup(): Promise<void>;
};

async function createProviderCase(
  name: 'fake' | 'node',
): Promise<ProviderCase> {
  if (name === 'fake') {
    return {
      provider: new FakeFileSystemProvider(),
      resolve: (testPath) => testPath,
      expectedRealPath: async (testPath) => testPath,
      cleanup: async () => {},
    };
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-fs-'));
  const resolve = (testPath: string): string =>
    path.join(root, testPath.slice(1));
  return {
    provider: nodeFilesystem,
    resolve,
    expectedRealPath: (testPath) => fs.realpath(resolve(testPath)),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function withProviders(
  run: (ctx: ProviderCase) => Promise<void>,
): Promise<void> {
  for (const name of ['fake', 'node'] as const) {
    const ctx = await createProviderCase(name);
    try {
      await run(ctx);
    } finally {
      await ctx.cleanup();
    }
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

describe('FakePlatform', () => {
  it('installs a default fake platform from vitest setup', () => {
    assert.equal(platform().workspace.getWorkspacePath(), '/workspace');
    assert.equal(platform().fs instanceof FakeFileSystemProvider, true);
  });

  it('provides overridable platform services for tests', async () => {
    const platform = createFakePlatform({
      config: { enabled: true },
      globalState: { version: 2 },
      workspaceState: { task: 'active' },
      files: { '/workspace/src/main.tex': 'hello' },
      secrets: { token: 'secret-value' },
    });

    assert.equal(platform.config.get('enabled', false), true);
    assert.equal(platform.globalState.get('version', 0), 2);
    assert.equal(platform.workspaceState.get('task', 'idle'), 'active');
    assert.equal(
      platform.workspace.asRelativePath('/workspace/src/main.tex'),
      'src/main.tex',
    );
    assert.equal(platform.workspace.asRelativePath('/workspace'), '');
    assert.equal(
      platform.storage.getStoragePath(),
      '/workspace/.texra/storage',
    );
    assert.equal(await platform.secrets.get('token'), 'secret-value');
    assert.equal(
      Buffer.from(
        await platform.fs.readFile('/workspace/src/main.tex'),
      ).toString('utf8'),
      'hello',
    );
  });

  it('can model a missing workspace root', () => {
    const platform = createFakePlatform({ workspacePath: undefined });

    assert.equal(platform.workspace.getWorkspacePath(), undefined);
    assert.equal(
      platform.workspace.asRelativePath('/outside/main.tex'),
      '/outside/main.tex',
    );
  });

  it('supports fake config updates', async () => {
    const platform = createFakePlatform({
      config: { enabled: true },
    });

    await platform.config.update('enabled', false, 'global');
    await platform.config.update('enabled', true, 'global');

    assert.equal(platform.config.get('enabled', true), true);
    assert.equal(platform.config.isExplicitlySet('enabled'), true);
    assert.deepEqual(platform.config.inspect('enabled'), {
      globalValue: true,
      workspaceValue: undefined,
    });
  });

  it('mirrors texra config aliases', async () => {
    const platform = createFakePlatform();

    await platform.config.update('texra.files.exclude', ['node_modules']);
    await platform.config.update('texra.files.include', ['src']);

    assert.deepEqual(platform.config.get('files.exclude', []), [
      'node_modules',
    ]);
    assert.equal(platform.config.isExplicitlySet('files.exclude'), true);
    assert.deepEqual(platform.config.inspect('files.exclude'), {
      globalValue: undefined,
      workspaceValue: ['node_modules'],
    });
  });

  it('writes config aliases to the exact caller key', async () => {
    const platform = createFakePlatform();

    await platform.config.update('texra.files.exclude', ['dist']);
    await platform.config.update('files.exclude', ['node_modules']);

    assert.deepEqual(platform.config.get('files.exclude', []), [
      'node_modules',
    ]);
    assert.deepEqual(platform.config.get('texra.files.exclude', []), ['dist']);

    await platform.config.update('files.exclude', undefined);

    assert.deepEqual(platform.config.get('files.exclude', []), ['dist']);
    assert.equal(platform.config.isExplicitlySet('texra.files.exclude'), true);
  });

  it('supports custom overrides while retaining other fakes', () => {
    const fs = new FakeFileSystemProvider();
    const platform = createFakePlatform({}, { fs });

    assert.equal(platform.fs, fs);
    assert.ok(platform.config);
    assert.ok(platform.secrets);
  });

  it('keeps fake-only convenience helpers backed by the provider', async () => {
    const fakeFs = new FakeFileSystemProvider();

    fakeFs.setFile('/workspace/missing/a.txt', 'seed');
    await fakeFs.writeFile('/workspace/missing/a.txt', Buffer.from('updated'));

    assert.equal(fakeFs.exists('/workspace/missing/a.txt'), true);
    assert.equal(fakeFs.getText('/workspace/missing/a.txt'), 'updated');
  });

  it('matches node filesystem semantics for file reads, writes, stats, and directories', async () => {
    await withProviders(async ({ provider, resolve, expectedRealPath }) => {
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

  it('matches node filesystem semantics for copy, rename, and delete', async () => {
    await withProviders(async ({ provider, resolve }) => {
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

  it('matches node filesystem error codes for common failures', async () => {
    await withProviders(async ({ provider, resolve }) => {
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

  it('rejects deleting the fake filesystem root', async () => {
    const fakeFs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await rejectsWithCode(
      () => fakeFs.delete('/', { recursive: true }),
      'EPERM',
    );

    assert.equal(fakeFs.getText('/workspace/source/a.txt'), 'A');
  });
});
