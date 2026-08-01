import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  getExecutionStore,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { EXECUTION_LEASE_STALE_MS } from '@agent/storage/executionLease';
import { platform } from '@platform/platform';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { ExecutionId } from '@shared/schemas';
import { writeForeignLease } from '@test/support/executionLeaseFixtures';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files';

function config(agent: string): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model: 'deepseekT',
    instruction: 'Test execution listing.',
    agentCategory: AgentCategory.ToolUse,
    workingDirectory: '/workspace',
  });
}

async function writeExecution(
  id: ExecutionId,
  timestamp: string,
  agentConfig?: AgentConfig,
  category?: string,
  parentExecutionId?: ExecutionId,
): Promise<void> {
  const store = getExecutionStore(id);
  await store.writeMeta({ timestamp, category, parentExecutionId });
  if (agentConfig) await store.writeConfig(agentConfig);
}

describe('execution listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
  });

  it('sees executions written by another host after an earlier listing', async () => {
    expect(await listExecutions()).toEqual([]);

    const id = 'eee555' as ExecutionId;
    await writeExecution(
      id,
      '2026-07-15T11:00:00.000Z',
      config('assistant'),
      AgentCategory.ToolUse,
    );

    expect(await listExecutions()).toEqual([
      expect.objectContaining({ id, kind: 'agent' }),
    ]);
  });

  it('sees metadata replaced by another host after an earlier listing', async () => {
    const id = 'fff666' as ExecutionId;
    await writeExecution(
      id,
      '2026-07-15T12:00:00.000Z',
      config('assistant'),
      AgentCategory.ToolUse,
    );
    expect(await listExecutions()).toEqual([
      expect.not.objectContaining({ description: expect.any(String) }),
    ]);

    await getExecutionStore(id).writeMeta({
      timestamp: '2026-07-15T12:00:00.000Z',
      category: AgentCategory.ToolUse,
      description: 'Updated by another host',
      terminalStatus: 'completed',
    });

    expect(await listExecutions()).toEqual([
      expect.objectContaining({
        id,
        description: 'Updated by another host',
        terminalStatus: 'completed',
      }),
    ]);
  });

  it('migrates history stored under a legacy workspace spelling', async () => {
    const id = 'abc777' as ExecutionId;
    const legacyKey = 'texra.agentHistory./workspace/symlink';
    await installPlatform(
      {
        workspacePath: '/workspace/physical',
        workspaceState: {
          [legacyKey]: [
            {
              id,
              timestamp: '2026-07-15T13:00:00.000Z',
              agentConfig: config('assistant'),
            },
          ],
        },
      },
      {
        workspace: {
          getWorkspacePath: () => '/workspace/physical',
          getLegacyWorkspacePaths: () => ['/workspace/symlink'],
          asRelativePath: (filePath) => filePath,
        },
      },
    );
    clearStoreCache();

    expect(await listExecutions()).toEqual([
      expect.objectContaining({ id, kind: 'agent' }),
    ]);
    expect(platform().workspaceState.get(legacyKey, [])).toEqual([]);
  });

  it('retains active legacy history and migrates it after its lease is stale', async () => {
    const id = 'abc778' as ExecutionId;
    const legacyKey = 'texra.agentHistory./workspace';
    const legacyEntry = {
      id,
      timestamp: '2026-07-15T13:01:00.000Z',
      agentConfig: config('assistant'),
    };
    await installPlatform({
      workspacePath: '/workspace',
      workspaceState: { [legacyKey]: [legacyEntry] },
    });
    clearStoreCache();
    await writeForeignLease(id, Date.now());
    expect(await listExecutions()).toEqual([]);
    expect(platform().workspaceState.get(legacyKey, [])).toEqual([legacyEntry]);

    await writeForeignLease(id, Date.now() - EXECUTION_LEASE_STALE_MS - 1);
    expect(await listExecutions()).toEqual([
      expect.objectContaining({ id, kind: 'agent' }),
    ]);
    expect(platform().workspaceState.get(legacyKey, [])).toEqual([]);
  });

  it('migrates legacy history once for concurrent listings', async () => {
    const id = 'abc779' as ExecutionId;
    const legacyKey = 'texra.agentHistory./workspace';
    const legacyEntry = {
      id,
      timestamp: '2026-07-15T13:02:00.000Z',
      agentConfig: config('assistant'),
    };
    await installPlatform({
      workspacePath: '/workspace',
      workspaceState: { [legacyKey]: [legacyEntry] },
    });
    clearStoreCache();
    const update = vi.spyOn(platform().workspaceState, 'update');

    const [first, second] = await Promise.all([
      listExecutions(),
      listExecutions(),
    ]);

    const migratedRow = [expect.objectContaining({ id, kind: 'agent' })];
    expect(first).toEqual(migratedRow);
    expect(second).toEqual(migratedRow);
    expect(update.mock.calls.filter(([key]) => key === legacyKey)).toHaveLength(
      1,
    );
  });

  it('uses the durable marker after a host restart', async () => {
    const firstPlatform = platform();
    const workspaceStateGet = vi.spyOn(firstPlatform.workspaceState, 'get');

    expect(await listExecutions()).toEqual([]);
    expect(workspaceStateGet).toHaveBeenCalled();
    workspaceStateGet.mockClear();

    // Reinitialize the host while preserving its durable filesystem and state.
    // The process-local memo is discarded with the Platform instance, so only
    // the on-disk marker can prevent another legacy workspace-state probe.
    await installPlatform(
      {},
      {
        fs: firstPlatform.fs,
        storage: firstPlatform.storage,
        workspace: firstPlatform.workspace,
        workspaceState: firstPlatform.workspaceState,
      },
    );
    clearStoreCache();

    expect(await listExecutions()).toEqual([]);
    expect(workspaceStateGet).not.toHaveBeenCalled();
  });

  it('retries migration after the durable marker cannot be written', async () => {
    const workspaceStateGet = vi.spyOn(platform().workspaceState, 'get');
    const writeAtomic = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(new Error('marker unavailable'));

    expect(await listExecutions()).toEqual([]);
    expect(workspaceStateGet).toHaveBeenCalledTimes(1);

    expect(await listExecutions()).toEqual([]);
    expect(workspaceStateGet).toHaveBeenCalledTimes(2);
    expect(writeAtomic).toHaveBeenCalledTimes(2);
  });

  it('retries the legacy index migration after an unreadable index.json', async () => {
    const indexPath = `${RUNS_STORAGE_DIR}/index.json`;
    await StorageFS.ensureDir(RUNS_STORAGE_DIR);
    await StorageFS.write(indexPath, '{ this is not json');
    expect(await listExecutions()).toEqual([]);

    const id = 'abc780' as ExecutionId;
    await StorageFS.write(
      indexPath,
      JSON.stringify([
        {
          id,
          timestamp: '2026-07-15T13:03:00.000Z',
          agentConfig: config('assistant'),
        },
      ]),
    );

    expect(await listExecutions()).toEqual([
      expect.objectContaining({ id, kind: 'agent' }),
    ]);
    expect(await StorageFS.exists(indexPath)).toBe(false);
  });

  it('retries the legacy index migration after an invalid legacy shape', async () => {
    const indexPath = `${RUNS_STORAGE_DIR}/index.json`;
    await StorageFS.ensureDir(RUNS_STORAGE_DIR);
    await StorageFS.write(indexPath, JSON.stringify({ entries: [] }));
    expect(await listExecutions()).toEqual([]);

    const id = 'abc781' as ExecutionId;
    await StorageFS.write(
      indexPath,
      JSON.stringify([
        {
          id,
          timestamp: '2026-07-15T13:04:00.000Z',
          agentConfig: config('assistant'),
        },
      ]),
    );

    expect(await listExecutions()).toEqual([
      expect.objectContaining({ id, kind: 'agent' }),
    ]);
    expect(await StorageFS.exists(indexPath)).toBe(false);
  });

  it('retries workspace-state migration after an invalid legacy shape', async () => {
    const id = 'abc782' as ExecutionId;
    const legacyKey = 'texra.agentHistory./workspace';
    await installPlatform({
      workspacePath: '/workspace',
      workspaceState: { [legacyKey]: { entries: [] } },
    });
    clearStoreCache();

    expect(await listExecutions()).toEqual([]);
    expect(
      await StorageFS.exists(
        `${RUNS_STORAGE_DIR}/.legacy-history-migration-v1`,
      ),
    ).toBe(false);

    await platform().workspaceState.update(legacyKey, [
      {
        id,
        timestamp: '2026-07-15T13:05:00.000Z',
        agentConfig: config('assistant'),
      },
    ]);

    expect(await listExecutions()).toEqual([
      expect.objectContaining({ id, kind: 'agent' }),
    ]);
    expect(platform().workspaceState.get(legacyKey, [])).toEqual([]);
  });

  it('uses the config as the canonical source for visible agent fields', async () => {
    const id = 'aaa111' as ExecutionId;
    const agentConfig = config('assistant');
    await writeExecution(
      id,
      '2026-07-15T10:00:00.000Z',
      agentConfig,
      AgentCategory.ToolUse,
    );

    const entries = await listExecutions();

    expect(entries).toEqual([
      {
        kind: 'agent',
        id,
        timestamp: '2026-07-15T10:00:00.000Z',
        agentConfig,
      },
    ]);
    expect(entries.filter(isUserVisibleExecution)).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('agent');
    expect(entries[0]).not.toHaveProperty('model');
    expect(entries[0]).not.toHaveProperty('category');
  });

  it('classifies process and incomplete storage rows explicitly', async () => {
    const metadataProcessId = 'bbb222' as ExecutionId;
    const customBashAgentId = 'ccc333' as ExecutionId;
    const incompleteId = 'ddd444' as ExecutionId;
    await writeExecution(
      metadataProcessId,
      '2026-07-15T09:00:00.000Z',
      config('assistant'),
      'process',
    );
    await writeExecution(
      customBashAgentId,
      '2026-07-15T08:00:00.000Z',
      config('bash'),
    );
    await writeExecution(
      incompleteId,
      '2026-07-15T07:00:00.000Z',
      undefined,
      'legacy',
    );

    const entries = await listExecutions();

    expect(entries.map(({ kind }) => kind)).toEqual([
      'process',
      'agent',
      'incomplete',
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'process',
      agentConfig: { agent: 'assistant' },
    });
    expect(entries[1]).toMatchObject({
      kind: 'agent',
      agentConfig: { agent: 'bash' },
    });
    expect(entries[2]).toEqual({
      kind: 'incomplete',
      id: incompleteId,
      timestamp: '2026-07-15T07:00:00.000Z',
      runtimeCategory: 'legacy',
    });
    expect(entries.filter(isUserVisibleExecution)).toEqual([entries[1]]);
  });

  it('keeps agent-spawned child runs out of history listings', async () => {
    const rootId = 'eee111' as ExecutionId;
    const childId = 'fff222' as ExecutionId;
    await writeExecution(
      rootId,
      '2026-07-15T10:00:00.000Z',
      config('orchestrator'),
      AgentCategory.ToolUse,
    );
    await writeExecution(
      childId,
      '2026-07-15T10:05:00.000Z',
      config('search'),
      AgentCategory.ToolUse,
      rootId,
    );

    const entries = await listExecutions();

    // The raw listing still carries the child so tool-facing callers can walk
    // the lineage; only the history-listing filter drops it.
    expect(entries.map(({ id }) => id)).toEqual([childId, rootId]);
    expect(entries.filter(isUserVisibleExecution).map(({ id }) => id)).toEqual([
      rootId,
    ]);
  });
});
