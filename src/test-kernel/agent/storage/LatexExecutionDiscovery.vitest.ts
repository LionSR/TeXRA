import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentExecutionListingEntry,
  ExecutionListingEntry,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { createLatexExecutionDiscovery } from '@agent/storage/executionListing';
import type { ExecutionId, ExecutionMeta } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn<() => Promise<ExecutionListingEntry[]>>(),
  readStreamMeta:
    vi.fn<(executionId: ExecutionId) => Promise<ExecutionMeta | null>>(),
}));

function agentConfig(
  agent: string,
  model: string,
  inputFiles: readonly string[],
): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    instruction: 'Test latex execution discovery.',
    agentCategory: AgentCategory.ToolUse,
    workingDirectory: '/workspace',
    inputFiles,
  });
}

function agentEntry(
  id: ExecutionId,
  agent: string,
  model: string,
  inputFiles: readonly string[],
  options: {
    readonly timestamp?: string;
    readonly parentExecutionId?: ExecutionId;
  } = {},
): AgentExecutionListingEntry {
  const record = agentConfig(agent, model, inputFiles);
  return {
    kind: 'run',
    id,
    timestamp: options.timestamp ?? '2026-07-15T10:00:00.000Z',
    ...(options.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: options.parentExecutionId }),
    identity: { kind: 'agent', agent },
    record,
  };
}

function processEntry(
  id: ExecutionId = 'bbb222' as ExecutionId,
): ExecutionListingEntry {
  return {
    kind: 'run',
    id,
    timestamp: '2026-07-15T09:00:00.000Z',
    identity: { kind: 'process', tool: 'bash' },
    record: { name: 'bash', instruction: 'ls -la' },
  };
}

function incompleteEntry(
  id: ExecutionId = 'ccc333' as ExecutionId,
): ExecutionListingEntry {
  return {
    kind: 'incomplete',
    id,
    timestamp: '2026-07-15T08:00:00.000Z',
  };
}

function executionMeta(streamId?: ExecutionMeta['streamId']): ExecutionMeta {
  return {
    schemaVersion: 1,
    timestamp: '2026-07-15T10:00:00.000Z',
    ...(streamId === undefined ? {} : { streamId }),
  };
}

function discoveryWithStubbedStorage(): ReturnType<
  typeof createLatexExecutionDiscovery
> {
  return createLatexExecutionDiscovery({
    listExecutions: mocks.listExecutions,
    readStreamMeta: mocks.readStreamMeta,
  });
}

describe('createLatexExecutionDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects agent runs, including delegated children, through the latex discovery filter', async () => {
    const root = agentEntry(
      'root-run' as ExecutionId,
      'assistant',
      'deepseek',
      ['main.tex', 'figures.tex'],
    );
    const delegatedChild = agentEntry(
      'child-run' as ExecutionId,
      'delegated',
      'deepseek',
      ['child.tex'],
      { parentExecutionId: root.id },
    );
    mocks.listExecutions.mockResolvedValue([
      processEntry(),
      root,
      incompleteEntry(),
      delegatedChild,
    ]);

    await expect(
      discoveryWithStubbedStorage().listAgentRuns(),
    ).resolves.toEqual([
      {
        id: root.id,
        timestamp: root.timestamp,
        agent: 'assistant',
        model: 'deepseek',
        inputFiles: ['main.tex', 'figures.tex'],
      },
      {
        id: delegatedChild.id,
        timestamp: delegatedChild.timestamp,
        agent: 'delegated',
        model: 'deepseek',
        inputFiles: ['child.tex'],
      },
    ]);
    expect(mocks.listExecutions).toHaveBeenCalledOnce();
  });

  it('reads the registered stream id from execution metadata', async () => {
    mocks.readStreamMeta.mockResolvedValue(
      executionMeta('polish@earlierModel#exec-agent'),
    );

    await expect(
      discoveryWithStubbedStorage().readStreamId('exec-agent' as ExecutionId),
    ).resolves.toBe('polish@earlierModel#exec-agent');
    expect(mocks.readStreamMeta).toHaveBeenCalledWith('exec-agent');
  });

  it('returns undefined when execution metadata has no registered stream', async () => {
    mocks.readStreamMeta.mockResolvedValue(executionMeta());

    await expect(
      discoveryWithStubbedStorage().readStreamId(
        'exec-no-stream' as ExecutionId,
      ),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when execution metadata is absent', async () => {
    mocks.readStreamMeta.mockResolvedValue(null);

    await expect(
      discoveryWithStubbedStorage().readStreamId('exec-no-meta' as ExecutionId),
    ).resolves.toBeUndefined();
  });
});
