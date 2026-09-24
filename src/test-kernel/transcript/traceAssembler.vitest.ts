import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { registerRun } from '@agent/storage/runLifecycle';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  aggregateId,
  emptyRunEndOutput,
  LOG_LEVELS,
  MESSAGE_TYPES,
  type RunId,
  type RunOutcome,
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
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
import { assembleTrace } from '@transcript';

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

/** Persist a run record plus, when given, the run's terminal outcome. */
async function writeRun(
  runId: RunId,
  meta: { outcome?: RunOutcome } = {},
  runConfigRecord: AgentConfig = config(),
): Promise<void> {
  publishTestRunStart(session, runId);
  await Effect.runPromise(session.settlePublications());
  await Effect.runPromise(
    getRunRecords(session, runId).writeRunRecord(runConfigRecord),
  );
  // The terminal fact is `run.end`; the view's outcome is folded from it.
  if (meta.outcome)
    await Effect.runPromise(
      session.commit([
        {
          type: 'run.end',
          aggregateId: aggregateId('run', runId),
          outcome: meta.outcome,
          output: emptyRunEndOutput(AgentCategory.ToolUse),
        },
      ]),
    );
}

type AssembleTraceResult = Effect.Success<ReturnType<typeof assembleTrace>>;

/** Assert the ok branch and hand back the result, narrowing for the caller. */
function unwrapOk(result: AssembleTraceResult) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') {
    throw new Error(`expected an ok trace, got ${result.status}`);
  }
  return result;
}

describe('assembleTrace', () => {
  setupPlatform(() => createTempDirPlatform('texra-trace-', tempDirs));

  beforeEach(() => {
    session = createTestSession({ roots: testWorkspaceRoots() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it.effect('assembles a registered run from its folded view', () =>
    Effect.gen(function* () {
      const runId = 'abc900abc900' as RunId;
      const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });
      yield* registerRun(session, runId, runConfigRecord, {
        identity: { kind: 'agent', agent: 'review' },
      });
      yield* Effect.promise(() => appendLogEntry(runId, 'registered row'));

      const { trace } = unwrapOk(yield* assembleTrace(runId, session));

      expect(trace.runId).toBe(runId);
    }),
  );

  it.effect('assembles a full trace document for a run', () =>
    Effect.gen(function* () {
      const runId = 'aa11bb22cc33' as RunId;
      const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });

      yield* Effect.promise(() =>
        writeRun(runId, { outcome: 'completed' }, runConfigRecord),
      );
      yield* Effect.promise(() => appendLogEntry(runId, 'hello'));
      const todos = [
        {
          content: 'Check the argument',
          activeForm: 'Checking the argument',
          status: 'pending' as const,
        },
      ];
      session.publish([
        {
          type: 'run.fact',
          aggregateId: aggregateId('run', runId),
          fact: { key: 'todos', todos },
        },
      ]);
      yield* Effect.promise(() => settleSessionEvents());

      const { trace, record } = unwrapOk(yield* assembleTrace(runId, session));

      expect(trace.runId).toBe(runId);
      expect(record).toMatchObject({ agent: 'review', model: 'sonnet46T' });
      // The creation row is authored, not copied: an exported file has no
      // producer, no siblings and no writable host.
      expect(trace.events[0]).toMatchObject({
        type: 'run.start',
        ownerId: null,
        parent: null,
        checkpointId: null,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      });
      expect(trace.events).toContainEqual(
        expect.objectContaining({ type: 'log', message: 'hello' }),
      );
      expect(trace.events).toContainEqual(
        expect.objectContaining({ type: 'run.end', outcome: 'completed' }),
      );
      expect(trace.events).toContainEqual(
        expect.objectContaining({
          type: 'run.fact',
          fact: { key: 'todos', todos },
        }),
      );
    }),
  );

  it.effect('returns config_missing when no config was ever written', () =>
    Effect.gen(function* () {
      const result = yield* assembleTrace('dec0de000001' as RunId, session);
      expect(result).toEqual({ status: 'config_missing' });
    }),
  );

  it.effect('exports a registered run with an empty transcript', () =>
    Effect.gen(function* () {
      const runId = 'eec000001' as RunId;
      yield* Effect.promise(() => writeRun(runId));

      const result = yield* assembleTrace(runId, session);

      // Only the creation row: a run that recorded nothing still exports.
      expect(unwrapOk(result).trace.events.map((event) => event.type)).toEqual([
        'run.start',
      ]);
    }),
  );
});
