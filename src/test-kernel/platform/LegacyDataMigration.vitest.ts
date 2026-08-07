// Node imports
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import {
  mergeLegacyStorageBucket,
  mergeLegacyWorkspaceStorageBucket,
  moveEntryIfAbsent,
} from '@platform/defaults/legacyDataMigration';
import type { LegacyDataMigrationLogger } from '@platform/defaults/legacyDataMigration';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Writes `relativePath: contents` files under `root`, creating parents. */
async function writeEntries(
  root: string,
  entries: Record<string, string>,
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(entries)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function expectFileContents(
  path: string,
  contents: string,
): Promise<void> {
  await expect(readFile(path, 'utf8')).resolves.toBe(contents);
}

async function expectPathExists(path: string): Promise<void> {
  await expect(pathExists(path)).resolves.toBe(true);
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(pathExists(path)).resolves.toBe(false);
}

async function mergeExecutionsBucket(
  legacy: string,
  target: string,
  logger: LegacyDataMigrationLogger,
): Promise<void> {
  await mergeLegacyStorageBucket(legacy, target, {
    mergePerChild: ['executions'],
    label: 'test',
    logger,
  });
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

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe('mergeLegacyStorageBucket (#8622 vscode → ~/.texra migration)', () => {
  it('is a no-op when the legacy bucket does not exist', async () => {
    const target = await makeTempDir('texra-bucket-target-fresh-', tempDirs);
    const logger = fakeLogger();

    await mergeExecutionsBucket(join(target, 'missing'), target, logger);

    expect(logger.infoMessages).toEqual([]);
    expect(logger.warnMessages).toEqual([]);
  });

  it('moves whole entries into an empty target bucket', async () => {
    const legacy = await makeTempDir('texra-bucket-legacy-', tempDirs);
    const target = await makeTempDir('texra-bucket-target-', tempDirs);
    const logger = fakeLogger();
    await writeEntries(legacy, {
      'executions/run-a/meta.json': '{}',
      'memories/note.md': 'note',
    });

    await mergeExecutionsBucket(legacy, target, logger);

    await expectPathExists(join(target, 'executions', 'run-a', 'meta.json'));
    await expectPathExists(join(target, 'memories', 'note.md'));
    await expectPathMissing(join(legacy, 'executions'));
    expect(logger.warnMessages).toEqual([]);
  });

  it('merges id-keyed collections per child when the target already has runs', async () => {
    const legacy = await makeTempDir('texra-bucket-legacy-merge-', tempDirs);
    const target = await makeTempDir('texra-bucket-target-merge-', tempDirs);
    const logger = fakeLogger();
    // Target bucket already holds a CLI-written run; the legacy bucket holds
    // an extension-written run with a distinct id.
    await writeEntries(target, { 'executions/run-cli/meta.json': '{}' });
    await writeEntries(legacy, { 'executions/run-ext/meta.json': '{}' });

    await mergeExecutionsBucket(legacy, target, logger);

    await expectPathExists(join(target, 'executions', 'run-cli', 'meta.json'));
    await expectPathExists(join(target, 'executions', 'run-ext', 'meta.json'));
    expect(logger.warnMessages).toEqual([]);
  });

  it('never clobbers a colliding target entry and keeps the legacy copy', async () => {
    const legacy = await makeTempDir('texra-bucket-legacy-collide-', tempDirs);
    const target = await makeTempDir('texra-bucket-target-collide-', tempDirs);
    const logger = fakeLogger();
    await writeEntries(legacy, { 'memories/note.md': 'legacy' });
    await writeEntries(target, { 'memories/note.md': 'target' });

    await mergeExecutionsBucket(legacy, target, logger);

    await expectFileContents(join(target, 'memories', 'note.md'), 'target');
    await expectFileContents(join(legacy, 'memories', 'note.md'), 'legacy');
    expect(logger.warnMessages).toHaveLength(1);
  });

  it('merges colliding taskRuns without overwriting canonical execution files', async () => {
    const legacy = await makeTempDir('texra-task-runs-', tempDirs);
    const target = await makeTempDir('texra-executions-', tempDirs);
    const logger = fakeLogger();
    const executionId = 'execution-1';
    const legacyRun = join(legacy, executionId);
    const canonicalRun = join(target, executionId);
    await writeEntries(legacyRun, {
      'result.json': 'legacy',
      'artifact.txt': 'artifact',
      'r1/output.tex': 'legacy output',
      'r1/diff.pdf': 'legacy diff',
    });
    await writeEntries(canonicalRun, {
      'result.json': 'canonical',
      'r1/output.tex': 'canonical output',
    });

    await mergeLegacyStorageBucket(legacy, target, {
      mergePerChild: 'all',
      label: 'taskRuns',
      logger,
    });

    await expectFileContents(join(canonicalRun, 'result.json'), 'canonical');
    await expectFileContents(join(canonicalRun, 'artifact.txt'), 'artifact');
    await expectFileContents(
      join(canonicalRun, 'r1', 'output.tex'),
      'canonical output',
    );
    await expectFileContents(
      join(canonicalRun, 'r1', 'diff.pdf'),
      'legacy diff',
    );
    await expectFileContents(join(legacyRun, 'result.json'), 'legacy');
    await expectFileContents(
      join(legacyRun, 'r1', 'output.tex'),
      'legacy output',
    );
  });
});

describe('mergeLegacyWorkspaceStorageBucket', () => {
  it('merges every shared workspace collection per child', async () => {
    const legacy = await makeTempDir('texra-workspace-legacy-', tempDirs);
    const target = await makeTempDir('texra-workspace-target-', tempDirs);
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
      await expectPathExists(join(target, collection, 'legacy-child'));
      await expectPathExists(join(target, collection, 'shared-child'));
    }
    expect(logger.warnMessages).toEqual([]);
  });
});

describe('moveEntryIfAbsent', () => {
  it('moves files as well as directories', async () => {
    const legacy = await makeTempDir('texra-move-legacy-', tempDirs);
    const target = await makeTempDir('texra-move-target-', tempDirs);
    const logger = fakeLogger();

    await writeFile(join(legacy, 'state.json'), '{"a":1}');

    await moveEntryIfAbsent(
      join(legacy, 'state.json'),
      join(target, 'nested', 'state.json'),
      'state.json',
      logger,
    );

    await expectFileContents(join(target, 'nested', 'state.json'), '{"a":1}');
    expect(logger.infoMessages).toHaveLength(1);
  });

  it('does not overwrite a file created by a concurrent migration', async () => {
    const legacy = await makeTempDir('texra-move-race-legacy-', tempDirs);
    const target = await makeTempDir('texra-move-race-target-', tempDirs);
    const logger = fakeLogger();
    const first = join(legacy, 'first.md');
    const second = join(legacy, 'second.md');
    const destination = join(target, 'memories', 'note.md');
    await writeEntries(legacy, { 'first.md': 'first', 'second.md': 'second' });

    await Promise.all([
      moveEntryIfAbsent(first, destination, 'first', logger),
      moveEntryIfAbsent(second, destination, 'second', logger),
    ]);

    const targetContent = await readFile(destination, 'utf8');
    expect(['first', 'second']).toContain(targetContent);
    const losingSource = targetContent === 'first' ? second : first;
    await expectFileContents(
      losingSource,
      targetContent === 'first' ? 'second' : 'first',
    );
    expect(logger.warnMessages).toHaveLength(1);
  });
});
