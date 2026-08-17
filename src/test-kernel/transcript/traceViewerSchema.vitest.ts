import { afterEach, describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  EXECUTION_STATUS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  AgentCategory,
} from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { appendTranscriptEntry } from '@test/support/storeTestDrivers';
import { assembleTrace, StreamLogStore } from '@transcript';
import {
  parseTraceData,
  TraceDataSchema,
} from '../../../packages/trace-viewer/src/traceDataSchema';

const tempDirs: string[] = [];

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
    executionId: 'abcdef',
    streamId: 'stream-1',
    config: config(),
    meta: null,
    entries: [],
    snapshot: { streamId: 'stream-1' },
    terminalStatus: null,
    ...overrides,
  };
}

function expectTraceRejected(payload: unknown): void {
  expect(TraceDataSchema.safeParse(payload).success).toBe(false);
}

describe('trace-viewer TraceDataSchema', () => {
  setupPlatform(() => createTempDirPlatform('texra-trace-viewer-', tempDirs));

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('accepts a real trace document produced by assembleTrace', async () => {
    const executionId = 'abc12345' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });

    const streamId = getStreamTabId('review', { executionId });
    await getExecutionStore(executionId).writeRunRecord(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
      streamId,
    });
    const store = await StreamLogStore.open();
    appendTranscriptEntry(store, streamId, {
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'hello',
    });
    await store.flush();

    const result = await assembleTrace(executionId);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const parsed = TraceDataSchema.safeParse(result.trace);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.executionId).toBe(executionId);
    expect(parsed.data.streamId).toBe(streamId);
    expect(parsed.data.terminalStatus).toBe(EXECUTION_STATUS.COMPLETED);
    expect(parsed.data.entries).toHaveLength(1);

    // parseTraceData must accept the same real document without throwing.
    expect(() => parseTraceData(result.trace)).not.toThrow();
  });

  it('rejects a trace missing required top-level fields', () => {
    // config, meta, entries, snapshot, terminalStatus all missing.
    expectTraceRejected({ executionId: 'abcdef', streamId: 'stream-1' });
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

  it('normalizes legacy execution metadata', () => {
    const parsed = TraceDataSchema.parse(
      trace({
        meta: {
          timestamp: '2026-07-05T00:00:00.000Z',
          terminalStatus: EXECUTION_STATUS.ERROR,
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
        streamId: 'stream-1',
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

  it('rejects a trace whose entries are not an array of StreamLogEntry', () => {
    expectTraceRejected(trace({ entries: [{ notAStreamLogEntry: true }] }));
  });

  it('recovers malformed nested trace payloads without rejecting sibling entries', () => {
    const parsed = parseTraceData(
      trace({
        entries: [
          {
            seqNo: 1,
            id: 'bad-files',
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: LOG_LEVELS.INFO,
            timestamp: 1,
            messageType: MESSAGE_TYPES.FILE_LIST,
            data: [{ path: '/tmp/incomplete' }],
            text: 'Legacy files',
          },
          {
            seqNo: 2,
            id: 'legacy-group',
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            level: LOG_LEVELS.INFO,
            timestamp: 2,
            data: { status: 'future-status', kind: 'run', total: 3 },
          },
        ],
      }),
    );

    expect(parsed.entries[0]).toMatchObject({
      id: 'bad-files',
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'Legacy files',
    });
    expect(parsed.entries[1]).toMatchObject({
      id: 'legacy-group',
      data: { kind: 'run', total: 3 },
    });
    expect(parsed.entries[1]?.data).toHaveProperty('status', undefined);
  });

  it('rejects a null/undefined/primitive trace payload', () => {
    expectTraceRejected(null);
    expectTraceRejected(undefined);
    expectTraceRejected('trace');
  });

  it('parses a legacy trace carrying the retired child-activity keys', () => {
    // Pre-#9145 exports recorded `activeSubagents`/`activeProcesses` plus the
    // two finished-child counters; #9139 additionally retired the whole
    // process roster (`processes`). Neither schema on this path is strict, so
    // those keys are stripped rather than rejected — and no data is lost,
    // because they were always written at their prefault values.
    const parsed = parseTraceData(
      trace({
        snapshot: {
          streamId: 'stream-1',
          activeSubagents: [],
          activeProcesses: [],
          processes: [],
          finishedSubagentCount: 3,
          finishedProcessCount: 2,
        },
      }),
    );
    expect(parsed.snapshot.subagents).toEqual([]);
    expect(parsed.snapshot).not.toHaveProperty('processes');
    expect(parsed.snapshot).not.toHaveProperty('finishedSubagentCount');
    expect(parsed.snapshot).not.toHaveProperty('activeSubagents');
  });
});
