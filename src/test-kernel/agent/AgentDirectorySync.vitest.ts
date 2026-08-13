// Node imports
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import {
  BundledAgentDirectorySync,
  type AgentDirectoryBundleSource,
  type AgentDirectoryStorage,
} from '@agent/index/AgentDirectorySync';
import type { BundledAgentDirectoryName } from '@agent/index/BundledAgentDirectories';
import { platform } from '@platform/platform';

class FsAgentDirectoryStorage implements AgentDirectoryStorage {
  constructor(private readonly root: string) {}

  async ensureDir(relativePath: string): Promise<void> {
    await mkdir(this.fullPath(relativePath), { recursive: true });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await access(this.fullPath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  read(relativePath: string): Promise<string> {
    return readFile(this.fullPath(relativePath), 'utf8');
  }

  write(relativePath: string, content: string): Promise<void> {
    return writeFile(this.fullPath(relativePath), content);
  }

  delete(relativePath: string): Promise<void> {
    return rm(this.fullPath(relativePath), { recursive: true, force: true });
  }

  fullPath(relativePath: string): string {
    return join(this.root, relativePath);
  }
}

function createSync(
  storage: AgentDirectoryStorage,
  bundleSource: AgentDirectoryBundleSource,
  hooks: {
    onVersion?: (version: string | undefined) => void;
    onWarn?: (message: string) => void;
  } = {},
): BundledAgentDirectorySync {
  return new BundledAgentDirectorySync({
    bundleSource,
    storage,
    versionStore: {
      get: () => undefined,
      update: async (version) => hooks.onVersion?.(version),
    },
    logger: {
      info: () => undefined,
      warn: (message) => hooks.onWarn?.(message),
    },
  });
}

describe('BundledAgentDirectorySync', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-agent-sync-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent copies into the same storage root', async () => {
    const copied: BundledAgentDirectoryName[] = [];
    let activeCopies = 0;
    let maxActiveCopies = 0;

    const sync = createSync(new FsAgentDirectoryStorage(tempDir), {
      async copyDirectory(directoryName, destinationPath) {
        activeCopies += 1;
        maxActiveCopies = Math.max(maxActiveCopies, activeCopies);
        try {
          await sleep(20);
          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, 'agent.yaml'), 'name: agent\n');
          copied.push(directoryName);
        } finally {
          activeCopies -= 1;
        }
      },
    });

    await Promise.all([
      sync.reconcile('1.0.0'),
      sync.reconcile('1.0.0'),
      sync.reconcile('1.0.0'),
    ]);

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
    const copied: BundledAgentDirectoryName[] = [];
    let storedVersion: string | undefined;
    const runExclusive = vi
      .spyOn(platform().fileLocks, 'runExclusive')
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Lock file is already being held'), {
          code: 'ELOCKED',
        });
      })
      .mockImplementationOnce(async (lockPath, operation) => {
        expect(lockPath).toBe(join(tempDir, '.bundled-agent-sync.json'));
        await writeFile(
          lockPath,
          `${JSON.stringify({
            completedAt: Date.now(),
            ownerPid: process.pid + 1,
            version: '1.0.0',
          })}\n`,
        );
        return operation();
      });

    const sync = createSync(
      new FsAgentDirectoryStorage(tempDir),
      {
        async copyDirectory(directoryName) {
          copied.push(directoryName);
        },
      },
      {
        onVersion: (version) => {
          storedVersion = version;
        },
      },
    );

    await sync.reconcile('1.0.0');

    expect(copied).toEqual([]);
    expect(storedVersion).toBe('1.0.0');
    expect(runExclusive).toHaveBeenCalledTimes(2);
  });

  it('skips refresh when cross-process ownership remains unavailable', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const runExclusive = vi
      .spyOn(platform().fileLocks, 'runExclusive')
      .mockRejectedValue(
        Object.assign(new Error('Lock file is already being held'), {
          code: 'ELOCKED',
        }),
      );
    const sync = createSync(
      new FsAgentDirectoryStorage(tempDir),
      { copyDirectory: async () => undefined },
      { onWarn: (message) => warnings.push(message) },
    );

    const result = sync.reconcile('1.0.0');
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(false);
    expect(runExclusive).toHaveBeenCalledTimes(21);
    expect(warnings).toEqual([
      'Skipping bundled agent refresh because another process still owns the sync lock',
    ]);
  });

  it('does not mistake an in-operation ELOCKED failure for lock contention', async () => {
    const copied: BundledAgentDirectoryName[] = [];
    const sync = createSync(
      new FsAgentDirectoryStorage(tempDir),
      {
        async copyDirectory(directoryName) {
          copied.push(directoryName);
        },
      },
      {
        onVersion: () => {
          throw Object.assign(new Error('version store lock failed'), {
            code: 'ELOCKED',
          });
        },
      },
    );

    await expect(sync.reconcile('1.0.0')).rejects.toThrow(
      'version store lock failed',
    );
    expect(copied).toEqual(['agents', 'tool_use_agents']);
  });

  it('clears the reconcile lock after copy failure', async () => {
    let shouldFail = true;
    const sync = createSync(new FsAgentDirectoryStorage(tempDir), {
      async copyDirectory() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('copy failed');
        }
      },
    });

    await expect(sync.reconcile('1.0.0')).rejects.toThrow('copy failed');
    await expect(sync.reconcile('1.0.0')).resolves.toBe(true);
  });

  it('does not fail reconciliation when the marker write fails', async () => {
    const storage = new (class extends FsAgentDirectoryStorage {
      override write(relativePath: string, content: string): Promise<void> {
        if (relativePath === '.bundled-agent-sync.json') {
          throw new Error('marker unwritable');
        }
        return super.write(relativePath, content);
      }
    })(tempDir);
    const copied: BundledAgentDirectoryName[] = [];
    let storedVersion: string | undefined;
    const warnings: string[] = [];
    const sync = createSync(
      storage,
      {
        async copyDirectory(directoryName, destinationPath) {
          await mkdir(destinationPath, { recursive: true });
          copied.push(directoryName);
        },
      },
      {
        onVersion: (version) => {
          storedVersion = version;
        },
        onWarn: (message) => warnings.push(message),
      },
    );

    await expect(sync.reconcile('1.0.0')).resolves.toBe(true);

    expect(copied).toEqual(['agents', 'tool_use_agents']);
    expect(storedVersion).toBe('1.0.0');
    expect(warnings).toEqual([
      'Failed to write bundled agent sync marker: marker unwritable',
    ]);
  });
});
