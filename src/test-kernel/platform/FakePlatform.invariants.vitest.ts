// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - platform
import { FileType } from '@platform/interfaces/filesystem';

// Local imports - test support
import {
  FakeFileSystemProvider,
  RecordingLogBackend,
  createFakePlatform,
} from '@test/support/FakePlatform';

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

async function expectRejectsWithoutChangingFiles(
  fs: FakeFileSystemProvider,
  operation: () => Promise<unknown>,
  error: RegExp,
  expectedFiles: Record<string, string>,
): Promise<void> {
  await expect(operation()).rejects.toThrow(error);
  for (const [filePath, content] of Object.entries(expectedFiles)) {
    expect(fs.getText(filePath)).toBe(content);
  }
}

const directorySelfDescendantCases = [
  {
    name: 'copy',
    operation: (fs: FakeFileSystemProvider) =>
      fs.copy('/workspace/source', '/workspace/source/nested'),
    error: /Cannot copy a directory into itself/,
  },
  {
    name: 'rename',
    operation: (fs: FakeFileSystemProvider) =>
      fs.rename('/workspace/source', '/workspace/source/nested'),
    error: /Cannot rename a directory into itself/,
  },
] as const;

describe('FakePlatform kernel invariants', () => {
  it('provides host-neutral platform services from seed data', async () => {
    const platform = createFakePlatform({
      config: { enabled: true },
      globalState: { version: 2 },
      workspaceState: { task: 'active' },
      files: { '/workspace/src/main.tex': 'hello' },
      secrets: { token: 'secret-value' },
    });

    expect(platform.config.get('enabled', false)).toBe(true);
    expect(platform.globalState.get('version', 0)).toBe(2);
    expect(platform.workspaceState.get('task', 'idle')).toBe('active');
    expect(platform.workspace.asRelativePath('/workspace/src/main.tex')).toBe(
      'src/main.tex',
    );
    expect(platform.workspace.asRelativePath('/workspace')).toBe('');
    expect(platform.storage.getStoragePath()).toBe('/workspace/.texra/storage');
    expect(await platform.secrets.get('token')).toBe('secret-value');
    expect(utf8(await platform.fs.readFile('/workspace/src/main.tex'))).toBe(
      'hello',
    );
  });

  it('models absent workspace roots with stable path fallbacks', () => {
    const platform = createFakePlatform({ workspacePath: undefined });

    expect(platform.workspace.getWorkspacePath()).toBeUndefined();
    expect(platform.workspace.asRelativePath('/outside/main.tex')).toBe(
      '/outside/main.tex',
    );
  });

  it('preserves config alias lookup and watcher semantics', async () => {
    const platform = createFakePlatform();
    let changes = 0;
    const subscription = platform.config.watch('files', () => {
      changes += 1;
    });

    await platform.config.update('texra.files.exclude', ['node_modules']);
    subscription.dispose();
    await platform.config.update('texra.files.include', ['src']);

    expect(platform.config.get('files.exclude', [])).toEqual(['node_modules']);
    expect(platform.config.isExplicitlySet('files.exclude')).toBe(true);
    expect(platform.config.inspect('files.exclude')).toEqual({
      globalValue: undefined,
      workspaceValue: ['node_modules'],
      effectiveValue: ['node_modules'],
    });
    expect(changes).toBe(1);
  });

  it('writes config aliases to the exact caller key', async () => {
    const platform = createFakePlatform();

    await platform.config.update('texra.files.exclude', ['dist']);
    await platform.config.update('files.exclude', ['node_modules']);

    expect(platform.config.get('files.exclude', [])).toEqual(['node_modules']);
    expect(platform.config.get('texra.files.exclude', [])).toEqual(['dist']);

    await platform.config.update('files.exclude', undefined);

    expect(platform.config.get('files.exclude', [])).toEqual(['dist']);
    expect(platform.config.isExplicitlySet('texra.files.exclude')).toBe(true);
  });

  it('does not notify texra watchers for unprefixed config changes', async () => {
    const platform = createFakePlatform();
    let changes = 0;

    platform.config.watch('texra.files', () => {
      changes += 1;
    });

    await platform.config.update('files.exclude', ['node_modules']);
    await platform.config.update('texra.files.include', ['src']);

    expect(changes).toBe(1);
  });

  it('supports custom service overrides while retaining other fakes', () => {
    const log = new RecordingLogBackend();
    const fs = new FakeFileSystemProvider();
    const platform = createFakePlatform({}, { fs, log });

    platform.log.initialize('TeXRA');
    platform.log.info('TeXRA', 'ready');

    expect(platform.fs).toBe(fs);
    expect(log.initializedChannels).toEqual([
      { channel: 'TeXRA', isAgent: undefined },
    ]);
    expect(log.entries).toEqual([
      {
        level: 'info',
        channel: 'TeXRA',
        message: 'ready',
      },
    ]);
  });

  it('rejects file writes when parent directories are missing', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
    });

    await expect(
      fs.writeFile('/workspace/missing/a.txt', Buffer.from('A')),
    ).rejects.toThrow(/Parent directory not found/);
  });

  it.each(directorySelfDescendantCases)(
    'rejects directory $name into its own descendant without changing files',
    async ({ operation, error }) => {
      const fs = new FakeFileSystemProvider({
        '/workspace/source/a.txt': 'A',
      });

      await expectRejectsWithoutChangingFiles(fs, () => operation(fs), error, {
        '/workspace/source/a.txt': 'A',
      });
    },
  );

  it('matches core filesystem directory creation semantics', async () => {
    const fs = new FakeFileSystemProvider();
    await fs.createDirectory('/workspace/docs');
    await fs.writeFile('/workspace/docs/a.txt', Buffer.from('A'));

    expect(await fs.readDirectory('/workspace/docs')).toEqual([
      ['a.txt', FileType.File],
    ]);
  });

  it('preserves file timestamps when renaming files', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const fs = new FakeFileSystemProvider({
        '/workspace/docs/a.txt': 'A',
      });
      const source = await fs.stat('/workspace/docs/a.txt');

      vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
      await fs.rename('/workspace/docs/a.txt', '/workspace/docs/b.txt');

      const renamed = await fs.stat('/workspace/docs/b.txt');

      expect(renamed.ctime).toBe(source.ctime);
      expect(renamed.mtime).toBe(source.mtime);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects directory rename over non-empty targets', async () => {
    const fs = new FakeFileSystemProvider({
      '/workspace/source/a.txt': 'A',
      '/workspace/dest/existing.txt': 'B',
    });

    await expectRejectsWithoutChangingFiles(
      fs,
      () =>
        fs.rename('/workspace/source', '/workspace/dest', { overwrite: true }),
      /Directory is not empty/,
      {
        '/workspace/source/a.txt': 'A',
        '/workspace/dest/existing.txt': 'B',
      },
    );
  });
});
