import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { settleSessionEvents } from '@test/agent/progressTestUtils';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { appendTranscriptEntry } from '@test/support/storeTestDrivers';
import {
  assembleTrace,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';

const tempDirs = useTempDirs();

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

/** Persist a run record plus a meta row for an execution. */
async function writeExecution(
  executionId: ExecutionId,
  meta: { outcome?: RunOutcome; streamId?: StreamTabId } = {},
  executionConfig: AgentConfig = config(),
): Promise<void> {
  const store = getExecutionStore(executionId);
  await store.writeRunRecord(executionConfig);
  await store.writeMeta({ timestamp: '2026-07-05T00:00:00.000Z', ...meta });
}

type AssembleTraceResult = Effect.Success<ReturnType<typeof assembleTrace>>;

/** Assert the ok branch and hand back the trace, narrowing for the caller. */
function unwrapOkTrace(result: AssembleTraceResult) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') {
    throw new Error(`expected an ok trace, got ${result.status}`);
  }
  return result.trace;
}

describe('assembleTrace', () => {
  setupPlatform(() => createTempDirPlatform('texra-trace-', tempDirs));

  afterEach(async () => {
    vi.restoreAllMocks();
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

    const trace = unwrapOkTrace(
      await Effect.runPromise(
        assembleTrace(executionId, createTestSession().snapshots),
      ),
    );

    expect(trace.streamId).toBe(registeredId);
    expect(scan).not.toHaveBeenCalled();
  });

  it('assembles a full trace document from the streamId stamped on execution metadata', async () => {
    const executionId = 'aa11bb22cc33' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    const streamId = getStreamTabId('review', { executionId });

    await writeExecution(
      executionId,
      { outcome: 'completed', streamId },
      executionConfig,
    );
    await appendLogEntry(streamId, 'hello');
    const session = createTestSession();
    publishTestRunStart(session, streamId, executionId);
    const todos = [
      {
        content: 'Check the argument',
        activeForm: 'Checking the argument',
        status: 'pending' as const,
      },
    ];
    session.publish([
      {
        type: 'updateTodos',
        aggregateId: aggregateId('stream', streamId),
        todos,
      },
    ]);
    await settleSessionEvents();

    const trace = unwrapOkTrace(
      await Effect.runPromise(assembleTrace(executionId, session.snapshots)),
    );

    expect(trace.streamId).toBe(streamId);
    expect(trace.config).toMatchObject({
      agent: 'review',
      model: 'sonnet46T',
    });
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({
      id: 'entry-1',
      text: 'hello',
    });
    expect(trace.meta?.outcome).toBe('completed');
    expect(trace.snapshot.streamId).toBe(streamId);
    expect(trace.snapshot.todos).toEqual(todos);
  });

  it('returns config_missing when no config was ever written', async () => {
    const result = await Effect.runPromise(
      assembleTrace(
        'exec-no-config' as ExecutionId,
        createTestSession().snapshots,
      ),
    );
    expect(result).toEqual({ status: 'config_missing' });
  });

  it('returns streamLogs_missing when metadata carries no stamped stream id', async () => {
    const executionId = 'exec-no-logs' as ExecutionId;
    await getExecutionStore(executionId).writeRunRecord(config());

    const result = await Effect.runPromise(
      assembleTrace(executionId, createTestSession().snapshots),
    );

    expect(result).toEqual({ status: 'streamLogs_missing' });
  });

  it('returns streamLogs_missing when the stamped stream has no persisted log', async () => {
    const executionId = 'exec-empty-stream' as ExecutionId;
    const streamId = getStreamTabId('orchestrator', { executionId });
    await writeExecution(executionId, { streamId });

    const result = await Effect.runPromise(
      assembleTrace(executionId, createTestSession().snapshots),
    );

    expect(result).toEqual({ status: 'streamLogs_missing' });
  });

  it('resolves a tool-format child stream through its stamped metadata, not name derivation', async () => {
    // Background child streams (bash/codex/claude subagents, see
    // @tools/delegation/childStream.createChildStream) share getStreamTabId's
    // format but carry a tool-specific prefix, disjoint from any agent name —
    // the stamped meta.streamId is the only mapping that reaches them.
    const executionId = 'exec-child-1' as ExecutionId;
    const executionConfig = config({
      agent: 'orchestrator',
      model: 'deepseekT',
    });
    const actualChildStreamId = `bash@tool#${executionId}` as StreamTabId;
    expect(actualChildStreamId).not.toBe(
      getStreamTabId('orchestrator', { executionId }),
    );
    await writeExecution(
      executionId,
      { outcome: 'completed', streamId: actualChildStreamId },
      executionConfig,
    );

    await appendLogEntry(actualChildStreamId, 'child stream output');

    const trace = unwrapOkTrace(
      await Effect.runPromise(
        assembleTrace(executionId, createTestSession().snapshots),
      ),
    );

    expect(trace.streamId).toBe(actualChildStreamId);
    expect(trace.entries).toHaveLength(1);
  });
});
