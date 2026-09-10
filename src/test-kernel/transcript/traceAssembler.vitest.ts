import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { registerRun } from '@agent/storage/runLifecycle';
import { releaseOwnedRunLease } from '@agent/storage/runLease';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/runTab';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import {
  aggregateId,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type RunId,
  type RunOutcome,
  type RunId,
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
  RunSnapshotStore,
} from '@transcript';

const tempDirs = useTempDirs();
let session: ReturnType<typeof createTestSession>;

/** Populate the transcript input consumed by the export. */
async function appendLogEntry(
  runId: RunId,
  text: string,
): Promise<void> {
  await Effect.runPromise(
    session.commit([
      {
        type: 'log',
        aggregateId: aggregateId('stream', runId),
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
  meta: { outcome?: RunOutcome; runId?: RunId } = {},
  runConfigRecord: AgentConfig = config(),
): Promise<void> {
  const runId =
    meta.runId ?? getStreamTabId(runConfigRecord.agent, { runId });
  publishTestRunStart(session, runId, runId);
  await session.settlePublications();
  await Effect.runPromise(
    getRunRecords(session, runId).writeRunRecord(runConfigRecord),
  );
  if (meta.outcome)
    await Effect.runPromise(
      session.commit([
        {
          type: 'status',
          aggregateId: aggregateId('stream', runId),
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

  it('resolves a registered run from its metadata without any sidecar scan (#9590 A1)', async () => {
    const runId = 'abc900abc900' as RunId;
    const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });
    // Registered under a stream the config would NOT derive: proves the read
    // comes from run metadata, not from agent/model reconstruction.
    const registeredId = `chat@earlierModel#${runId}` as RunId;
    await Effect.runPromise(
      registerRun(session, runId, runConfigRecord, 'review', {
        runId: registeredId,
        identity: { kind: 'agent', agent: 'review' },
      }),
    );
    await releaseOwnedRunLease(runId);
    await appendLogEntry(registeredId, 'registered row');

    const scan = vi.spyOn(
      RunSnapshotStore.prototype,
      'listPersistedRuns',
    );

    const trace = unwrapOkTrace(
      await Effect.runPromise(assembleTrace(runId, session)),
    );

    expect(trace.runId).toBe(registeredId);
    expect(scan).not.toHaveBeenCalled();
  });

  it('assembles a full trace document from the runId stamped on run metadata', async () => {
    const runId = 'aa11bb22cc33' as RunId;
    const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });
    const runId = getStreamTabId('review', { runId });

    await writeRun(
      runId,
      { outcome: 'completed', runId },
      runConfigRecord,
    );
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
        aggregateId: aggregateId('stream', runId),
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
      assembleTrace('exec-no-config' as RunId, session),
    );
    expect(result).toEqual({ status: 'config_missing' });
  });

  it('exports a registered stream with an empty transcript', async () => {
    const runId = 'eec000001' as RunId;
    const runId = getStreamTabId('orchestrator', { runId });
    await writeRun(runId, { runId });

    const result = await Effect.runPromise(assembleTrace(runId, session));

    expect(unwrapOkTrace(result).entries).toEqual([]);
  });

  it('resolves a tool-format child stream through its stamped metadata, not name derivation', async () => {
    // Background child runs (bash/codex/claude subagents, see
    // @tools/delegation/childRun.createChildRun) share getStreamTabId's
    // format but carry a tool-specific prefix, disjoint from any agent name —
    // the stamped meta.runId is the only mapping that reaches them.
    const runId = 'eec000002' as RunId;
    const runConfigRecord = config({
      agent: 'orchestrator',
      model: 'deepseekT',
    });
    const actualChildRunId = `bash@tool#${runId}` as RunId;
    expect(actualChildRunId).not.toBe(
      getStreamTabId('orchestrator', { runId }),
    );
    await writeRun(
      runId,
      { outcome: 'completed', runId: actualChildRunId },
      runConfigRecord,
    );

    await appendLogEntry(actualChildRunId, 'child stream output');

    const trace = unwrapOkTrace(
      await Effect.runPromise(assembleTrace(runId, session)),
    );

    expect(trace.runId).toBe(actualChildRunId);
    expect(trace.entries).toHaveLength(1);
  });
});
