import { afterEach, describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  EXECUTION_STATUS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import {
  assembleTrace,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';

const tempDirs: string[] = [];

/** Persists a single stream-log entry so the stream is discoverable on disk. */
async function appendLogEntry(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  const store = await StreamLogStore.open();
  appendTranscriptEntry(store, streamId, {
    id: 'entry-1',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.DEFAULT,
    text,
  });
  await store.flush();
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'orchestrator',
    model: 'deepseekT',
    instruction: 'Solve the problem.',
    agentCategory: AgentCategory.ToolUse,
    workingDirectory: '/workspace',
    ...overrides,
  });
}

describe('assembleTrace', () => {
  setupPlatform(() => createTempDirPlatform('texra-trace-', tempDirs));

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  it('resolves a registered execution from its metadata without any sidecar scan (#9590 A1)', async () => {
    const executionId = 'abc900abc900' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    // Registered under a stream the config would NOT derive: proves the read
    // comes from execution metadata, not from agent/model reconstruction.
    const registeredId = `chat@earlierModel#${executionId}` as StreamTabId;
    await registerExecution(executionId, executionConfig, 'review', {
      streamId: registeredId,
      identity: { kind: 'agent', agent: 'review' },
    });
    await releaseOwnedExecutionLease(executionId);
    await appendLogEntry(registeredId, 'registered row');

    const scan = vi.spyOn(
      StreamSnapshotStore.prototype,
      'listPersistedStreams',
    );

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.streamId).toBe(registeredId);
    expect(scan).not.toHaveBeenCalled();
  });

  it('assembles a full trace document from the streamId stamped on execution metadata', async () => {
    const executionId = 'exec-happy-path' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    const streamId = getStreamTabId('review', { executionId });

    await getExecutionStore(executionId).writeRunRecord(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
      streamId,
    });
    await appendLogEntry(streamId, 'hello');

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.streamId).toBe(streamId);
    expect(result.trace.config).toMatchObject({
      agent: 'review',
      model: 'sonnet46T',
    });
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

  it('returns streamLogs_missing when metadata carries no stamped stream id', async () => {
    const executionId = 'exec-no-logs' as ExecutionId;
    await getExecutionStore(executionId).writeRunRecord(config());

    const result = await assembleTrace(executionId);

    expect(result).toEqual({ status: 'streamLogs_missing' });
  });

  it('returns streamLogs_missing when the stamped stream has no persisted log', async () => {
    const executionId = 'exec-empty-stream' as ExecutionId;
    const streamId = getStreamTabId('orchestrator', { executionId });
    await getExecutionStore(executionId).writeRunRecord(config());
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      streamId,
    });

    const result = await assembleTrace(executionId);

    expect(result).toEqual({ status: 'streamLogs_missing' });
  });

  it('never resolves a stream from sidecar candidates when metadata has no stamp', async () => {
    const executionId = 'aaa444aaa444' as ExecutionId;
    const executionConfig = config();
    await getExecutionStore(executionId).writeRunRecord(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
    });

    // Sidecar candidates that the deleted legacy resolver would have found —
    // and a stream whose name embeds the execution id: neither may resolve.
    const first = `orchestrator@old#${executionId}` as StreamTabId;
    const second = `orchestrator@new#${executionId}` as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshotFacts(snapshots).setRunConfig(first, executionConfig, executionId);
    snapshotFacts(snapshots).setRunConfig(second, executionConfig, executionId);
    await snapshots.flush();
    await appendLogEntry(first, 'first candidate must not be selected');
    await appendLogEntry(second, 'second candidate must not be selected');

    await expect(assembleTrace(executionId)).resolves.toEqual({
      status: 'streamLogs_missing',
    });
  });

  it('resolves a tool-format child stream through its stamped metadata, not name derivation', async () => {
    // Background child streams (bash/codex/claude subagents, see
    // @tools/delegation/childStream.createChildStream) use a tool-specific
    // "${streamPrefix}#executionId" id, not getStreamTabId's format — the
    // stamped meta.streamId is the only mapping that reaches them.
    const executionId = 'exec-child-1' as ExecutionId;
    const executionConfig = config({
      agent: 'orchestrator',
      model: 'deepseekT',
    });
    const actualChildStreamId = `bash@tool#${executionId}` as StreamTabId;
    expect(actualChildStreamId).not.toBe(
      getStreamTabId('orchestrator', { executionId }),
    );
    await getExecutionStore(executionId).writeRunRecord(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
      streamId: actualChildStreamId,
    });

    await appendLogEntry(actualChildStreamId, 'child stream output');

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.streamId).toBe(actualChildStreamId);
    expect(result.trace.entries).toHaveLength(1);
  });

  it('returns a null terminalStatus when meta has no recorded outcome', async () => {
    const executionId = 'exec-no-outcome' as ExecutionId;
    const executionConfig = config();
    const streamId = getStreamTabId(executionConfig.agent, { executionId });
    await getExecutionStore(executionId).writeRunRecord(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      streamId,
    });
    await appendLogEntry(streamId, 'hello');

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.meta).not.toBeNull();
    expect(result.trace.terminalStatus).toBeNull();
  });
});
