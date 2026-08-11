import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearStoreCache,
  getExecutionStore,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import { listExecutionStreamReferences } from '@agent/storage/executionListing';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

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
      const references = await listExecutionStreamReferences();

      expect(references).toEqual([
        { executionId: referenced, streamId: 'referenced-stream' },
      ]);
      expect(warn).toHaveBeenCalledWith(
        'ExecutionListing',
        expect.stringContaining(`Skipping execution ${malformed}`),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

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

  it('lists a pre-identity row as incomplete, warns once per pass, and never heals it', async () => {
    // Rows registered before identity stamping lost their reader (#9590
    // Stage 7): no derivation from config or stream-id prefixes, no
    // write-back healing. They degrade loudly to `incomplete`.
    const firstId = 'abc777' as ExecutionId;
    const secondId = 'abc778' as ExecutionId;
    for (const id of [firstId, secondId]) {
      const store = getExecutionStore(id);
      await store.writeMeta({ timestamp: '2026-07-15T06:00:00.000Z' });
      await store.writeRunRecord(config('assistant'));
    }
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const entries = await listExecutions();

    expect(entries.map(({ kind }) => kind)).toEqual([
      'incomplete',
      'incomplete',
    ]);
    // One warning per listing pass — a directory of old rows must not spam.
    expect(warn).toHaveBeenCalledTimes(1);
    const [, message] = warn.mock.calls[0] as [string, string];
    expect(message).toContain('2 pre-identity execution row(s)');
    expect(message).toContain('#9590');
    // The row stays unstamped on disk: readers never reconstruct identity.
    expect(
      (await getExecutionStore(firstId).readMeta())?.identity,
    ).toBeUndefined();
    warn.mockRestore();
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
