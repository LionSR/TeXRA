import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { registerRun } from '@agent/storage/executionLifecycle';
import { releaseOwnedRunLease } from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
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
function appendLogEntry(streamId: StreamTabId, text: string) {
  return session.commit([
    {
      type: 'log',
      aggregateId: aggregateId('stream', streamId),
      level: LOG_LEVELS.INFO,
      messageType: MESSAGE_TYPES.DEFAULT,
      message: text,
    },
  ]);
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
function writeExecution(
  executionId: RunId,
  meta: { outcome?: RunOutcome; streamId?: StreamTabId } = {},
  executionConfig: AgentConfig = config(),
) {
  return Effect.gen(function* () {
    const streamId = meta.streamId ?? executionId;
    publishTestRunStart(session, streamId, executionId);
    yield* Effect.promise(() => session.settlePublications());
    yield* getRunRecords(session, executionId).writeRunRecord(executionConfig);
    if (meta.outcome)
      yield* session.commit([
        {
          type: 'status',
          aggregateId: aggregateId('stream', streamId),
          phase: meta.outcome,
          cause: 'lifecycle',
        },
      ]);
  });
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

  it.effect(
    'resolves a registered run by its run id without any sidecar scan (#9590 A1)',
    () =>
      Effect.gen(function* () {
        const executionId = 'abc900abc900' as RunId;
        const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
        // The run id is also the stream id, so the read needs no sidecar scan
        // or agent/model reconstruction.
        const registeredId = executionId as StreamTabId;
        yield* registerRun(session, executionId, executionConfig, 'review', {
          streamId: registeredId,
          identity: { kind: 'agent', agent: 'review' },
        });
        yield* Effect.promise(() => releaseOwnedRunLease(executionId));
        yield* appendLogEntry(registeredId, 'registered row');

        const scan = vi.spyOn(
          RunSnapshotStore.prototype,
          'listPersistedStreams',
        );

        const trace = unwrapOkTrace(yield* assembleTrace(executionId, session));

        expect(trace.streamId).toBe(registeredId);
        expect(scan).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'assembles a full trace document from the run id stamped on its metadata',
    () =>
      Effect.gen(function* () {
        const executionId = 'aa11bb22cc33' as RunId;
        const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
        const streamId = executionId;

        yield* writeExecution(
          executionId,
          { outcome: 'completed', streamId },
          executionConfig,
        );
        yield* appendLogEntry(streamId, 'hello');
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
        yield* Effect.promise(() => settleSessionEvents());

        const trace = unwrapOkTrace(yield* assembleTrace(executionId, session));

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
      }),
  );

  it.effect('returns config_missing when no config was ever written', () =>
    Effect.gen(function* () {
      const result = yield* assembleTrace('exec-no-config' as RunId, session);
      expect(result).toEqual({ status: 'config_missing' });
    }),
  );

  it.effect('exports a registered run with an empty transcript', () =>
    Effect.gen(function* () {
      const executionId = 'eec000001' as RunId;
      const streamId = executionId;
      yield* writeExecution(executionId, { streamId });

      const result = yield* assembleTrace(executionId, session);

      expect(unwrapOkTrace(result).entries).toEqual([]);
    }),
  );

  it.effect(
    'resolves a background child run through its stamped metadata',
    () =>
      Effect.gen(function* () {
        // Every run, including a background tool child, uses its run id as the
        // stream id. The metadata remains the authoritative stamped mapping.
        const executionId = 'eec000002' as RunId;
        const executionConfig = config({
          agent: 'orchestrator',
          model: 'deepseekT',
        });
        const actualChildStreamId = executionId as StreamTabId;
        yield* writeExecution(
          executionId,
          { outcome: 'completed', streamId: actualChildStreamId },
          executionConfig,
        );

        yield* appendLogEntry(actualChildStreamId, 'child stream output');

        const trace = unwrapOkTrace(yield* assembleTrace(executionId, session));

        expect(trace.streamId).toBe(actualChildStreamId);
        expect(trace.entries).toHaveLength(1);
      }),
  );
});
