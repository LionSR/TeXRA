import { beforeEach, describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearStoreCache,
  getExecutionStore,
  isUserVisibleExecution,
  listExecutions,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ExecutionId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

function config(agent: string): AgentConfig {
  return {
    inputFiles: [],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    editedFile: null,
    agent,
    model: 'deepseekT',
    instruction: 'Test execution listing.',
    agentCategory: AgentCategory.ToolUse,
    editedFiles: [],
    toolConfig: DEFAULT_TOOL_CONFIG,
    memories: [],
    workingDirectory: '/workspace',
    cliOutputFile: null,
    cliMultiAgentPresetId: null,
  };
}

async function writeExecution(
  id: ExecutionId,
  timestamp: string,
  agentConfig?: AgentConfig,
  category?: string,
): Promise<void> {
  const store = getExecutionStore(id);
  await store.writeMeta({ timestamp, category });
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
});
