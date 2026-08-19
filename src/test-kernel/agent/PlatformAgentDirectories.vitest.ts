// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { platform } from '@platform/platform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { GlobalStorageFS } from '@utils/files/storageFS';

const SYNC_MARKER_FILE = '.bundled-agent-sync.json';
const VERSION_STATE_KEY = 'lastKnownVersion';

const logs = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return { ...actual, createLog: () => logs };
});

const { bootstrapPlatformAgentDirectories } =
  await import('@agent/index/platformAgentDirectories');

function elocked(message: string): Error {
  return Object.assign(new Error(message), { code: 'ELOCKED' });
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('bootstrapPlatformAgentDirectories', () => {
  const tempDirs = useTempDirs();
  let resourcesPath: string;

  setupPlatform(() => createTempDirPlatform('texra-agent-sync-', tempDirs));

  beforeEach(async () => {
    vi.clearAllMocks();
    resourcesPath = join(
      await makeTempDir('texra-agent-bundle-', tempDirs),
      'resources',
    );
    await Promise.all([
      writeText(join(resourcesPath, 'agents', 'writer.yaml'), 'name: writer\n'),
      writeText(
        join(resourcesPath, 'tool_use_agents', 'researcher.yaml'),
        'name: researcher\n',
      ),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function bootstrap(currentVersion: string | undefined = '1.0.0') {
    return bootstrapPlatformAgentDirectories({
      channel: 'test',
      resourcesPath,
      currentVersion,
      versionStateKey: VERSION_STATE_KEY,
    });
  }

  it('serializes concurrent copies into the same storage root', async () => {
    const copied: string[] = [];
    let activeCopies = 0;
    let maxActiveCopies = 0;

    vi.spyOn(platform().fs, 'copy').mockImplementation(
      async (source, destination) => {
        activeCopies += 1;
        maxActiveCopies = Math.max(maxActiveCopies, activeCopies);
        try {
          await sleep(20);
          await writeText(join(destination, 'agent.yaml'), 'name: agent\n');
          copied.push(basename(source));
        } finally {
          activeCopies -= 1;
        }
      },
    );

    const results = await Promise.all([bootstrap(), bootstrap(), bootstrap()]);

    expect(results).toEqual([true, true, true]);
    expect(maxActiveCopies).toBe(1);
    expect(copied).toEqual([
      'agents',
      'tool_use_agents',
      'agents',
      'tool_use_agents',
      'agents',
      'tool_use_agents',
    ]);
  });

  it('retries contention and rechecks the marker after acquiring the shared lock', async () => {
    const copy = vi.spyOn(platform().fs, 'copy');
    const markerPath = GlobalStorageFS.fullPath(SYNC_MARKER_FILE);
    const runExclusive = vi
      .spyOn(platform().fileLocks, 'runExclusive')
      .mockImplementationOnce(async () => {
        throw elocked('Lock file is already being held');
      })
      .mockImplementationOnce(async (lockPath, operation) => {
        expect(lockPath).toBe(markerPath);
        // Another process finished the same reconciliation while this one
        // waited for the lock; its marker must be honoured.
        await writeText(
          lockPath,
          `${JSON.stringify({
            completedAt: Date.now(),
            ownerPid: process.pid + 1,
            version: '1.0.0',
          })}\n`,
        );
        return operation();
      });

    await bootstrap('1.0.0');

    expect(copy).not.toHaveBeenCalled();
    expect(platform().globalState.get<string>(VERSION_STATE_KEY)).toBe('1.0.0');
    expect(runExclusive).toHaveBeenCalledTimes(2);
  });

  it('skips refresh when cross-process ownership remains unavailable', async () => {
    vi.useFakeTimers();
    const runExclusive = vi
      .spyOn(platform().fileLocks, 'runExclusive')
      .mockRejectedValue(elocked('Lock file is already being held'));

    const bootstrapped = bootstrap();
    await vi.runAllTimersAsync();
    await expect(bootstrapped).resolves.toBe(false);

    expect(runExclusive).toHaveBeenCalledTimes(21);
    expect(logs.warn).toHaveBeenCalledWith(
      'Skipping bundled agent refresh because another process still owns the sync lock',
    );
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('does not mistake an in-operation ELOCKED failure for lock contention', async () => {
    const copy = vi.spyOn(platform().fs, 'copy').mockResolvedValue(undefined);
    vi.spyOn(platform().globalState, 'update').mockRejectedValue(
      elocked('version store lock failed'),
    );

    await bootstrap();

    expect(copy).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('version store lock failed'),
    );
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('does not fail reconciliation when the marker write fails', async () => {
    const copy = vi.spyOn(platform().fs, 'copy').mockResolvedValue(undefined);
    const writeFileImpl = platform().fs.writeFile.bind(platform().fs);
    vi.spyOn(platform().fs, 'writeFile').mockImplementation(
      async (target, content) => {
        if (target.endsWith(SYNC_MARKER_FILE)) {
          throw new Error('marker unwritable');
        }
        await writeFileImpl(target, content);
      },
    );

    await bootstrap();

    expect(copy).toHaveBeenCalledTimes(2);
    expect(platform().globalState.get<string>(VERSION_STATE_KEY)).toBe('1.0.0');
    expect(logs.warn).toHaveBeenCalledWith(
      'Failed to write bundled agent sync marker: marker unwritable',
    );
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('reports a copy failure without aborting host startup', async () => {
    vi.spyOn(platform().fs, 'copy').mockRejectedValue(new Error('copy failed'));

    await expect(bootstrap()).resolves.toBe(false);

    expect(logs.error).toHaveBeenCalledWith(
      expect.stringContaining('copy failed'),
    );
  });
});
