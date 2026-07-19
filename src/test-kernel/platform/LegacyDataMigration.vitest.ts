// Node imports
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import {
  mergeLegacyStorageBucket,
  mergeLegacyWorkspaceStorageBucket,
  moveEntryIfAbsent,
} from '@platform/defaults/legacyDataMigration';
import type { LegacyDataMigrationLogger } from '@platform/defaults/legacyDataMigration';
import { cleanupTempDirs } from '@test/support/tempDirPlatform';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function fakeLogger(): LegacyDataMigrationLogger & {
  infoMessages: string[];
  warnMessages: string[];
} {
  const infoMessages: string[] = [];
  const warnMessages: string[] = [];
  return {
    infoMessages,
    warnMessages,
    info: (message) => infoMessages.push(message),
    warn: (message) => warnMessages.push(message),
  };
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe('mergeLegacyStorageBucket (#8622 vscode → ~/.texra migration)', () => {
  it('is a no-op when the legacy bucket does not exist', async () => {
    const target = await makeTempDir('texra-bucket-target-fresh-');
    const logger = fakeLogger();

    await mergeLegacyStorageBucket(join(target, 'missing'), target, {
      mergePerChild: ['executions'],
      label: 'test',
      logger,
    });

    expect(logger.infoMessages).toEqual([]);
    expect(logger.warnMessages).toEqual([]);
  });

  it('moves whole entries into an empty target bucket', async () => {
    const legacy = await makeTempDir('texra-bucket-legacy-');
    const target = await makeTempDir('texra-bucket-target-');
    const logger = fakeLogger();

    await mkdir(join(legacy, 'executions', 'run-a'), { recursive: true });
    await writeFile(join(legacy, 'executions', 'run-a', 'meta.json'), '{}');
    await mkdir(join(legacy, 'memories'), { recursive: true });
    await writeFile(join(legacy, 'memories', 'note.md'), 'note');

    await mergeLegacyStorageBucket(legacy, target, {
      mergePerChild: ['executions'],
      label: 'test',
      logger,
    });

    await expect(
      pathExists(join(target, 'executions', 'run-a', 'meta.json')),
    ).resolves.toBe(true);
    await expect(pathExists(join(target, 'memories', 'note.md'))).resolves.toBe(
      true,
    );
    await expect(pathExists(join(legacy, 'executions'))).resolves.toBe(false);
    expect(logger.warnMessages).toEqual([]);
  });

  it('merges id-keyed collections per child when the target already has runs', async () => {
    const legacy = await makeTempDir('texra-bucket-legacy-merge-');
    const target = await makeTempDir('texra-bucket-target-merge-');
    const logger = fakeLogger();

    // Target bucket already holds a CLI-written run.
    await mkdir(join(target, 'executions', 'run-cli'), { recursive: true });
    await writeFile(join(target, 'executions', 'run-cli', 'meta.json'), '{}');
    // Legacy bucket holds an extension-written run with a distinct id.
    await mkdir(join(legacy, 'executions', 'run-ext'), { recursive: true });
    await writeFile(join(legacy, 'executions', 'run-ext', 'meta.json'), '{}');

    await mergeLegacyStorageBucket(legacy, target, {
      mergePerChild: ['executions'],
      label: 'test',
      logger,
    });

    await expect(
      pathExists(join(target, 'executions', 'run-cli', 'meta.json')),
    ).resolves.toBe(true);
    await expect(
      pathExists(join(target, 'executions', 'run-ext', 'meta.json')),
    ).resolves.toBe(true);
    expect(logger.warnMessages).toEqual([]);
  });

  it('never clobbers a colliding target entry and keeps the legacy copy', async () => {
    const legacy = await makeTempDir('texra-bucket-legacy-collide-');
    const target = await makeTempDir('texra-bucket-target-collide-');
    const logger = fakeLogger();

    await mkdir(join(legacy, 'memories'), { recursive: true });
    await writeFile(join(legacy, 'memories', 'note.md'), 'legacy');
    await mkdir(join(target, 'memories'), { recursive: true });
    await writeFile(join(target, 'memories', 'note.md'), 'target');

    await mergeLegacyStorageBucket(legacy, target, {
      mergePerChild: ['executions'],
      label: 'test',
      logger,
    });

    await expect(
      readFile(join(target, 'memories', 'note.md'), 'utf8'),
    ).resolves.toBe('target');
    await expect(
      readFile(join(legacy, 'memories', 'note.md'), 'utf8'),
    ).resolves.toBe('legacy');
    expect(logger.warnMessages).toHaveLength(1);
  });
});

describe('mergeLegacyWorkspaceStorageBucket', () => {
  it('merges every shared workspace collection per child', async () => {
    const legacy = await makeTempDir('texra-workspace-legacy-');
    const target = await makeTempDir('texra-workspace-target-');
    const logger = fakeLogger();
    const collections = [
      'executions',
      'taskRuns',
      'streamData',
      'streamLogs',
      'memories',
    ];

    for (const collection of collections) {
      await mkdir(join(legacy, collection, 'legacy-child'), {
        recursive: true,
      });
      await mkdir(join(target, collection, 'shared-child'), {
        recursive: true,
      });
    }

    await mergeLegacyWorkspaceStorageBucket(legacy, target, {
      label: 'workspace-test',
      logger,
    });

    for (const collection of collections) {
      await expect(
        pathExists(join(target, collection, 'legacy-child')),
      ).resolves.toBe(true);
      await expect(
        pathExists(join(target, collection, 'shared-child')),
      ).resolves.toBe(true);
    }
    expect(logger.warnMessages).toEqual([]);
  });
});

describe('moveEntryIfAbsent', () => {
  it('moves files as well as directories', async () => {
    const legacy = await makeTempDir('texra-move-legacy-');
    const target = await makeTempDir('texra-move-target-');
    const logger = fakeLogger();

    await writeFile(join(legacy, 'state.json'), '{"a":1}');

    await moveEntryIfAbsent(
      join(legacy, 'state.json'),
      join(target, 'nested', 'state.json'),
      'state.json',
      logger,
    );

    await expect(
      readFile(join(target, 'nested', 'state.json'), 'utf8'),
    ).resolves.toBe('{"a":1}');
    expect(logger.infoMessages).toHaveLength(1);
  });

  it('does not overwrite a file created by a concurrent migration', async () => {
    const legacy = await makeTempDir('texra-move-race-legacy-');
    const target = await makeTempDir('texra-move-race-target-');
    const logger = fakeLogger();
    const first = join(legacy, 'first.md');
    const second = join(legacy, 'second.md');
    const destination = join(target, 'memories', 'note.md');
    await writeFile(first, 'first');
    await writeFile(second, 'second');

    await Promise.all([
      moveEntryIfAbsent(first, destination, 'first', logger),
      moveEntryIfAbsent(second, destination, 'second', logger),
    ]);

    const targetContent = await readFile(destination, 'utf8');
    expect(['first', 'second']).toContain(targetContent);
    const losingSource = targetContent === 'first' ? second : first;
    await expect(readFile(losingSource, 'utf8')).resolves.toBe(
      targetContent === 'first' ? 'second' : 'first',
    );
    expect(logger.warnMessages).toHaveLength(1);
  });
});
