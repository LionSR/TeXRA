import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DesktopWebviewStateStore,
  desktopWebviewStatePath,
} from '@desktop/main/desktopWebviewStateStore';

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'texra-webview-state-'));
  tempDirs.push(root);
  return join(root, 'state.json');
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('desktop webview state store', () => {
  it('restores through a new main-process store instance', async () => {
    const file = await tempFile();
    const firstProcess = new DesktopWebviewStateStore(file);
    firstProcess.setState({ followUpDrafts: { text: 'continue' } });

    const recreatedProcess = new DesktopWebviewStateStore(file);

    expect(recreatedProcess.getState()).toEqual({
      followUpDrafts: { text: 'continue' },
    });
  });

  it('keeps logical workspace windows in separate user-data files', () => {
    expect(desktopWebviewStatePath('/user-data', '/workspace/a')).not.toBe(
      desktopWebviewStatePath('/user-data', '/workspace/b'),
    );
    expect(desktopWebviewStatePath('/user-data', '/workspace/a')).toBe(
      desktopWebviewStatePath('/user-data', '/workspace/a'),
    );
  });

  it('keeps the previous atomic snapshot when a replacement is oversized', async () => {
    const file = await tempFile();
    const store = new DesktopWebviewStateStore(file);
    store.setState({ draft: 'known-good' });

    expect(() =>
      store.setState({ draft: 'A'.repeat(4 * 1024 * 1024 + 1) }),
    ).toThrow('Desktop webview state could not be persisted.');

    expect(new DesktopWebviewStateStore(file).getState()).toEqual({
      draft: 'known-good',
    });
  });

  it('quarantines oversized serialized state before JSON.parse', async () => {
    const file = await tempFile();
    await writeFile(file, `{"draft":"${'A'.repeat(4 * 1024 * 1024)}"}`);
    const parse = vi.spyOn(JSON, 'parse');

    expect(new DesktopWebviewStateStore(file).getState()).toBeUndefined();

    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.invalid`)).toBe(true);
  });

  it('quarantines malformed state without exposing its payload', async () => {
    const file = await tempFile();
    await writeFile(file, '{');

    expect(new DesktopWebviewStateStore(file).getState()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.invalid`)).toBe(true);
  });
});
