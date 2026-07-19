import { afterEach, describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import type { Platform } from '@platform/platform';
import {
  EXECUTION_STATUS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { assembleTrace, StreamLogStore } from '@transcript';

const tempDirs: string[] = [];

function buildStoragePlatform(): Promise<Platform> {
  return createTempDirPlatform('texra-trace-', tempDirs);
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    inputFiles: [],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    editedFile: null,
    agent: 'orchestrator',
    model: 'deepseekT',
    instruction: 'Solve the problem.',
    agentCategory: AgentCategory.ToolUse,
    editedFiles: [],
    toolConfig: DEFAULT_TOOL_CONFIG,
    memories: [],
    workingDirectory: '/workspace',
    cliOutputFile: null,
    cliMultiAgentPresetId: null,
    ...overrides,
  };
}

describe('assembleTrace', () => {
  setupPlatform(buildStoragePlatform);

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('assembles a full trace document, deriving streamId from agent/model/executionId', async () => {
    const executionId = 'exec-happy-path' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });

    await getExecutionStore(executionId).writeConfig(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
    });

    const streamId = getStreamTabId('review', 'sonnet46T', { executionId });
    const store = await StreamLogStore.open();
    store.append(streamId, {
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'hello',
    });
    await store.flush();

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.streamId).toBe(streamId);
    expect(result.trace.config.agent).toBe('review');
    expect(result.trace.config.model).toBe('sonnet46T');
    expect(result.trace.entries).toHaveLength(1);
    expect(result.trace.entries[0]).toMatchObject({
      id: 'entry-1',
      text: 'hello',
    });
    expect(result.trace.terminalStatus).toBe(EXECUTION_STATUS.COMPLETED);
    expect(result.trace.snapshot.streamId).toBe(streamId);
  });

  it('returns config_missing when no config was ever written', async () => {
    const result = await assembleTrace('exec-no-config' as ExecutionId);
    expect(result).toEqual({ status: 'config_missing' });
  });

  it('returns streamLogs_missing for a pre-#7057 execution (config exists, streamLogs never persisted)', async () => {
    const executionId = 'exec-no-logs' as ExecutionId;
    await getExecutionStore(executionId).writeConfig(config());

    const result = await assembleTrace(executionId);

    expect(result).toEqual({ status: 'streamLogs_missing' });
  });

  it('resolves a child stream by executionId suffix when its id does not match the derived agent@model#executionId format', async () => {
    // Background child streams (bash/codex/claude subagents, see
    // @tools/childStream.createChildStream) use a tool-specific
    // "${streamPrefix}#executionId" id, not getStreamTabId's
    // "agent@model#executionId" — the config's own agent/model would derive
    // the wrong id entirely for these.
    const executionId = 'exec-child-1' as ExecutionId;
    const executionConfig = config({
      agent: 'orchestrator',
      model: 'deepseekT',
    });
    await getExecutionStore(executionId).writeConfig(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
    });

    const derivedId = getStreamTabId('orchestrator', 'deepseekT', {
      executionId,
    });
    const actualChildStreamId = `bash@tool#${executionId}`;
    expect(actualChildStreamId).not.toBe(derivedId);

    const store = await StreamLogStore.open();
    store.append(actualChildStreamId as ReturnType<typeof getStreamTabId>, {
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'child stream output',
    });
    await store.flush();

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.streamId).toBe(actualChildStreamId);
    expect(result.trace.entries).toHaveLength(1);
  });

  it('returns a null terminalStatus when meta has no recorded outcome', async () => {
    const executionId = 'exec-no-outcome' as ExecutionId;
    const executionConfig = config();
    await getExecutionStore(executionId).writeConfig(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
    });

    const streamId = getStreamTabId(
      executionConfig.agent,
      executionConfig.model,
      { executionId },
    );
    const store = await StreamLogStore.open();
    store.append(streamId, {
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'hello',
    });
    await store.flush();

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.meta).not.toBeNull();
    expect(result.trace.terminalStatus).toBeNull();
  });
});
