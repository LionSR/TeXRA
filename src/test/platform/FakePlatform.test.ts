// Standard library imports
import { strict as assert } from 'assert';

// Local imports - platform
import { FileType } from '@platform/interfaces/filesystem';

// Local imports - test support
import {
  FakeFileSystemProvider,
  RecordingLogBackend,
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

  it('records log entries and supports custom overrides', () => {
    const log = new RecordingLogBackend();
    const fs = new FakeFileSystemProvider();
    const platform = createFakePlatform({}, { fs, log });

    platform.log.initialize('TeXRA');
    platform.log.info('TeXRA', 'ready', { data: { count: 1 } });

    assert.equal(platform.fs, fs);
    assert.deepEqual(log.initializedChannels, [
      { channel: 'TeXRA', isAgent: undefined },
    ]);
    assert.deepEqual(log.entries, [
      {
        level: 'info',
        channel: 'TeXRA',
        message: 'ready',
        options: { data: { count: 1 } },
      },
    ]);
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
});
