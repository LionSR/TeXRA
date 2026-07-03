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
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - agent
import {
  BundledAgentDirectorySync,
  type AgentDirectoryBundleSource,
  type AgentDirectoryStorage,
} from '@agent/index/AgentDirectorySync';
import type { BundledAgentDirectoryName } from '@agent/index/BundledAgentDirectories';

function pendingReconcileCount(): number {
  return (
    BundledAgentDirectorySync as unknown as {
      reconcileByStorageRoot: Map<string, Promise<boolean>>;
    }
  ).reconcileByStorageRoot.size;
}

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

describe('BundledAgentDirectorySync', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('serializes concurrent copies into the same storage root', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-agent-sync-'));
    const storage = new FsAgentDirectoryStorage(tempDir);
    const copied: BundledAgentDirectoryName[] = [];
    let activeCopies = 0;
    let maxActiveCopies = 0;

    const bundleSource: AgentDirectoryBundleSource = {
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
    };
    const sync = new BundledAgentDirectorySync({
      bundleSource,
      storage,
      versionStore: {
        get: () => undefined,
        update: async () => undefined,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
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
    expect(pendingReconcileCount()).toBe(0);
  });

  it('skips a recent same-version sync from another process', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-agent-sync-'));
    const storage = new FsAgentDirectoryStorage(tempDir);
    const copied: BundledAgentDirectoryName[] = [];
    let storedVersion: string | undefined;
    await writeFile(
      join(tempDir, '.bundled-agent-sync.json'),
      `${JSON.stringify({
        completedAt: Date.now(),
        ownerPid: process.pid + 1,
        version: '1.0.0',
      })}\n`,
    );

    const sync = new BundledAgentDirectorySync({
      bundleSource: {
        async copyDirectory(directoryName) {
          copied.push(directoryName);
        },
      },
      storage,
      versionStore: {
        get: () => undefined,
        update: async (version) => {
          storedVersion = version;
        },
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
      },
    });

    await sync.reconcile('1.0.0');

    expect(copied).toEqual([]);
    expect(storedVersion).toBe('1.0.0');
    expect(pendingReconcileCount()).toBe(0);
  });

  it('clears the reconcile lock after copy failure', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-agent-sync-'));
    const storage = new FsAgentDirectoryStorage(tempDir);
    const sync = new BundledAgentDirectorySync({
      bundleSource: {
        async copyDirectory() {
          throw new Error('copy failed');
        },
      },
      storage,
      versionStore: {
        get: () => undefined,
        update: async () => undefined,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
      },
    });

    await expect(sync.reconcile('1.0.0')).rejects.toThrow('copy failed');

    expect(pendingReconcileCount()).toBe(0);
  });

  it('does not fail reconciliation when the marker write fails', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-agent-sync-'));
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
    const sync = new BundledAgentDirectorySync({
      bundleSource: {
        async copyDirectory(directoryName, destinationPath) {
          await mkdir(destinationPath, { recursive: true });
          copied.push(directoryName);
        },
      },
      storage,
      versionStore: {
        get: () => undefined,
        update: async (version) => {
          storedVersion = version;
        },
      },
      logger: {
        info: () => undefined,
        warn: (message) => warnings.push(message),
      },
    });

    await expect(sync.reconcile('1.0.0')).resolves.toBe(true);

    expect(copied).toEqual(['agents', 'tool_use_agents']);
    expect(storedVersion).toBe('1.0.0');
    expect(warnings).toEqual([
      'Failed to write bundled agent sync marker: marker unwritable',
    ]);
    expect(pendingReconcileCount()).toBe(0);
  });
});
