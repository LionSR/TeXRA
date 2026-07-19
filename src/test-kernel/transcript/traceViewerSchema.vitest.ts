import { afterEach, describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { assembleTrace, StreamLogStore } from '@transcript';
import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  EXECUTION_STATUS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
} from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import {
  parseTraceData,
  TraceDataSchema,
} from '../../../packages/trace-viewer/src/traceDataSchema';
import type { Platform } from '@platform/platform';

const tempDirs: string[] = [];

function buildStoragePlatform(): Promise<Platform> {
  return createTempDirPlatform('texra-trace-viewer-', tempDirs);
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    inputFiles: [],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    editedFile: null,
    agent: 'orchestrator',
    model: 'deepseekT',
    instruction: 'Solve the problem.',
    agentCategory: AgentCategory.ToolUse,
    editedFiles: [],
    toolConfig: DEFAULT_TOOL_CONFIG,
    memories: [],
    workingDirectory: '/workspace',
    cliOutputFile: null,
    cliMultiAgentPresetId: null,
    ...overrides,
  };
}

describe('trace-viewer TraceDataSchema', () => {
  setupPlatform(buildStoragePlatform);

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('accepts a real trace document produced by assembleTrace', async () => {
    const executionId = 'abc12345' as ExecutionId;
    const executionConfig = config({ agent: 'review', model: 'sonnet46T' });

    await getExecutionStore(executionId).writeConfig(executionConfig);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-05T00:00:00.000Z',
      outcome: 'completed',
    });

    const streamId = getStreamTabId('review', 'sonnet46T', { executionId });
    const store = await StreamLogStore.open();
    store.append(streamId, {
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
    const malformed = {
      executionId: 'abcdef',
      streamId: 'stream-1',
      // config, meta, entries, snapshot, terminalStatus all missing.
    };

    const result = TraceDataSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it('applies source config defaults to legacy traces', () => {
    const legacyConfig: Partial<AgentConfig> = config();
    delete legacyConfig.agent;
    delete legacyConfig.model;
    delete legacyConfig.instruction;

    const parsed = TraceDataSchema.parse({
      executionId: 'abcdef',
      streamId: 'stream-1',
      config: legacyConfig,
      meta: null,
      entries: [],
      snapshot: { streamId: 'stream-1' },
      terminalStatus: null,
    });

    expect(parsed.config.agent).toBe('correct');
    expect(parsed.config.model).toBe(DEFAULT_AGENT_MODEL);
    expect(parsed.config.instruction).toBe('');
  });

  it('normalizes legacy execution metadata', () => {
    const legacyTrace = {
      executionId: 'abcdef',
      streamId: 'stream-1',
      config: config(),
      meta: {
        timestamp: '2026-07-05T00:00:00.000Z',
        terminalStatus: EXECUTION_STATUS.ERROR,
        delegationDepth: 2,
      },
      entries: [],
      snapshot: { streamId: 'stream-1' },
      terminalStatus: null,
    };

    const parsed = TraceDataSchema.parse(legacyTrace);
    expect(parsed.meta).not.toHaveProperty('delegationDepth');
    expect(parsed.meta?.outcome).toBe('failed');
  });

  it('throws a clear, identifying error via parseTraceData for a malformed trace', () => {
    const malformed = { totally: 'not a trace' };

    expect(() => parseTraceData(malformed)).toThrowError(
      /does not match the expected schema/,
    );
  });

  it('rejects a trace snapshot stamped with an incompatible schema version', () => {
    const incompatible = {
      executionId: 'abcdef',
      streamId: 'stream-1',
      config: config(),
      meta: null,
      entries: [],
      snapshot: {
        schemaVersion: 999,
        streamId: 'stream-1',
        outputFilesByRound: {},
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      },
      terminalStatus: null,
    };

    const result = TraceDataSchema.safeParse(incompatible);
    expect(result.success).toBe(false);
    expect(() => parseTraceData(incompatible)).toThrowError(
      /incompatible TeXRA version/,
    );
  });

  it('rejects a trace whose entries are not an array of StreamLogEntry', () => {
    const malformed = {
      executionId: 'abcdef',
      streamId: 'stream-1',
      config: config(),
      meta: null,
      entries: [{ notAStreamLogEntry: true }],
      snapshot: { streamId: 'stream-1' },
      terminalStatus: null,
    };

    const result = TraceDataSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it('rejects a null/undefined/primitive trace payload', () => {
    expect(TraceDataSchema.safeParse(null).success).toBe(false);
    expect(TraceDataSchema.safeParse(undefined).success).toBe(false);
    expect(TraceDataSchema.safeParse('trace').success).toBe(false);
  });
});
