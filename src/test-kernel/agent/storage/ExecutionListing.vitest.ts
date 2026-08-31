import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  deleteExecution,
  getExecutionStore,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import {
  listExecutionStreamReferences,
  readExecutionStreamIndex,
} from '@agent/storage/executionListing';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import {
  createExecutionMetaReader,
  readExecutionMeta,
} from '@agent/storage/executionMetaPersistence';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { createExecutionAdjacentStreamCleanup } from '@transcript/adjacentStreamCleanup';
import {
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from '@transcript/streamDataPaths';
import { StorageFS } from '@utils/files/storageFS';

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
  parentExecutionId?: ExecutionId,
): Promise<void> {
  const store = getExecutionStore(id);
  // Current-era registration always stamps identity into the first meta
  // write; an identity-less row models the pre-identity (incomplete) case.
  await store.writeMeta({
    timestamp,
    parentExecutionId,
    ...(agentConfig
      ? { identity: { kind: 'agent', agent: agentConfig.agent } }
      : {}),
  });
  if (agentConfig) await store.writeRunRecord(agentConfig);
}

async function writeStreamMeta(
  streamId: StreamTabId,
  meta: unknown,
): Promise<void> {
  await new KVStore(streamDataDir(streamId)).write(STREAM_DATA_KEYS.META, meta);
}

async function writeEncodedStreamMeta(
  encodedStreamId: string,
  meta: unknown,
): Promise<void> {
  await new KVStore(`${STREAM_DATA_DIR}/${encodedStreamId}`).write(
    STREAM_DATA_KEYS.META,
    meta,
  );
}

