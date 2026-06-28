// Unit tests for `resolveCliResumeSnapshot` branch logic and the user-facing
// `explainNonResumable` strings. The retrieval surface is mocked at its module
// boundaries (history config + runtime resume retrieval + stream-id derivation)
// so the test exercises branching, not storage I/O. The runtime command still
// projects task state and classifies workflow/tool-use configs for real.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  readCliHistoryConfig: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  getStreamTabId: vi.fn(),
}));

vi.mock('@cli/runtime/history', () => ({
  readCliHistoryConfig: mocks.readCliHistoryConfig,
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/runtime/streamTab', () => ({
  getStreamTabId: mocks.getStreamTabId,
}));

const EXECUTION_ID = 'exec-1' as ExecutionId;
const STREAM_ID = 'stream-1';

function toolUseConfig(): AgentConfig {
  // Minimal config: the resolver only reads `agentCategory`, `agent`, `model`.
  return {
    agent: 'planner',
    model: 'gpt-5',
    agentCategory: AgentCategory.ToolUse,
  } as unknown as AgentConfig;
}

function workflowConfig(): AgentConfig {
  return {
    agent: 'correct',
    model: 'gemini31p',
    agentCategory: AgentCategory.Workflow,
    inputFiles: [],
    outputFiles: [],
  } as unknown as AgentConfig;
}

async function resolve(id: ExecutionId = EXECUTION_ID) {
  const { resolveCliResumeSnapshot } =
    await import('@cli/runtime/sessionResume');
  return resolveCliResumeSnapshot(id);
}

describe('resolveCliResumeSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStreamTabId.mockReturnValue(STREAM_ID);
  });

  it('returns not-found when no config exists for the id', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(null);

    const result = await resolve();

    expect(result).toEqual({ kind: 'not-found' });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns load-failed when config lookup fails', async () => {
    mocks.readCliHistoryConfig.mockRejectedValue(new Error('state is locked'));

    const result = await resolve();

    expect(result).toEqual({
      kind: 'load-failed',
      reason: 'state is locked',
    });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns workflow for a workflow config (not continuable here)', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(workflowConfig());

    const result = await resolve();

    expect(result).toEqual({ kind: 'workflow' });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns toolUse with snapshot + streamId when a flow record exists', async () => {
    const config = toolUseConfig();
    const snapshot = {
      executionId: EXECUTION_ID,
      streamId: STREAM_ID,
      agentConfig: { ...config, model: 'gpt-5.5' },
    };
    mocks.readCliHistoryConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });

    const result = await resolve();

    expect(result).toEqual({
      kind: 'toolUse',
      snapshot,
      streamId: STREAM_ID,
      config: snapshot.agentConfig,
    });
    // The stream id is re-derived from agent + model + execution id so resume
    // reuses the original stream/transcript.
    expect(mocks.getStreamTabId).toHaveBeenCalledWith('planner', 'gpt-5', {
      executionId: EXECUTION_ID,
    });
  });

  it('returns no-snapshot for tool-use without a live flow record', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(toolUseConfig());
    mocks.retrieveSessionResumeData.mockResolvedValue(undefined);

    const result = await resolve();

    expect(result).toEqual({ kind: 'no-snapshot' });
  });

  it('returns load-failed when resume state retrieval fails', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(toolUseConfig());
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    const result = await resolve();

    expect(result).toEqual({
      kind: 'load-failed',
      reason: 'KV timeout',
    });
  });

  it('returns no-snapshot when retrieval yields a non-toolUse payload', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(toolUseConfig());
    mocks.retrieveSessionResumeData.mockResolvedValue({ type: 'workflow' });

    const result = await resolve();

    expect(result).toEqual({ kind: 'no-snapshot' });
  });
});

describe('explainNonResumable', () => {
  it('explains each non-tool-use resolution kind', async () => {
    const { explainNonResumable } = await import('@cli/runtime/sessionResume');

    expect(explainNonResumable({ kind: 'not-found' }, EXECUTION_ID)).toBe(
      `Execution not found: ${EXECUTION_ID}`,
    );
    expect(explainNonResumable({ kind: 'workflow' }, EXECUTION_ID)).toBe(
      `Execution ${EXECUTION_ID} is a workflow; only tool-use sessions can be resumed.`,
    );
    expect(explainNonResumable({ kind: 'no-snapshot' }, EXECUTION_ID)).toBe(
      `Execution ${EXECUTION_ID} has no resumable session state (it completed or was cleared).`,
    );
    expect(
      explainNonResumable(
        { kind: 'load-failed', reason: 'KV timeout' },
        EXECUTION_ID,
      ),
    ).toBe(`Failed to load resumable session ${EXECUTION_ID}: KV timeout`);
  });
});
