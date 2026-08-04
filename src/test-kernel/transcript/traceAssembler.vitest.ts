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
  streamId: ReturnType<typeof getStreamTabId>,
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
    await appendLogEntry(
      registeredId as ReturnType<typeof getStreamTabId>,
      'registered row',
    );

    const scan = vi.spyOn(
      StreamSnapshotStore.prototype,
      'listPersistedStreams',
    );
    const association = vi.spyOn(
      StreamSnapshotStore.prototype,
      'readPersistedStreamAssociation',
    );

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.streamId).toBe(registeredId);
    expect(scan).not.toHaveBeenCalled();
    expect(association).not.toHaveBeenCalled();
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
    await appendLogEntry(streamId, 'hello');

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

  it('returns streamLogs_missing when a config exists but stream logs were never persisted', async () => {
    const executionId = 'exec-no-logs' as ExecutionId;
    await getExecutionStore(executionId).writeConfig(config());

    const result = await assembleTrace(executionId);

    expect(result).toEqual({ status: 'streamLogs_missing' });
  });

  it('reports candidate-only sidecars as ambiguous without choosing the derived fallback', async () => {
    const executionId = 'aaa444aaa444' as ExecutionId;
    const executionConfig = config();
    await getExecutionStore(executionId).writeConfig(executionConfig);

    const first = `orchestrator@old#${executionId}` as StreamTabId;
    const second = `orchestrator@new#${executionId}` as StreamTabId;
    const derived = getStreamTabId(
      executionConfig.agent,
      executionConfig.model,
      { executionId },
    );
    expect(derived).not.toBe(first);
    expect(derived).not.toBe(second);

    const snapshots = new StreamSnapshotStore();
    snapshotFacts(snapshots).setRunConfig(first, executionConfig, executionId);
    snapshotFacts(snapshots).setRunConfig(second, executionConfig, executionId);
    await snapshots.flush();
    await appendLogEntry(first, 'first candidate');
    await appendLogEntry(second, 'second candidate');
    await appendLogEntry(derived, 'derived fallback must not be selected');

    const result = await assembleTrace(executionId);

    expect(result).toEqual({
      status: 'streamId_ambiguous',
      candidateStreamIds: [second, first],
    });
  });

  it('reports candidate-only sidecars as ambiguous even when execution config is absent', async () => {
    const executionId = 'aaa446aaa446' as ExecutionId;
    const first = `orchestrator@old#${executionId}` as StreamTabId;
    const second = `orchestrator@new#${executionId}` as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshotFacts(snapshots).setRunConfig(first, config(), executionId);
    snapshotFacts(snapshots).setRunConfig(second, config(), executionId);
    await snapshots.flush();

    await expect(assembleTrace(executionId)).resolves.toEqual({
      status: 'streamId_ambiguous',
      candidateStreamIds: [second, first],
    });
  });

  it('does not classify children-only associations as ambiguous or choose a fallback', async () => {
    const executionId = 'aaa445aaa445' as ExecutionId;
    const executionConfig = config();
    await getExecutionStore(executionId).writeConfig(executionConfig);

    const parent = 'orchestrator@model#parent' as StreamTabId;
    const firstChild = `bash@tool#${executionId}` as StreamTabId;
    const secondChild = `codex@tool#${executionId}` as StreamTabId;
    const derived = getStreamTabId(
      executionConfig.agent,
      executionConfig.model,
      { executionId },
    );
    const snapshots = new StreamSnapshotStore();
    snapshotFacts(snapshots).setRunConfig(
      firstChild,
      config({ agent: 'bash' }),
      executionId,
    );
    snapshotFacts(snapshots).setParentStream(firstChild, parent);
    snapshotFacts(snapshots).setRunConfig(
      secondChild,
      config({ agent: 'codex' }),
      executionId,
    );
    snapshotFacts(snapshots).setParentStream(secondChild, parent);
    await snapshots.flush();
    await appendLogEntry(firstChild, 'first child must not be selected');
    await appendLogEntry(secondChild, 'second child must not be selected');
    await appendLogEntry(derived, 'derived fallback must not be selected');

    await expect(assembleTrace(executionId)).resolves.toEqual({
      status: 'streamLogs_missing',
    });
  });

  it('resolves a child stream by executionId suffix when its id does not match the derived agent@model#executionId format', async () => {
    // Background child streams (bash/codex/claude subagents, see
    // @tools/delegation/childStream.createChildStream) use a tool-specific
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

    await appendLogEntry(
      actualChildStreamId as ReturnType<typeof getStreamTabId>,
      'child stream output',
    );

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
    await appendLogEntry(streamId, 'hello');

    const result = await assembleTrace(executionId);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.meta).not.toBeNull();
    expect(result.trace.terminalStatus).toBeNull();
  });
});
