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
import type { ExecutionId } from '@shared/schemas';
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
      expect.objectContaining({
        id,
        kind: 'run',
        identity: { kind: 'agent', agent: 'assistant' },
      }),
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
        outcome: 'completed',
      }),
    ]);
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
    // Legacy row: pre-identity metadata with legacy terminal residue, old
    // enough to be safely classified and written back.
    await store.writeMeta({
      timestamp: '2026-07-15T06:00:00.000Z',
      category: 'process',
      terminalStatus: 'interrupted',
    });
    await store.writeConfig(config('bash'));

    const entries = await listExecutions();
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'run',
        identity: { kind: 'process', tool: 'bash' },
        outcome: 'cancelled',
      }),
    ]);

    // The async best-effort write-back stamps identity and outcome durably.
    await vi.waitFor(async () => {
      const healed = await store.readMeta();
      expect(healed?.identity).toEqual({ kind: 'process', tool: 'bash' });
      expect(healed?.outcome).toBe('cancelled');
    });
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
