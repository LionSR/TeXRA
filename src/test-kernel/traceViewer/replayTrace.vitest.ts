import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { create } from 'mutative';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { assembleTrace, StreamLogStore } from '@transcript';
import { getExecutionStore } from '@agent/storage';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import type { MessageHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_STATUS,
  STREAM_LOG_ENTRY_TYPES,
  StreamSnapshotSchema,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.
import { replayTrace } from '../../../packages/trace-viewer/src/replayTrace';
import type { Platform } from '@platform/platform';
import type { TraceDocument } from '@transcript';

const tempDirs: string[] = [];

async function buildStoragePlatform(): Promise<Platform> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-replay-trace-'));
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

function createContext(initialState: ProgressState): {
  ctx: MessageHandlerContext;
  getState: () => ProgressState;
} {
  let state = initialState;
  const ctx: MessageHandlerContext = {
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    setStreamState: (streamId, updater) => {
      const current = state.streamStates.get(streamId);
      if (!current) return;
      const updated = updater(current);
      if (updated === current) return;
      state = create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      });
    },
    setStreamLogs: () => {},
    savePrefs: () => {},
    getPermissions: () => [],
    setPermissions: () => {},
    setPlacement: () => {},
  };
  return { ctx, getState: () => state };
}

setupPlatform(buildStoragePlatform);

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function legacyTrace(
  snapshotStatus: 'error' | 'stopped' | undefined,
): TraceDocument {
  const streamId = 'stream:legacy-trace' as StreamTabId;
  return {
    executionId: 'abc123' as ExecutionId,
    streamId,
    config: AgentConfigSchema.parse({
      agent: 'correct',
      model: 'gemini35f',
      agentCategory: AgentCategory.Workflow,
    }),
    // Legacy meta: no description, nothing replayTrace needs beyond the
    // optional `description` read.
    meta: null,
    entries: [],
    snapshot: StreamSnapshotSchema.parse({
      streamId,
      status: snapshotStatus,
    }),
    // The bug under test: `null` is what real traces recorded before outcome
    // tracking (or that never reached a terminal state) persist here.
    terminalStatus: null,
  };
}

describe('replayTrace legacy-status fallback (issue #7188)', () => {
  it('derives failed status from a real exported legacy trace without snapshot.status', async () => {
    const executionId = 'abc124' as ExecutionId;
    const config = AgentConfigSchema.parse({
      agent: 'correct',
      model: 'gemini35f',
      agentCategory: AgentCategory.Workflow,
    });
    await getExecutionStore(executionId).writeConfig(config);
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-06T00:00:00.000Z',
    });

    const streamId = getStreamTabId(config.agent, config.model, {
      executionId,
    });
    const store = new StreamLogStore();
    await store.load();
    store.append(streamId, {
      id: 'terminal-stage',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'Legacy run',
      data: { status: 'running' },
    });
    store.update(streamId, 'terminal-stage', {
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: 'error', endTime: 200 },
    });
    await store.flush();

    const result = await assembleTrace(executionId);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.terminalStatus).toBeNull();
    expect(result.trace.snapshot.status).toBeUndefined();

    const { ctx, getState } = createContext(createInitialState());
    replayTrace(result.trace, ctx);

    const replayed = getState().streamStates.get(result.trace.streamId);
    expect(replayed?.status).toBe('failed');
  });

  it('derives "failed" from snapshot.status "error" instead of defaulting to ready', () => {
    const { ctx, getState } = createContext(createInitialState());
    const trace = legacyTrace('error');

    replayTrace(trace, ctx);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).not.toBe(STREAM_STATUS.READY);
    expect(replayed?.status).toBe('failed');
  });

  it('derives a non-ready status from snapshot.status "stopped" instead of defaulting to ready', () => {
    const { ctx, getState } = createContext(createInitialState());
    const trace = legacyTrace('stopped');

    replayTrace(trace, ctx);

    const replayed = getState().streamStates.get(trace.streamId);
    // STOPPED folds into the canonical COMPLETED phase (the same collapse
    // `streamStatusToLifecycleStatus` performs everywhere else in the app) —
    // the point of this regression is that it must not silently become
    // READY, not that the literal legacy string survives.
    expect(replayed?.status).not.toBe(STREAM_STATUS.READY);
    expect(replayed?.status).toBe('completed');
  });

  it('still reports READY when neither terminalStatus nor snapshot.status is set', () => {
    const { ctx, getState } = createContext(createInitialState());
    const trace = legacyTrace(undefined);

    replayTrace(trace, ctx);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).toBe(STREAM_STATUS.READY);
  });
});
