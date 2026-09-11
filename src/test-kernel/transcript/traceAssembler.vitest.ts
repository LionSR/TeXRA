import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { registerRun } from '@agent/storage/runLifecycle';
import { releaseOwnedRunLease } from '@agent/storage/runLease';
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
import { assembleTrace, StreamLogStore, RunSnapshotStore } from '@transcript';

const tempDirs = useTempDirs();
let session: ReturnType<typeof createTestSession>;

/** Populate the transcript input consumed by the export. */
async function appendLogEntry(runId: RunId, text: string): Promise<void> {
  await Effect.runPromise(
    session.commit([
      {
        type: 'log',
        aggregateId: aggregateId('run', runId),
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

/** Persist a run record plus a meta row for a run. */
async function writeRun(
  runId: RunId,
  meta: { outcome?: RunOutcome } = {},
  runConfigRecord: AgentConfig = config(),
): Promise<void> {
  publishTestRunStart(session, runId);
  await session.settlePublications();
  await Effect.runPromise(
    getRunRecords(session, runId).writeRunRecord(runConfigRecord),
  );
  if (meta.outcome)
    await Effect.runPromise(
      session.commit([
        {
          type: 'status',
          aggregateId: aggregateId('run', runId),
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

  it('assembles a registered run without any sidecar scan (#9590 A1)', async () => {
    const runId = 'abc900abc900' as RunId;
    const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });
    await Effect.runPromise(
      registerRun(session, runId, runConfigRecord, 'review', {
        identity: { kind: 'agent', agent: 'review' },
      }),
    );
    await releaseOwnedRunLease(runId);
    await appendLogEntry(runId, 'registered row');

    const scan = vi.spyOn(RunSnapshotStore.prototype, 'listPersistedRuns');

    const trace = unwrapOkTrace(
      await Effect.runPromise(assembleTrace(runId, session)),
    );

    expect(trace.runId).toBe(runId);
    expect(scan).not.toHaveBeenCalled();
  });

  it('assembles a full trace document for a run', async () => {
    const runId = 'aa11bb22cc33' as RunId;
    const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });

    await writeRun(runId, { outcome: 'completed' }, runConfigRecord);
    await appendLogEntry(runId, 'hello');
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
        aggregateId: aggregateId('run', runId),
        todos,
      },
    ]);
    await settleSessionEvents();

    const trace = unwrapOkTrace(
      await Effect.runPromise(assembleTrace(runId, session)),
    );

    expect(trace.runId).toBe(runId);
    expect(trace.config).toMatchObject({
      agent: 'review',
      model: 'sonnet46T',
    });
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({
      text: 'hello',
    });
    expect(trace.meta?.outcome).toBe('completed');
    expect(trace.snapshot.runId).toBe(runId);
    expect(trace.snapshot.todos).toEqual(todos);
  });

  it('returns config_missing when no config was ever written', async () => {
    const result = await Effect.runPromise(
      assembleTrace('dec0de000001' as RunId, session),
    );
    expect(result).toEqual({ status: 'config_missing' });
  });

  it('exports a registered run with an empty transcript', async () => {
    const runId = 'eec000001' as RunId;
    await writeRun(runId);

    const result = await Effect.runPromise(assembleTrace(runId, session));

    expect(unwrapOkTrace(result).entries).toEqual([]);
  });
});
