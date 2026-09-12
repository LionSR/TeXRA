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
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
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
import { TraceDocumentSchema } from '@transcript/traceDocumentSchema';
import { parseTraceData } from '../../../packages/trace-viewer/src/traceDataSchema';

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

describe('trace-viewer TraceDocumentSchema', () => {
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

    const parsed = TraceDocumentSchema.safeParse(result.trace);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.runId).toBe(runId);
    expect(parsed.data.events[0]?.type).toBe('run.start');
    expect(parsed.data.events.some((event) => event.type === 'run.end')).toBe(
      true,
    );
    // An export has no producer, so no row names one.
    expect(parsed.data.events.every((event) => event.ownerId === null)).toBe(
      true,
    );

    // parseTraceData must accept the same real document without throwing.
    expect(() => parseTraceData(result.trace)).not.toThrow();
  });

  it('throws a clear, identifying error via parseTraceData for a malformed trace', () => {
    const malformed = { totally: 'not a trace' };

    expect(() => parseTraceData(malformed)).toThrowError(
      /does not match the expected schema/,
    );
  });
});
