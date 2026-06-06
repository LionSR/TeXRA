import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
import { bus } from '@eventBus/ProgressEventBus';
import { StreamSnapshotStore, streamDataDir } from '@transcript';
import type {
  Plan,
  StorageKey,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';

const tempDirs: string[] = [];

async function installPlatform(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-snapshot-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      { workspacePath: workspaceDir },
      {
        fs: nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
        globalState: createMemoryStore(),
        workspaceState: createMemoryStore(),
      },
    ),
  );
}

const STREAM = 'polish@gpt#abc123def' as StreamTabId;
const RUN = 'run-1' as StorageKey;

const TODO: TodoItem = {
  content: 'Write the introduction',
  status: 'in_progress',
  activeForm: 'Writing the introduction',
};

const PLAN: Plan = {
  summary: 'Draft and polish the paper',
  steps: [
    {
      title: 'Draft',
      description: 'Write the first draft',
      status: 'pending',
      files: ['paper.tex'],
    },
  ],
};

function usage(input: number, output: number, cost: number): TokenUsageStats {
  return { inputTokens: input, outputTokens: output, cost };
}

describe('StreamSnapshotStore', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('persists todos/plan/usage via the bus and reassembles them on a fresh store', async () => {
    await installPlatform();

    const writer = new StreamSnapshotStore();
    const off = writer.subscribe(bus);

    bus.emit('updateTodos', { streamId: STREAM, todos: [TODO] });
    bus.emit('updatePlan', { streamId: STREAM, plan: PLAN });
    // Two deltas for the same run must accumulate, not overwrite.
    bus.emit('updateStreamUsage', {
      streamId: STREAM,
      storageKey: RUN,
      usage: usage(100, 20, 0.5),
    });
    bus.emit('updateStreamUsage', {
      streamId: STREAM,
      storageKey: RUN,
      usage: usage(50, 10, 0.25),
    });

    await writer.flush();
    off();

    // A second store reads only from disk — the resume path.
    const reader = new StreamSnapshotStore();
    const snap = await reader.read(STREAM);

    expect(snap.todos).toEqual([TODO]);
    expect(snap.plan).toEqual(PLAN);
    expect(snap.planSummary).toBe(PLAN.summary);
    expect(snap.runUsage[RUN]).toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      cost: 0.75,
    });

    // Liveness is never persisted — a resumed stream shows nothing stale.
    expect(snap.activeSubagents).toEqual([]);
    expect(snap.activeProcesses).toEqual([]);
    expect(snap.status).toBeUndefined();

    // Cross-host identity: the exact field-scoped filenames every host shares.
    const dir = streamDataDir(STREAM);
    expect(await StorageFS.exists(path.join(dir, 'workPlan.json'))).toBe(true);
    expect(await StorageFS.exists(path.join(dir, 'usageStats.json'))).toBe(
      true,
    );
  });

  it('returns an empty (valid) snapshot for a stream with no sidecar', async () => {
    await installPlatform();
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.streamId).toBe(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
    expect(snap.runUsage).toEqual({});
  });

  it('migrates the legacy nested {runId:{round}} shape to flat ONCE at the load entry', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'missingOutputs.json'),
      JSON.stringify({ 'run-1': { '0': ['a.tex'], '1': ['b.tex'] } }),
    );

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    await store.flush();

    // The on-disk file is now FLAT — migrated once at the load entry, never
    // re-resolved on subsequent reads.
    const raw = await StorageFS.readJson(path.join(dir, 'missingOutputs.json'));
    expect(raw).toEqual({ '0': ['a.tex'], '1': ['b.tex'] });
    // …and a fresh read sees the flattened data.
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.missingOutputsByRound).toEqual({
      '0': ['a.tex'],
      '1': ['b.tex'],
    });
  });

  it('degrades gracefully when workPlan.json is valid JSON but the wrong shape', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    // Corrupt-but-parseable payload must NOT throw and abort read()/resume.
    await StorageFS.write(
      path.join(dir, 'workPlan.json'),
      JSON.stringify({ todos: 'not-an-array', plan: 42 }),
    );
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
  });
});
