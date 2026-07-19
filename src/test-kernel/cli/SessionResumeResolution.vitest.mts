// Unit tests for `resolveCliResume` branch logic and the user-facing
// `explainNonResumable` strings. The retrieval surface is mocked at its module
// boundaries (history config + resume retrieval + stream-id derivation) so
// the test exercises pure branching, not storage I/O. `agentConfigToTaskState`
// / `isToolUseTaskState` run for real against minimal configs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ExecutionId } from '@shared/schemas';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

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

async function resolve(id: ExecutionId = EXECUTION_ID) {
  const { resolveCliResume } = await import('@cli/runtime/sessionResume');
  return resolveCliResume(id);
}

describe('resolveCliResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStreamTabId.mockReturnValue(STREAM_ID);
  });

  it('returns not-found when no config exists for the id', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(null);

    const result = await resolve();

    expect(result).toEqual({ type: 'not-found' });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns load-failed when config lookup fails', async () => {
    mocks.readCliHistoryConfig.mockRejectedValue(new Error('state is locked'));

    const result = await resolve();

    expect(result).toEqual({
      type: 'load-failed',
      reason: 'state is locked',
    });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns workflow for a workflow config (not continuable here)', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(workflowConfig());

    const result = await resolve();

    expect(result).toEqual({ type: 'workflow' });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns canonical tool-use state when a flow record exists', async () => {
    const config = toolUseConfig();
    const resume = createToolUseResumeData({
      executionId: EXECUTION_ID,
      streamId: STREAM_ID,
      agentConfig: { ...config, model: 'gpt-5.5' },
    });
    mocks.readCliHistoryConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue(resume);

    const result = await resolve();

    expect(result).toEqual(resume);
    // The stream id is re-derived from agent + model + execution id so resume
    // reuses the original stream/transcript.
    expect(mocks.getStreamTabId).toHaveBeenCalledWith('planner', 'gpt-5', {
      executionId: EXECUTION_ID,
    });
  });

  it('returns no-resume-state without a live flow record', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(toolUseConfig());
    mocks.retrieveSessionResumeData.mockResolvedValue(undefined);

    const result = await resolve();

    expect(result).toEqual({ type: 'no-resume-state' });
  });

  it('returns load-failed when resume state retrieval fails', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(toolUseConfig());
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    const result = await resolve();

    expect(result).toEqual({
      type: 'load-failed',
      reason: 'KV timeout',
    });
  });

  it('returns no-resume-state for a non-toolUse payload', async () => {
    mocks.readCliHistoryConfig.mockResolvedValue(toolUseConfig());
    mocks.retrieveSessionResumeData.mockResolvedValue({ type: 'workflow' });

    const result = await resolve();

    expect(result).toEqual({ type: 'no-resume-state' });
  });
});

describe('explainNonResumable', () => {
  it('explains each non-tool-use resolution type', async () => {
    const { explainNonResumable } = await import('@cli/runtime/sessionResume');

    expect(explainNonResumable({ type: 'not-found' }, EXECUTION_ID)).toBe(
      `Execution not found: ${EXECUTION_ID}`,
    );
    expect(explainNonResumable({ type: 'workflow' }, EXECUTION_ID)).toBe(
      `Execution ${EXECUTION_ID} is a workflow; only tool-use sessions can be resumed.`,
    );
    expect(explainNonResumable({ type: 'no-resume-state' }, EXECUTION_ID)).toBe(
      `Execution ${EXECUTION_ID} has no resumable session state (it completed or was cleared).`,
    );
    expect(
      explainNonResumable(
        { type: 'load-failed', reason: 'KV timeout' },
        EXECUTION_ID,
      ),
    ).toBe(`Failed to load resumable session ${EXECUTION_ID}: KV timeout`);
  });
});
