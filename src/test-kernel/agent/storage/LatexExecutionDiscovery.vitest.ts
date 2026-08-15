import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentExecutionListingEntry,
  ExecutionListingEntry,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { createLatexExecutionDiscovery } from '@agent/storage/executionListing';
import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn(),
  getExecutionStore: vi.fn(),
  readMeta: vi.fn(),
}));

function agentEntry(
  overrides: Partial<AgentConfig> = {},
): AgentExecutionListingEntry {
  return {
    kind: 'run',
    id: 'aaa111' as ExecutionId,
    timestamp: '2026-07-15T10:00:00.000Z',
    identity: { kind: 'agent', agent: overrides.agent ?? 'assistant' },
    record: {
      agent: 'assistant',
      model: 'deepseek',
      inputFiles: ['main.tex', 'figures.tex'],
      ...overrides,
    } as AgentConfig,
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

function discoveryWithStubbedStorage(): ReturnType<
  typeof createLatexExecutionDiscovery
> {
  return createLatexExecutionDiscovery({
    listExecutions: mocks.listExecutions,
    getExecutionStore: mocks.getExecutionStore,
  });
}

describe('createLatexExecutionDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExecutionStore.mockReturnValue({ readMeta: mocks.readMeta });
  });

  it('projects only agent runs with the expected latex discovery fields', async () => {
    const run = agentEntry({
      model: 'deepseek',
      inputFiles: ['main.tex', 'figures.tex'],
    });
    mocks.listExecutions.mockResolvedValue([
      processEntry(),
      run,
      incompleteEntry(),
    ]);

    await expect(
      discoveryWithStubbedStorage().listAgentRuns(),
    ).resolves.toEqual([
      {
        id: run.id,
        timestamp: run.timestamp,
        agent: 'assistant',
        model: 'deepseek',
        inputFiles: ['main.tex', 'figures.tex'],
      },
    ]);
    expect(mocks.listExecutions).toHaveBeenCalledOnce();
  });

  it('reads the registered stream id from execution metadata', async () => {
    mocks.readMeta.mockResolvedValue({
      streamId: 'polish@earlierModel#exec-agent',
    });

    await expect(
      discoveryWithStubbedStorage().readStreamId('exec-agent' as ExecutionId),
    ).resolves.toBe('polish@earlierModel#exec-agent');
    expect(mocks.getExecutionStore).toHaveBeenCalledWith('exec-agent');
  });

  it('returns undefined for an execution without a registered stream', async () => {
    mocks.readMeta.mockResolvedValue(null);

    await expect(
      discoveryWithStubbedStorage().readStreamId(
        'exec-unregistered' as ExecutionId,
      ),
    ).resolves.toBeUndefined();
  });
});
