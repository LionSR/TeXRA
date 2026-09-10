import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { registerRun } from '@agent/storage/executionLifecycle';
import { releaseOwnedRunLease } from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type RunId,
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
import { assembleTrace, RunLogStore, RunSnapshotStore } from '@transcript';

const tempDirs = useTempDirs();
let session: ReturnType<typeof createTestSession>;

/** Populate the transcript input consumed by the export. */
async function appendLogEntry(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  await Effect.runPromise(
    session.commit([
      {
        type: 'log',
        aggregateId: aggregateId('stream', streamId),
        level: LOG_LEVELS.INFO,
        messageType: MESSAGE_TYPES.DEFAULT,
        message: text,
      },
    ]),
  );
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
  executionId: RunId,
  meta: { outcome?: RunOutcome; streamId?: StreamTabId } = {},
  executionConfig: AgentConfig = config(),
): Promise<void> {
  const streamId =
    meta.streamId ?? getStreamTabId(executionConfig.agent, { executionId });
  publishTestRunStart(session, streamId, executionId);
  await session.settlePublications();
  await Effect.runPromise(
    getRunRecords(session, executionId).writeRunRecord(executionConfig),
  );
  if (meta.outcome)
    await Effect.runPromise(
      session.commit([
        {
          type: 'status',
          aggregateId: aggregateId('stream', streamId),
          phase: meta.outcome,
          cause: 'lifecycle',
        },
      ]),
    );
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

  beforeEach(() => {
    session = createTestSession({ roots: processWorkspaceRoots() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('resolves a registered execution from its metadata without any sidecar scan (#9590 A1)', async () => {
    const executionId = 'abc900abc900' as RunId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    // Registered under a stream the config would NOT derive: proves the read
    // comes from execution metadata, not from agent/model reconstruction.
    const registeredId = `chat@earlierModel#${executionId}` as StreamTabId;
    await Effect.runPromise(
      registerRun(session, executionId, executionConfig, 'review', {
        streamId: registeredId,
        identity: { kind: 'agent', agent: 'review' },
      }),
    );
    await releaseOwnedRunLease(executionId);
    await appendLogEntry(registeredId, 'registered row');

    const scan = vi.spyOn(RunSnapshotStore.prototype, 'listPersistedStreams');

    const trace = unwrapOkTrace(
      await Effect.runPromise(assembleTrace(executionId, session)),
    );

    expect(trace.streamId).toBe(registeredId);
    expect(scan).not.toHaveBeenCalled();
  });

  it('assembles a full trace document from the streamId stamped on execution metadata', async () => {
    const executionId = 'aa11bb22cc33' as RunId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
    const streamId = getStreamTabId('review', { executionId });

    await writeExecution(
      executionId,
      { outcome: 'completed', streamId },
      executionConfig,
    );
    await appendLogEntry(streamId, 'hello');
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
      await Effect.runPromise(assembleTrace(executionId, session)),
    );

    expect(trace.streamId).toBe(streamId);
    expect(trace.config).toMatchObject({
      agent: 'review',
      model: 'sonnet46T',
    });
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({
      text: 'hello',
    });
    expect(trace.meta?.outcome).toBe('completed');
    expect(trace.snapshot.streamId).toBe(streamId);
    expect(trace.snapshot.todos).toEqual(todos);
  });

  it('returns config_missing when no config was ever written', async () => {
    const result = await Effect.runPromise(
      assembleTrace('exec-no-config' as RunId, session),
    );
    expect(result).toEqual({ status: 'config_missing' });
  });

  it('exports a registered stream with an empty transcript', async () => {
    const executionId = 'eec000001' as RunId;
    const streamId = getStreamTabId('orchestrator', { executionId });
    await writeExecution(executionId, { streamId });

    const result = await Effect.runPromise(assembleTrace(executionId, session));

    expect(unwrapOkTrace(result).entries).toEqual([]);
  });

  it('resolves a tool-format child stream through its stamped metadata, not name derivation', async () => {
    // Background child streams (bash/codex/claude subagents, see
    // @tools/delegation/childStream.createChildStream) share getStreamTabId's
    // format but carry a tool-specific prefix, disjoint from any agent name —
    // the stamped meta.streamId is the only mapping that reaches them.
    const executionId = 'eec000002' as RunId;
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
      await Effect.runPromise(assembleTrace(executionId, session)),
    );

    expect(trace.streamId).toBe(actualChildStreamId);
    expect(trace.entries).toHaveLength(1);
  });
});
