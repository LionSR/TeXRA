// Persistent ↑/↓ + Ctrl-R input history for the chat TUI input bar.

import { describe, expect, it } from 'vitest';

import { loadInputHistory } from '@cli/chat/tui/history/inputHistory';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

describe('CLI TUI input history', () => {
  // GlobalStorageFS resolves paths through the platform but writes with the
  // real node fs, so the fake platform needs a real temp directory.
  setupPlatform(async () =>
    createFakePlatform(
      {
        globalStoragePath: await makeTempDir('texra-input-history-', tempDirs),
      },
      { fs: nodeFilesystem },
    ),
  );

  it('exposes indexed entries for ↑/↓ history browsing', async () => {
    const history = await loadInputHistory();

    expect(history.length()).toBe(0);
    expect(history.at(0)).toBeUndefined();

    await history.push('first message');
    await history.push('second message');

    expect(history.length()).toBe(2);
    expect(history.at(0)).toBe('first message');
    expect(history.at(1)).toBe('second message');
    expect(history.at(2)).toBeUndefined();
  });

  it('persists entries across loads and skips adjacent duplicates', async () => {
    const history = await loadInputHistory();
    await history.push('alpha');
    await history.push('alpha');
    await history.push('beta');

    const reloaded = await loadInputHistory();

    expect(reloaded.length()).toBe(2);
    expect(reloaded.at(0)).toBe('alpha');
    expect(reloaded.at(1)).toBe('beta');
  });

  it('reverse-finds the most recent matching entry first', async () => {
    const history = await loadInputHistory();
    await history.push('build the project');
    await history.push('run the tests');
    await history.push('build the docs');

    const newest = history.reverseFind('build');
    expect(newest).toEqual({ value: 'build the docs', index: 2 });

    const older = history.reverseFind('build', newest?.index);
    expect(older).toEqual({ value: 'build the project', index: 0 });
  });
});
