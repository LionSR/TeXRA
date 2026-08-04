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
import type { ExecutionId, StreamTabId } from '@shared/schemas';
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
  await store.writeMeta({ timestamp, parentExecutionId });
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
    await writeExecution(id, '2026-07-15T11:00:00.000Z', config('assistant'));

    expect(await listExecutions()).toEqual([
      expect.objectContaining({
        id,
        kind: 'run',
        identity: { kind: 'agent', agent: 'assistant' },
      }),
    ]);
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
        agentConfig,
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
    await processStore.writeConfig(config('assistant'));
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
      agentConfig: { agent: 'assistant' },
    });
    expect(entries[1]).toMatchObject({
      kind: 'run',
      identity: { kind: 'agent', agent: 'bash' },
      agentConfig: { agent: 'bash' },
    });
    expect(entries[2]).toEqual({
      kind: 'incomplete',
      id: incompleteId,
      timestamp: '2026-07-15T07:00:00.000Z',
    });
    expect(entries.filter(isUserVisibleExecution)).toEqual([entries[1]]);
  });

  it('heals unstamped legacy rows durably on the listing read', async () => {
    const legacyId = 'abc777' as ExecutionId;
    const store = getExecutionStore(legacyId);
    // Legacy row: pre-identity metadata, old enough to be safely classified
    // and written back. No stream-prefix evidence → native agent.
    await store.writeMeta({ timestamp: '2026-07-15T06:00:00.000Z' });
    await store.writeConfig(config('assistant'));

    const entries = await listExecutions();
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'run',
        identity: { kind: 'agent', agent: 'assistant' },
      }),
    ]);

    // The async best-effort write-back stamps the derived identity durably.
    await vi.waitFor(async () => {
      const healed = await store.readMeta();
      expect(healed?.identity).toEqual({ kind: 'agent', agent: 'assistant' });
    });
  });

  it('stamps the four legacy cohorts from quarantined stream-prefix evidence', async () => {
    // Pre-identity rows carried their run kind only in the stream-id prefix.
    // One fixture per real cohort, asserting both the stamped identity and
    // that resume gating (isNativeAgentRun: kind 'agent' with no tool) keeps
    // excluding the non-native ones after healing.
    const isNativeAgentRun = (identity: {
      kind: string;
      tool?: string;
    }): boolean => identity.kind === 'agent' && identity.tool === undefined;
    const cohorts = [
      {
        id: 'aaa001' as ExecutionId,
        streamId: 'bash@tool#aaa001',
        agent: 'bash',
        identity: { kind: 'process', tool: 'bash' },
      },
      {
        id: 'aaa002' as ExecutionId,
        streamId: 'workflow-script#aaa002',
        agent: 'engineer',
        identity: { kind: 'multiAgentWorkflow', workflowName: 'engineer' },
      },
      {
        id: 'aaa003' as ExecutionId,
        streamId: 'codex@codex-sdk#aaa003',
        agent: 'coder',
        identity: { kind: 'agent', agent: 'coder', tool: 'codex' },
      },
      {
        id: 'aaa004' as ExecutionId,
        streamId: 'claude@agent-sdk#aaa004',
        agent: 'assistant',
        identity: { kind: 'agent', agent: 'assistant', tool: 'claude_code' },
      },
    ] as const;

    for (const cohort of cohorts) {
      const store = getExecutionStore(cohort.id);
      await store.writeMeta({
        timestamp: '2026-07-15T06:00:00.000Z',
        streamId: cohort.streamId as StreamTabId,
      });
      await store.writeConfig(config(cohort.agent));
    }

    const entries = await listExecutions();
    for (const cohort of cohorts) {
      const entry = entries.find((candidate) => candidate.id === cohort.id);
      expect(entry).toMatchObject({ kind: 'run', identity: cohort.identity });
      expect(isNativeAgentRun(cohort.identity)).toBe(false);
    }

    // The durable stamp carries the same prefix-derived identity.
    for (const cohort of cohorts) {
      await vi.waitFor(async () => {
        const healed = await getExecutionStore(cohort.id).readMeta();
        expect(healed?.identity).toEqual(cohort.identity);
      });
    }
  });

  it('heals legacy terminalStatus raw bytes into the canonical outcome', async () => {
    const interruptedId = 'abd001' as ExecutionId;
    const junkId = 'abd002' as ExecutionId;
    const interruptedStore = getExecutionStore(interruptedId);
    // terminalStatus no longer exists on ExecutionMetaSchema, so the typed
    // writer would strip it — persist the raw legacy bytes directly.
    await interruptedStore.write('meta', {
      timestamp: '2026-07-15T06:00:00.000Z',
      terminalStatus: 'interrupted',
    });
    await interruptedStore.writeConfig(config('assistant'));
    const junkStore = getExecutionStore(junkId);
    await junkStore.write('meta', {
      timestamp: '2026-07-15T05:30:00.000Z',
      terminalStatus: 'exploded',
    });
    await junkStore.writeConfig(config('assistant'));

    // The first listing read already surfaces the converted outcome.
    const entries = await listExecutions();
    expect(
      entries.find((candidate) => candidate.id === interruptedId),
    ).toMatchObject({ kind: 'run', outcome: 'cancelled' });
    expect(entries.find((candidate) => candidate.id === junkId)).toMatchObject({
      kind: 'run',
      outcome: 'failed',
    });

    // The durable stamp converts the raw evidence before any schema-shaped
    // rewrite would strip it forever.
    await vi.waitFor(async () => {
      const healed = await interruptedStore.readMeta();
      expect(healed?.identity).toEqual({ kind: 'agent', agent: 'assistant' });
      expect(healed?.outcome).toBe('cancelled');
    });
    await vi.waitFor(async () => {
      expect((await junkStore.readMeta())?.outcome).toBe('failed');
    });
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
    await store.writeConfig(legacyTeamRunConfig as unknown as AgentConfig);

    const entries = await listExecutions();
    const entry = entries.find((candidate) => candidate.id === id);
    expect(entry).toMatchObject({
      kind: 'run',
      identity: { kind: 'agent', agent: 'orchestrator' },
      agentConfig: {
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
