// Unit tests for `readCliToolUseResumeData`, the CLI's retrieval feed for the
// shared resume funnel. The retrieval surface is mocked at its module
// boundaries (resume retrieval + execution metadata) so the test exercises
// pure branching, not storage I/O. The agent-category branch runs for real
// against minimal configs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ExecutionId } from '@shared/schemas';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const mocks = vi.hoisted(() => ({
  retrieveSessionResumeData: vi.fn(),
  readMeta: vi.fn(),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: () => ({ readMeta: mocks.readMeta }),
}));

const EXECUTION_ID = 'exec-1' as ExecutionId;
const STREAM_ID = 'stream-1';

function toolUseConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'planner',
    model: 'gpt-5',
    agentCategory: AgentCategory.ToolUse,
  });
}

function workflowConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini31p',
    agentCategory: AgentCategory.Workflow,
  });
}

async function read(config: AgentConfig, id: ExecutionId = EXECUTION_ID) {
  const { readCliToolUseResumeData } =
    await import('@cli/runtime/toolUseResumeData');
  return readCliToolUseResumeData(id, config);
}

describe('readCliToolUseResumeData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-07-31T00:00:00.000Z',
      streamId: STREAM_ID,
      identity: { kind: 'agent', agent: 'planner' },
    });
  });

  it('returns null for a workflow config (resumed via the shared funnel)', async () => {
    expect(await read(workflowConfig())).toBeNull();
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns canonical tool-use state when a flow record exists', async () => {
    const config = toolUseConfig();
    const resume = createToolUseResumeData({
      executionId: EXECUTION_ID,
      streamId: STREAM_ID,
      agentConfig: { ...config, model: 'gpt-5.5' },
    });
    mocks.retrieveSessionResumeData.mockResolvedValue(resume);

    expect(await read(config)).toEqual(resume);
    // The stream id is the one stamped on execution metadata at registration,
    // never re-derived from agent/model, so resume reuses the original
    // stream/transcript.
    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      STREAM_ID,
      EXECUTION_ID,
      config,
    );
  });

  it('returns null when metadata carries no stamped stream id', async () => {
    // A row without a stamped streamId has no persisted stream: not resumable.
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-07-31T00:00:00.000Z',
      identity: { kind: 'agent', agent: 'planner' },
    });

    expect(await read(toolUseConfig())).toBeNull();
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns null without a live flow record', async () => {
    mocks.retrieveSessionResumeData.mockResolvedValue(undefined);

    expect(await read(toolUseConfig())).toBeNull();
  });

  it('propagates retrieval failures for the active-resume path to surface', async () => {
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    await expect(read(toolUseConfig())).rejects.toThrow('KV timeout');
  });

  it('discards a non-toolUse resume payload', async () => {
    mocks.retrieveSessionResumeData.mockResolvedValue({ type: 'workflow' });

    expect(await read(toolUseConfig())).toBeNull();
  });
});
