import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { getExecutionRecords } from '@agent/storage';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
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
import {
  assembleTrace,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';

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
  executionId: ExecutionId,
  meta: { outcome?: RunOutcome; streamId?: StreamTabId } = {},
  executionConfig: AgentConfig = config(),
) {
  return Effect.gen(function* () {
    const streamId =
      meta.streamId ?? getStreamTabId(executionConfig.agent, { executionId });
    publishTestRunStart(session, streamId, executionId);
    yield* Effect.promise(() => session.settlePublications());
    yield* getExecutionRecords(session, executionId).writeRunRecord(
      executionConfig,
    );
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
    'resolves a registered execution from its metadata without any sidecar scan (#9590 A1)',
    () =>
      Effect.gen(function* () {
        const executionId = 'abc900abc900' as ExecutionId;
        const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
        // Registered under a stream the config would NOT derive: proves the
        // read comes from execution metadata, not from agent/model
        // reconstruction.
        const registeredId = `chat@earlierModel#${executionId}` as StreamTabId;
        yield* registerExecution(
          session,
          executionId,
          executionConfig,
          'review',
          {
            streamId: registeredId,
            identity: { kind: 'agent', agent: 'review' },
          },
        );
        yield* Effect.promise(() => releaseOwnedExecutionLease(executionId));
        yield* appendLogEntry(registeredId, 'registered row');

        const scan = vi.spyOn(
          StreamSnapshotStore.prototype,
          'listPersistedStreams',
        );

        const trace = unwrapOkTrace(yield* assembleTrace(executionId, session));

        expect(trace.streamId).toBe(registeredId);
        expect(scan).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'assembles a full trace document from the streamId stamped on execution metadata',
    () =>
      Effect.gen(function* () {
        const executionId = 'aa11bb22cc33' as ExecutionId;
        const executionConfig = config({ agent: 'review', model: 'sonnet46T' });
        const streamId = getStreamTabId('review', { executionId });

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
      const result = yield* assembleTrace(
        'exec-no-config' as ExecutionId,
        session,
      );
      expect(result).toEqual({ status: 'config_missing' });
    }),
  );

  it.effect('exports a registered stream with an empty transcript', () =>
    Effect.gen(function* () {
      const executionId = 'eec000001' as ExecutionId;
      const streamId = getStreamTabId('orchestrator', { executionId });
      yield* writeExecution(executionId, { streamId });

      const result = yield* assembleTrace(executionId, session);

      expect(unwrapOkTrace(result).entries).toEqual([]);
    }),
  );

  it.effect(
    'resolves a tool-format child stream through its stamped metadata, not name derivation',
    () =>
      Effect.gen(function* () {
        // Background child streams (bash/codex/claude subagents, see
        // @tools/delegation/childStream.createChildStream) share
        // getStreamTabId's format but carry a tool-specific prefix, disjoint
        // from any agent name — the stamped meta.streamId is the only mapping
        // that reaches them.
        const executionId = 'eec000002' as ExecutionId;
        const executionConfig = config({
          agent: 'orchestrator',
          model: 'deepseekT',
        });
        const actualChildStreamId = `bash@tool#${executionId}` as StreamTabId;
        expect(actualChildStreamId).not.toBe(
          getStreamTabId('orchestrator', { executionId }),
        );
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
