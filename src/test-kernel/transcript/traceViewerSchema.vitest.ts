import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  aggregateId,
  emptyRunEndOutput,
  emptyUsageStats,
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

/** A parseable trace payload; overrides shape each malformed case. */
function trace(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: 'abcdef',
    config: config(),
    meta: {
      identity: { kind: 'agent', agent: 'assistant' },
      launchedAt: Date.UTC(2026, 0, 1),
      description: null,
      outcome: null,
      conversationProgress: { toolCallCount: 0 },
      usage: emptyUsageStats(),
      todos: [],
      plan: null,
      outputs: {},
      missingOutputs: {},
      compileFailures: {},
    },
    entries: [],
    steps: [],
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
    expect(parsed.data.meta.outcome).toBe('completed');
    expect(parsed.data.entries).toHaveLength(1);

    // parseTraceData must accept the same real document without throwing.
    expect(() => parseTraceData(result.trace)).not.toThrow();
  });

  it('applies source config defaults to a partial run record', () => {
    const partialConfig: Partial<AgentConfig> = config();
    delete partialConfig.agent;
    delete partialConfig.model;
    delete partialConfig.instruction;

    const parsed = TraceDataSchema.parse(trace({ config: partialConfig }));

    expect(parsed.config).toMatchObject({
      agent: 'correct',
      model: DEFAULT_AGENT_MODEL,
      instruction: '',
    });
  });

  it('throws a clear, identifying error via parseTraceData for a malformed trace', () => {
    const malformed = { totally: 'not a trace' };

    expect(() => parseTraceData(malformed)).toThrowError(
      /does not match the expected schema/,
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
