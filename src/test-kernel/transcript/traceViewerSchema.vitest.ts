import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  aggregateId,
  CLI_RUN_STATUS,
  emptyRunEndOutput,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
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
import {
  parseTraceData,
  TraceDataSchema,
} from '../../../packages/trace-viewer/src/traceDataSchema';

const tempDirs = useTempDirs();

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

/** A parseable trace payload; overrides shape each legacy/malformed case. */
function trace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: 'abcdef',
    config: config(),
    meta: {
      schemaVersion: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      identity: { kind: 'agent', agent: 'assistant' },
    },
    entries: [],
    snapshot: { runId: 'abcdef' },
    ...overrides,
  };
}

function expectTraceRejected(payload: unknown): void {
  expect(TraceDataSchema.safeParse(payload).success).toBe(false);
}

describe('trace-viewer TraceDataSchema', () => {
  setupPlatform(() => createTempDirPlatform('texra-trace-viewer-', tempDirs));

  it('accepts a real trace document produced by assembleTrace', async () => {
    const runId = 'abc12345' as RunId;
    const runConfigRecord = config({ agent: 'review', model: 'sonnet46T' });

    const session = createTestSession();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    await Effect.runPromise(
      getRunRecords(session, runId).writeRunRecord(runConfigRecord),
    );
    session.publish([
      {
        type: 'log',
        aggregateId: aggregateId('run', runId),
        message: 'hello',
        level: LOG_LEVELS.INFO,
        messageType: MESSAGE_TYPES.DEFAULT,
      },
      {
        type: 'run.end',
        aggregateId: aggregateId('run', runId),
        outcome: RUN_OUTCOME.COMPLETED,
        output: emptyRunEndOutput(AgentCategory.ToolUse),
      },
    ]);
    await session.settlePublications();
    const result = await Effect.runPromise(assembleTrace(runId, session));
    session.dispose();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const parsed = TraceDataSchema.safeParse(result.trace);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.runId).toBe(runId);
    expect(parsed.data.meta?.outcome).toBe('completed');
    expect(parsed.data.entries).toHaveLength(1);

    // parseTraceData must accept the same real document without throwing.
    expect(() => parseTraceData(result.trace)).not.toThrow();
  });

  it('applies source config defaults to legacy traces', () => {
    const legacyConfig: Partial<AgentConfig> = config();
    delete legacyConfig.agent;
    delete legacyConfig.model;
    delete legacyConfig.instruction;

    const parsed = TraceDataSchema.parse(trace({ config: legacyConfig }));

    expect(parsed.config).toMatchObject({
      agent: 'correct',
      model: DEFAULT_AGENT_MODEL,
      instruction: '',
    });
  });

  it('normalizes legacy run metadata', () => {
    const parsed = TraceDataSchema.parse(
      trace({
        meta: {
          timestamp: '2026-07-05T00:00:00.000Z',
          identity: { kind: 'agent', agent: 'assistant' },
          terminalStatus: CLI_RUN_STATUS.ERROR,
          delegationDepth: 2,
        },
      }),
    );
    // Legacy residue (`delegationDepth`, the retired `terminalStatus`) is
    // stripped at the parse boundary; `outcome` is the one terminal fact and
    // is never derived from residue here.
    expect(parsed.meta).not.toHaveProperty('delegationDepth');
    expect(parsed.meta).not.toHaveProperty('terminalStatus');
    expect(parsed.meta?.outcome).toBeUndefined();
  });

  it('throws a clear, identifying error via parseTraceData for a malformed trace', () => {
    const malformed = { totally: 'not a trace' };

    expect(() => parseTraceData(malformed)).toThrowError(
      /does not match the expected schema/,
    );
  });

  it('rejects a trace snapshot stamped with an incompatible schema version', () => {
    const incompatible = trace({
      snapshot: {
        schemaVersion: 999,
        runId: 'abcdef',
        outputFilesByRound: {},
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      },
    });

    expectTraceRejected(incompatible);
    expect(() => parseTraceData(incompatible)).toThrowError(
      /incompatible TeXRA version/,
    );
  });

  it('rejects a trace whose nested payload is malformed', () => {
    // The per-row recovery reader is gone: a row that fails the canonical
    // entry schema fails the whole parse instead of degrading to a generic row.
    expectTraceRejected(
      trace({
        entries: [
          {
            seqNo: 1,
            id: 'bad-group',
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            level: LOG_LEVELS.INFO,
            timestamp: 1,
            data: { status: 'future-status', kind: 'run', total: 3 },
          },
        ],
      }),
    );
  });
});
