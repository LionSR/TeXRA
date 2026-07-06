import { create } from 'mutative';
import { describe, expect, it } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { MessageHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import {
  AgentCategory,
  STREAM_STATUS,
  StreamSnapshotSchema,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.
import { replayTrace } from '../../../packages/trace-viewer/src/replayTrace';
import type { TraceDocument } from '@transcript';

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