describe('execution listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    clearStoreCache();
  });

  it('sees executions written by another host after an earlier listing', async () => {
    expect(await listExecutions()).toEqual([]);

    const id = 'eee555' as ExecutionId;
    await writeExecution(id, '2026-07-15T11:00:00.000Z', config('assistant'));

    expect(await listExecutions()).toEqual([
      expect.objectContaining({
        id,
        kind: 'run',
        identity: { kind: 'agent', agent: 'assistant' },
      }),
    ]);
  });

  it('lists only readable execution metadata with an explicit stream reference', async () => {
    const referenced = 'f9892001' as ExecutionId;
    const withoutStream = 'f9892002' as ExecutionId;
    const malformed = 'f9892003' as ExecutionId;
    await getExecutionStore(referenced).writeMeta({
      timestamp: '2026-08-08T00:00:00.000Z',
      streamId: 'referenced-stream',
    });
    await getExecutionStore(withoutStream).writeMeta({
      timestamp: '2026-08-08T00:00:00.000Z',
    });
    await getExecutionStore(malformed).write('meta', { timestamp: 42 });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const listing = await listExecutionStreamReferences();

      expect(listing.references).toEqual([
        { executionId: referenced, streamId: 'referenced-stream' },
      ]);
      // The unreadable row is reported with its cause, never dropped.
      expect([...listing.unreadable.keys()]).toEqual([malformed]);
      expect(warn).toHaveBeenCalledWith(
        'ExecutionListing',
        expect.stringContaining(
          `Execution ${malformed} has unreadable storage`,
        ),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('writes through one confirmed legacy sidecar match', async () => {
    const executionId = 'f9892101' as ExecutionId;
    const streamId = 'legacy-stream' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    await writeStreamMeta(streamId, { executionId });

    await expect(
      createExecutionMetaReader().readStrict(executionId),
    ).resolves.toMatchObject({
      streamId,
    });
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({ streamId });
  });

  it.each([
    {
      name: 'ambiguous matches',
      sidecars: [
        ['legacy-a', {}],
        ['legacy-b', {}],
      ] as const,
    },
    {
      name: 'no match',
      sidecars: [['unrelated', { executionId: 'f9892199' }]] as const,
    },
    {
      name: 'a malformed matching sidecar',
      sidecars: [
        ['valid', {}],
        ['malformed', { parentStreamId: 42 }],
      ] as const,
    },
  ])('leaves legacy metadata unstamped for $name', async ({ sidecars }) => {
    const executionId = 'f9892102' as ExecutionId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    for (const [streamId, fields] of sidecars) {
      await writeStreamMeta(streamId as StreamTabId, {
        executionId,
        ...fields,
      });
    }

    await expect(readExecutionMeta(executionId)).resolves.toEqual(
      expect.not.objectContaining({ streamId: expect.any(String) }),
    );
    expect(
      (await getExecutionStore(executionId).readMeta())?.streamId,
    ).toBeUndefined();
  });

  it.each([
    { name: 'reserved', encodedStreamId: '%2E%2E' },
    { name: 'undecodable', encodedStreamId: '%E0%A4%A' },
    { name: 'noncanonical', encodedStreamId: '%6Cegacy-invalid' },
  ])(
    'fails closed for a $name sidecar directory name',
    async ({ encodedStreamId }) => {
      const executionId = 'f9892109' as ExecutionId;
      await getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-31T00:00:00.000Z',
      });
      await writeStreamMeta('valid-candidate' as StreamTabId, { executionId });
      await writeEncodedStreamMeta(encodedStreamId, { executionId });

      await expect(readExecutionMeta(executionId)).resolves.toEqual(
        expect.not.objectContaining({ streamId: expect.any(String) }),
      );
      expect(
        (await getExecutionStore(executionId).readMeta())?.streamId,
      ).toBeUndefined();
      await expect(
        createExecutionMetaReader().readForDeletion(executionId),
      ).rejects.toThrow(/ownership/i);
    },
  );

  it('does not scan sidecars for a modern row', async () => {
    const executionId = 'f9892103' as ExecutionId;
    const streamId = 'modern-stream' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-08-30T00:00:00.000Z',
      streamId,
    });
    const readDir = vi.spyOn(StorageFS, 'readDir');

    try {
      await expect(
        createExecutionMetaReader().readStrict(executionId),
      ).resolves.toMatchObject({ streamId });
      expect(readDir).not.toHaveBeenCalled();
    } finally {
      readDir.mockRestore();
    }
  });

  it('includes a safely healed legacy row in the stream index', async () => {
    const executionId = 'f9892104' as ExecutionId;
    const streamId = 'indexed-legacy-stream' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    await writeStreamMeta(streamId, { executionId });

    const index = await readExecutionStreamIndex();

    expect(index.byStream.get(streamId)).toBe(executionId);
  });

  it('does not heal across an existing execution metadata claim', async () => {
    const modern = 'f9892105' as ExecutionId;
    const legacy = 'f9892106' as ExecutionId;
    const streamId = 'already-claimed-stream' as StreamTabId;
    await getExecutionStore(modern).writeMeta({
      timestamp: '2026-08-30T00:00:00.000Z',
      streamId,
    });
    await getExecutionStore(legacy).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    await writeStreamMeta(streamId, { executionId: legacy });

    const index = await readExecutionStreamIndex();

    expect(index.byStream.get(streamId)).toBe(modern);
    expect(index.unreadable.has(legacy)).toBe(true);
    expect(
      (await getExecutionStore(legacy).readMeta())?.streamId,
    ).toBeUndefined();

    await getExecutionStore(legacy).writeMeta({
      timestamp: '2026-07-31T00:00:00.000Z',
      streamId,
    });
    const duplicate = await readExecutionStreamIndex();
    expect(duplicate.byStream.has(streamId)).toBe(false);
    expect([...duplicate.unreadable.keys()]).toEqual(
      expect.arrayContaining([modern, legacy]),
    );
  });

  it('blocks deletion of either execution when modern metadata duplicates a stream claim', async () => {
    const first = 'f9892107' as ExecutionId;
    const second = 'f9892108' as ExecutionId;
    const streamId = 'duplicate-modern-stream' as StreamTabId;
    for (const executionId of [first, second]) {
      await getExecutionStore(executionId).writeMeta({
        timestamp: '2026-08-30T00:00:00.000Z',
        streamId,
      });
    }
    await writeStreamMeta(streamId, { executionId: first });
    const deleteAdjacentStreamState = vi.fn(async (stream: StreamTabId) => {
      await StorageFS.delete(streamDataDir(stream), { recursive: true });
    });
    const cleanupExecution = createExecutionAdjacentStreamCleanup({
      deleteAdjacentStreamState,
    });

    for (const executionId of [first, second]) {
      await expect(
        deleteExecution(executionId, {
          beforeDelete: () => cleanupExecution(executionId),
        }),
      ).rejects.toThrow();
      expect(deleteAdjacentStreamState).not.toHaveBeenCalled();
      await expect(
        StorageFS.exists(`${RUNS_STORAGE_DIR}/${first}`),
      ).resolves.toBe(true);
      await expect(
        StorageFS.exists(`${RUNS_STORAGE_DIR}/${second}`),
      ).resolves.toBe(true);
      await expect(
        new KVStore(streamDataDir(streamId)).exists(STREAM_DATA_KEYS.META),
      ).resolves.toBe(true);
    }
  });

  it('keeps cleanup ownership fenced against a competing stream registration', async () => {
    const owner = 'f9892114' as ExecutionId;
    const competing = 'f9892115' as ExecutionId;
    const streamId = 'cleanup-registration-race' as StreamTabId;
    await getExecutionStore(owner).writeMeta({
      timestamp: '2026-08-30T00:00:00.000Z',
      streamId,
    });
    await writeStreamMeta(streamId, { executionId: owner });
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanupExecution = createExecutionAdjacentStreamCleanup({
      deleteAdjacentStreamState: async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        await StorageFS.delete(streamDataDir(streamId), { recursive: true });
      },
    });
    const competingConfig = config('assistant');

    try {
      const cleanup = cleanupExecution(owner);
      await cleanupStarted.promise;
      let registrationSettled = false;
      const registration = registerExecution(
        competing,
        competingConfig,
        competingConfig.agent,
        {
          streamId,
          identity: { kind: 'agent', agent: competingConfig.agent },
        },
      ).finally(() => {
        registrationSettled = true;
      });
      await Promise.resolve();
      expect(registrationSettled).toBe(false);
      releaseCleanup.resolve();

      await expect(cleanup).resolves.toBeUndefined();
      await expect(registration).rejects.toThrow(
        'already has another or unreadable persisted execution owner',
      );
      await expect(getExecutionStore(competing).readMeta()).resolves.toBeNull();
    } finally {
      releaseCleanup.resolve();
      await releaseOwnedExecutionLease(competing).catch(() => undefined);
    }
  });

  it('freshly revalidates ownership when registration commits before the deletion fence', async () => {
    const owner = 'f9892116' as ExecutionId;
    const competing = 'f9892117' as ExecutionId;
    const streamId = 'cleanup-registration-gap' as StreamTabId;
    await getExecutionStore(owner).writeMeta({
      timestamp: '2026-08-30T00:00:00.000Z',
      streamId,
    });
    await writeStreamMeta(streamId, { executionId: owner });
    const cleanupReachedFence = createDeferred();
    const releaseCleanupFence = createDeferred();
    const fileLocks = platform().fileLocks;
    const originalRunExclusive = fileLocks.runExclusive.bind(fileLocks);
    let delayCleanupFence = true;
    const runExclusive = vi
      .spyOn(fileLocks, 'runExclusive')
      .mockImplementation((lockPath, operation) => {
        if (delayCleanupFence && lockPath.includes('streamOwnershipLocks')) {
          delayCleanupFence = false;
          cleanupReachedFence.resolve();
          return releaseCleanupFence.promise.then(() =>
            originalRunExclusive(lockPath, operation),
          );
        }
        return originalRunExclusive(lockPath, operation);
      });
    const deleteAdjacentStreamState = vi.fn();
    const cleanup = createExecutionAdjacentStreamCleanup({
      deleteAdjacentStreamState,
    })(owner);
    const rejectedCleanup =
      expect(cleanup).rejects.toThrow('freshly validated');

    try {
      await cleanupReachedFence.promise;
      await getExecutionStore(owner).writeMeta({
        timestamp: '2026-08-30T00:00:00.000Z',
        streamId: 'owner-moved-stream' as StreamTabId,
      });
      await new KVStore(streamDataDir(streamId)).delete(STREAM_DATA_KEYS.META);
      const competingConfig = config('assistant');
      await registerExecution(
        competing,
        competingConfig,
        competingConfig.agent,
        {
          streamId,
          identity: { kind: 'agent', agent: competingConfig.agent },
        },
      );
      await writeStreamMeta(streamId, { executionId: competing });
      releaseCleanupFence.resolve();

      await rejectedCleanup;
      expect(deleteAdjacentStreamState).not.toHaveBeenCalled();
    } finally {
      releaseCleanupFence.resolve();
      runExclusive.mockRestore();
      await releaseOwnedExecutionLease(competing).catch(() => undefined);
    }
  });

  it('scans legacy sidecars once per listing and does not cache no-match results', async () => {
    const unique = 'f9892111' as ExecutionId;
    const ambiguous = 'f9892112' as ExecutionId;
    const noMatch = 'f9892113' as ExecutionId;
    for (const executionId of [unique, ambiguous, noMatch]) {
      await getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-31T00:00:00.000Z',
      });
    }
    await writeStreamMeta('legacy-unique' as StreamTabId, {
      executionId: unique,
    });
    await writeStreamMeta('legacy-ambiguous-a' as StreamTabId, {
      executionId: ambiguous,
    });
    await writeStreamMeta('legacy-ambiguous-b' as StreamTabId, {
      executionId: ambiguous,
    });
    const readDir = vi.spyOn(StorageFS, 'readDir');
    const streamScanCount = (): number =>
      readDir.mock.calls.filter(([dir]) => dir === STREAM_DATA_DIR).length;

    try {
      const first = await listExecutionStreamReferences();

      expect(first.references).toEqual([
        { executionId: unique, streamId: 'legacy-unique' },
      ]);
      expect(first.unreadable.has(ambiguous)).toBe(true);
      expect(streamScanCount()).toBe(1);
      await writeStreamMeta('legacy-late-match' as StreamTabId, {
        executionId: noMatch,
      });

      const second = await listExecutionStreamReferences();

      expect(second.references).toEqual(
        expect.arrayContaining([
          { executionId: unique, streamId: 'legacy-unique' },
          { executionId: noMatch, streamId: 'legacy-late-match' },
        ]),
      );
      expect(second.references).toHaveLength(2);
      expect(streamScanCount()).toBe(2);
      expect(
        (await getExecutionStore(ambiguous).readMeta())?.streamId,
      ).toBeUndefined();
    } finally {
      readDir.mockRestore();
    }
  });

  it('shares legacy evidence while freshly revalidating each destructive stream', async () => {
    const first = 'f9892121' as ExecutionId;
    const second = 'f9892122' as ExecutionId;
    for (const executionId of [first, second]) {
      await getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-31T00:00:00.000Z',
      });
      await writeStreamMeta(`stream-${executionId}` as StreamTabId, {
        executionId,
      });
    }
    const deleteAdjacentStreamState = vi.fn();
    const cleanupExecution = createExecutionAdjacentStreamCleanup({
      deleteAdjacentStreamState,
    });
    const readDir = vi.spyOn(StorageFS, 'readDir');

    try {
      await Promise.all([cleanupExecution(first), cleanupExecution(second)]);

      expect(deleteAdjacentStreamState).toHaveBeenCalledTimes(2);
      expect(
        readDir.mock.calls.filter(([dir]) => dir === STREAM_DATA_DIR),
      ).toHaveLength(1);
      expect(
        readDir.mock.calls.filter(([dir]) => dir === RUNS_STORAGE_DIR),
      ).toHaveLength(3);
    } finally {
      readDir.mockRestore();
    }
  });

  it.each([
    { name: 'ambiguous', malformed: false },
    { name: 'unreadable', malformed: true },
  ])(
    'fails bulk deletion cleanup for $name historical ownership',
    async ({ malformed }) => {
      const executionId = 'f9892123' as ExecutionId;
      await getExecutionStore(executionId).writeMeta({
        timestamp: '2026-07-31T00:00:00.000Z',
      });
      await writeStreamMeta('cleanup-evidence-a' as StreamTabId, {
        executionId,
      });
      await writeStreamMeta(
        'cleanup-evidence-b' as StreamTabId,
        malformed ? null : { executionId },
      );
      const deleteAdjacentStreamState = vi.fn();
      const cleanupExecution = createExecutionAdjacentStreamCleanup({
        deleteAdjacentStreamState,
      });

      await expect(cleanupExecution(executionId)).rejects.toThrow();
      expect(deleteAdjacentStreamState).not.toHaveBeenCalled();
    },
  );

  it('sees metadata replaced by another host after an earlier listing', async () => {
    const id = 'fff666' as ExecutionId;
    await writeExecution(id, '2026-07-15T12:00:00.000Z', config('assistant'));
    expect(await listExecutions()).toEqual([
      expect.not.objectContaining({ description: expect.any(String) }),
    ]);

    await getExecutionStore(id).writeMeta({
      timestamp: '2026-07-15T12:00:00.000Z',
      description: 'Updated by another host',
      outcome: 'completed',
    });

    expect(await listExecutions()).toEqual([
      expect.objectContaining({
        id,
        description: 'Updated by another host',
        outcome: 'completed',
      }),
    ]);
  });

  it('uses the config as the canonical source for visible agent fields', async () => {
    const id = 'aaa111' as ExecutionId;
    const agentConfig = config('assistant');
    await writeExecution(id, '2026-07-15T10:00:00.000Z', agentConfig);

    const entries = await listExecutions();

    expect(entries).toEqual([
      {
        kind: 'run',
        id,
        timestamp: '2026-07-15T10:00:00.000Z',
        identity: { kind: 'agent', agent: 'assistant' },
        record: agentConfig,
      },
    ]);
    expect(entries.filter(isUserVisibleExecution)).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('agent');
    expect(entries[0]).not.toHaveProperty('model');
    expect(entries[0]).not.toHaveProperty('category');
  });

  it('classifies process and incomplete storage rows explicitly', async () => {
    const processId = 'bbb222' as ExecutionId;
    const customBashAgentId = 'ccc333' as ExecutionId;
    const incompleteId = 'ddd444' as ExecutionId;
    const processStore = getExecutionStore(processId);
    await processStore.writeMeta({
      timestamp: '2026-07-15T09:00:00.000Z',
      identity: { kind: 'process', tool: 'assistant' },
    });
    await processStore.writeRunRecord(config('assistant'));
    await writeExecution(
      customBashAgentId,
      '2026-07-15T08:00:00.000Z',
      config('bash'),
    );
    await writeExecution(incompleteId, '2026-07-15T07:00:00.000Z');

    const entries = await listExecutions();

    expect(entries.map(({ kind }) => kind)).toEqual([
      'run',
      'run',
      'incomplete',
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'run',
      identity: { kind: 'process', tool: 'assistant' },
      record: { agent: 'assistant' },
    });
    expect(entries[1]).toMatchObject({
      kind: 'run',
      identity: { kind: 'agent', agent: 'bash' },
      record: { agent: 'bash' },
    });
    expect(entries[2]).toEqual({
      kind: 'incomplete',
      id: incompleteId,
      timestamp: '2026-07-15T07:00:00.000Z',
    });
    expect(entries.filter(isUserVisibleExecution)).toEqual([entries[1]]);
  });

  it('lists an honest non-agent record as kind run without fabricated fields', async () => {
    const id = 'abe001' as ExecutionId;
    const store = getExecutionStore(id);
    await store.writeMeta({
      timestamp: '2026-07-15T04:00:00.000Z',
      identity: { kind: 'process', tool: 'bash' },
    });
    await store.writeRunRecord({ name: 'bash', instruction: 'ls -la' });

    const entries = await listExecutions();
    const entry = entries.find((candidate) => candidate.id === id);
    expect(entry).toMatchObject({
      kind: 'run',
      identity: { kind: 'process', tool: 'bash' },
      record: { name: 'bash', instruction: 'ls -la' },
    });
    expect(entry && 'record' in entry && entry.record).not.toHaveProperty(
      'agentCategory',
    );
    expect(entry && 'record' in entry && entry.record).not.toHaveProperty(
      'model',
    );
    expect(entries.filter(isUserVisibleExecution)).toHaveLength(0);
  });

  it('lists an identity-less row as incomplete and never heals it', async () => {
    // Rows registered before identity stamping lost their reader (#9590
    // Stage 7): no derivation from config or stream-id prefixes, no
    // write-back healing. They degrade to `incomplete`.
    const firstId = 'abc777' as ExecutionId;
    const secondId = 'abc778' as ExecutionId;
    for (const id of [firstId, secondId]) {
      const store = getExecutionStore(id);
      await store.writeMeta({ timestamp: '2026-07-15T06:00:00.000Z' });
      await store.writeRunRecord(config('assistant'));
    }

    const entries = await listExecutions();

    expect(entries.map(({ kind }) => kind)).toEqual([
      'incomplete',
      'incomplete',
    ]);
    // The row stays unstamped on disk: readers never reconstruct identity.
    expect(
      (await getExecutionStore(firstId).readMeta())?.identity,
    ).toBeUndefined();
  });

  it('lists a pre-PR team-run config with the legacy delegation-scope pair as kind run', async () => {
    // Realistic team-run config.json written before the category-keyed
    // delegation-scope record (#8403 era): the scope is the old
    // workflowAgentKeys/toolUseAgentKeys pair. It must normalize at the
    // parse entrance, not fail AgentConfigSchema and list as incomplete.
    const id = 'abc888' as ExecutionId;
    const legacyTeamRunConfig = {
      agent: 'orchestrator',
      model: 'deepseekT',
      instruction: 'Coordinate the team.',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: '/workspace',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflowAgentKeys: ['correct', 'polish'],
        toolUseAgentKeys: ['research', 'review'],
      },
    };
    const store = getExecutionStore(id);
    await store.writeMeta({
      timestamp: '2026-07-15T05:00:00.000Z',
      identity: { kind: 'agent', agent: 'orchestrator' },
    });
    // Persist the raw legacy bytes, bypassing the current input type.
    await store.writeRunRecord(legacyTeamRunConfig as unknown as AgentConfig);

    const entries = await listExecutions();
    const entry = entries.find((candidate) => candidate.id === id);
    expect(entry).toMatchObject({
      kind: 'run',
      identity: { kind: 'agent', agent: 'orchestrator' },
      record: {
        agent: 'orchestrator',
        delegationAgentScope: {
          workflow: ['correct', 'polish'],
          toolUse: ['research', 'review'],
        },
      },
    });
  });

  it('keeps agent-spawned child runs out of history listings', async () => {
    const rootId = 'eee111' as ExecutionId;
    const childId = 'fff222' as ExecutionId;
    await writeExecution(
      rootId,
      '2026-07-15T10:00:00.000Z',
      config('orchestrator'),
    );
    await writeExecution(
      childId,
      '2026-07-15T10:05:00.000Z',
      config('search'),
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
