// Standard library imports
import { strict as assert } from 'assert';

// Local imports - platform
import { FileType } from '@platform/interfaces/filesystem';

// Local imports - test support
import {
  FakeFileSystemProvider,
  createFakePlatform,
} from '../support/FakePlatform';

describe('FakePlatform', () => {
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

  it('supports fake config updates and watchers', async () => {
    const platform = createFakePlatform({
      config: { enabled: true },
    });
    let changes = 0;
    const subscription = platform.config.watch('enabled', () => {
      changes += 1;
    });

    await platform.config.update('enabled', false, 'global');
    subscription.dispose();
    await platform.config.update('enabled', true, 'global');

    assert.equal(platform.config.get('enabled', true), true);
    assert.equal(platform.config.isExplicitlySet('enabled'), true);
    assert.deepEqual(platform.config.inspect('enabled'), {
      globalValue: true,
      workspaceValue: undefined,
      effectiveValue: true,
    });
    assert.equal(changes, 1);
  });

  it('mirrors texra config aliases and nested watcher matching', async () => {
    const platform = createFakePlatform();
    let changes = 0;
    const subscription = platform.config.watch('files', () => {
      changes += 1;
    });

    await platform.config.update('texra.files.exclude', ['node_modules']);
    subscription.dispose();
    await platform.config.update('texra.files.include', ['src']);

    assert.deepEqual(platform.config.get('files.exclude', []), [
      'node_modules',
    ]);
    assert.equal(platform.config.isExplicitlySet('files.exclude'), true);
    assert.deepEqual(platform.config.inspect('files.exclude'), {
      globalValue: undefined,
      workspaceValue: ['node_modules'],
      effectiveValue: ['node_modules'],
    });
    assert.equal(changes, 1);
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

  it('does not notify texra watchers for unprefixed config changes', async () => {
    const platform = createFakePlatform();
    let changes = 0;

    platform.config.watch('texra.files', () => {
      changes += 1;
    });

    await platform.config.update('files.exclude', ['node_modules']);
    await platform.config.update('texra.files.include', ['src']);

    assert.equal(changes, 1);
  });

  it('supports custom overrides while retaining other fakes', () => {
    const fs = new FakeFileSystemProvider();
    const platform = createFakePlatform({}, { fs });

    assert.equal(platform.fs, fs);
    assert.ok(platform.config);
    assert.ok(platform.secrets);
  });

  it('implements in-memory filesystem operations', async () => {
    const fs = new FakeFileSystemProvider();

    await fs.createDirectory('/workspace/docs');
    await fs.writeFile('/workspace/docs/a.txt', Buffer.from('A'));
    await fs.copy('/workspace/docs/a.txt', '/workspace/docs/b.txt');
    await fs.rename('/workspace/docs/b.txt', '/workspace/docs/c.txt');

    assert.equal(fs.exists('/workspace/docs/b.txt'), false);
    assert.equal(fs.getText('/workspace/docs/c.txt'), 'A');
    assert.deepEqual(await fs.readDirectory('/workspace/docs'), [
      ['a.txt', FileType.File],
      ['c.txt', FileType.File],
    ]);

    const stat = await fs.stat('/workspace/docs');
    assert.equal(stat.type, FileType.Directory);
  });

  it('preserves file timestamps when renaming files', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/docs/a.txt': 'A',
    });
    const records = (
      fs as unknown as {
        records: Map<string, { type: number; ctime: number; mtime: number }>;
      }
    ).records;
    const sourceRecord = records.get('/workspace/docs/a.txt');
    assert.ok(sourceRecord);
    sourceRecord.ctime = 1;
    sourceRecord.mtime = 2;

    await fs.rename('/workspace/docs/a.txt', '/workspace/docs/b.txt');

    const renamed = await fs.stat('/workspace/docs/b.txt');
    assert.equal(renamed.ctime, 1);
    assert.equal(renamed.mtime, 2);
  });

  it('matches real writeFile parent directory semantics', async () => {
    const fs = new FakeFileSystemProvider();

    await assert.rejects(
      () => fs.writeFile('/workspace/missing/a.txt', Buffer.from('A')),
      /Parent directory not found/,
    );

    fs.setFile('/workspace/missing/a.txt', 'seed');
    await fs.writeFile('/workspace/missing/a.txt', Buffer.from('updated'));

    assert.equal(fs.getText('/workspace/missing/a.txt'), 'updated');
  });

  it('rejects directory operations into self descendants', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await assert.rejects(
      () => fs.copy('/workspace/source', '/workspace/source/nested'),
      /Cannot copy a directory into itself/,
    );
    await assert.rejects(
      () => fs.rename('/workspace/source', '/workspace/source/nested'),
      /Cannot rename a directory into itself/,
    );

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
    assert.equal(fs.exists('/workspace/source/nested'), false);
  });

  it('rejects directory rename over non-empty targets', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
      '/workspace/dest/existing.txt': 'B',
    });

    await assert.rejects(
      () =>
        fs.rename('/workspace/source', '/workspace/dest', { overwrite: true }),
      /Directory is not empty/,
    );

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
    assert.equal(fs.getText('/workspace/dest/existing.txt'), 'B');
  });

  it('rejects directory rename when destination parent is missing', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await assert.rejects(
      () =>
        fs.rename('/workspace/source', '/workspace/missing/dest', {
          overwrite: true,
        }),
      /Parent directory not found/,
    );

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
    assert.equal(fs.exists('/workspace/missing'), false);
  });

  it('creates missing destination parents when copying directories', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await fs.copy('/workspace/source', '/workspace/missing/dest', {
      overwrite: true,
    });

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
    assert.equal(fs.getText('/workspace/missing/dest/a.txt'), 'A');
  });

  it('rejects directory copy onto itself with overwrite', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await assert.rejects(
      () =>
        fs.copy('/workspace/source', '/workspace/source', {
          overwrite: true,
        }),
      /Cannot copy a directory onto itself/,
    );

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
  });

  it('copies directories into existing destination directories', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
      '/workspace/dest/existing.txt': 'existing',
    });

    await fs.copy('/workspace/source', '/workspace/dest');

    assert.equal(fs.getText('/workspace/dest/a.txt'), 'A');
    assert.equal(fs.getText('/workspace/dest/existing.txt'), 'existing');
  });

  it('assigns fresh timestamps when copying directory children', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
      '/workspace/source/nested/b.txt': 'B',
    });
    const records = (
      fs as unknown as {
        records: Map<string, { type: number; ctime: number; mtime: number }>;
      }
    ).records;
    for (const record of records.values()) {
      record.ctime = 1;
      record.mtime = 1;
    }

    await fs.copy('/workspace/source', '/workspace/dest');

    assert.equal((await fs.stat('/workspace/dest/a.txt')).mtime > 1, true);
    assert.equal((await fs.stat('/workspace/dest/nested')).mtime > 1, true);
    assert.equal(
      (await fs.stat('/workspace/dest/nested/b.txt')).mtime > 1,
      true,
    );
  });

  it('rejects directory copy when a destination file already exists', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
      '/workspace/dest/a.txt': 'existing',
    });

    await assert.rejects(
      () => fs.copy('/workspace/source', '/workspace/dest'),
      /Target already exists/,
    );

    assert.equal(fs.getText('/workspace/dest/a.txt'), 'existing');
  });

  it('keeps earlier directory copy writes when a later child fails', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
      '/workspace/source/z.txt': 'Z',
      '/workspace/dest/z.txt': 'existing',
    });

    await assert.rejects(
      () => fs.copy('/workspace/source', '/workspace/dest'),
      /Target already exists/,
    );

    assert.equal(fs.getText('/workspace/dest/a.txt'), 'A');
    assert.equal(fs.getText('/workspace/dest/z.txt'), 'existing');
  });

  it('rejects file copy onto itself with overwrite', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await assert.rejects(
      () =>
        fs.copy('/workspace/source/a.txt', '/workspace/source/a.txt', {
          overwrite: true,
        }),
      /Cannot copy a file onto itself/,
    );

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
  });

  it('rejects same-path rename when the source is missing', async () => {
    const fs = new FakeFileSystemProvider();

    await assert.rejects(
      () => fs.rename('/workspace/missing.txt', '/workspace/missing.txt'),
      /File not found/,
    );
  });

  it('rejects deleting the filesystem root', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await assert.rejects(
      () => fs.delete('/', { recursive: true }),
      /Cannot delete filesystem root/,
    );

    assert.equal(fs.getText('/workspace/source/a.txt'), 'A');
  });

  it('reports implicit readDirectory path prefixes as directories', async () => {
    const fs = new FakeFileSystemProvider();
    await fs.createDirectory('/workspace');
    const records = (
      fs as unknown as {
        records: Map<
          string,
          { type: number; ctime: number; mtime: number; content?: Uint8Array }
        >;
      }
    ).records;
    records.set('/workspace/implicit/file.txt', {
      type: FileType.File,
      ctime: Date.now(),
      mtime: Date.now(),
      content: Buffer.from('A'),
    });

    assert.deepEqual(await fs.readDirectory('/workspace'), [
      ['implicit', FileType.Directory],
    ]);
  });

  it('rejects directory copy when a destination file blocks a source directory', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/item/a.txt': 'A',
      '/workspace/dest/item': 'existing file',
    });

    await assert.rejects(
      () =>
        fs.copy('/workspace/source', '/workspace/dest', { overwrite: true }),
      /Path is a file/,
    );

    assert.equal(fs.getText('/workspace/source/item/a.txt'), 'A');
    assert.equal(fs.getText('/workspace/dest/item'), 'existing file');
    assert.equal(fs.exists('/workspace/dest/item/a.txt'), false);
  });

  it('rejects directory copy when a destination directory blocks a source file', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/item': 'source file',
      '/workspace/dest/item/existing.txt': 'existing nested file',
    });

    await assert.rejects(
      () =>
        fs.copy('/workspace/source', '/workspace/dest', { overwrite: true }),
      /Path is a directory/,
    );

    assert.equal(fs.getText('/workspace/source/item'), 'source file');
    assert.equal(
      fs.getText('/workspace/dest/item/existing.txt'),
      'existing nested file',
    );
  });
});
