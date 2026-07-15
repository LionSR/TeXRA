import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
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
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import {
  parseTraceData,
  TraceDataSchema,
} from '../../../packages/trace-viewer/src/traceDataSchema';
import type { Platform } from '@platform/platform';

const tempDirs: string[] = [];

async function buildStoragePlatform(): Promise<Platform> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-trace-viewer-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return createFakePlatform(
    { workspacePath: workspaceDir },
    {
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspaceDir),
      storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );
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
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
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

  it('ignores obsolete delegation depth in exported metadata', () => {
    const legacyTrace = {
      executionId: 'abcdef',
      streamId: 'stream-1',
      config: config(),
      meta: {
        timestamp: '2026-07-05T00:00:00.000Z',
        delegationDepth: 2,
      },
      entries: [],
      snapshot: { streamId: 'stream-1' },
      terminalStatus: null,
    };

    const parsed = TraceDataSchema.parse(legacyTrace);
    expect(parsed.meta).not.toHaveProperty('delegationDepth');
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
