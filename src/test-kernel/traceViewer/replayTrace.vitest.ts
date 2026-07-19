import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { Platform } from '@platform/platform';
import {
  appState,
  resetProgressState,
} from '@progressView/frontend/progressState';
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
import { setupPlatform } from '@test/support/setupPlatform';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import type { TraceDocument } from '@transcript';
import { assembleTrace, StreamLogStore } from '@transcript';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.
import { replayTrace } from '../../../packages/trace-viewer/src/replayTrace';

const tempDirs: string[] = [];

function buildStoragePlatform(): Promise<Platform> {
  return createTempDirPlatform('texra-replay-trace-', tempDirs);
}

setupPlatform(buildStoragePlatform);

beforeEach(() => {
  // replayTrace's slices write the shared progressState singletons directly;
  // reset them so each test starts from a clean slate.
  resetProgressState();
});

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
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
  it('replays workflow content without tool-use state', () => {
    const getState = () => appState.get();
    const trace = legacyTrace(undefined);

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed).toMatchObject({
      kind: AgentCategory.Workflow,
      files: {},
      missingOutputs: {},
      compileFailures: {},
    });
    expect(replayed).not.toHaveProperty('todos');
  });

  it('replays tool-use content without workflow output state', () => {
    const getState = () => appState.get();
    const workflow = legacyTrace(undefined);
    const trace: TraceDocument = {
      ...workflow,
      config: AgentConfigSchema.parse({
        agent: 'correct',
        model: 'gemini35f',
        agentCategory: AgentCategory.ToolUse,
      }),
      snapshot: StreamSnapshotSchema.parse({
        streamId: workflow.streamId,
        todos: [
          {
            content: 'Replay the plan',
            status: 'pending',
            activeForm: 'Replaying the plan',
          },
        ],
      }),
    };

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed).toMatchObject({
      kind: AgentCategory.ToolUse,
      todos: [{ content: 'Replay the plan' }],
      plan: null,
    });
    expect(replayed).not.toHaveProperty('files');
  });

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
    const store = await StreamLogStore.open();
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

    const getState = () => appState.get();
    replayTrace(result.trace);

    const replayed = getState().streamStates.get(result.trace.streamId);
    expect(replayed?.status).toBe('failed');
  });

  it('ignores nested group-end status when the root run stage never closed', () => {
    const getState = () => appState.get();
    const trace: TraceDocument = {
      ...legacyTrace(undefined),
      entries: [
        {
          seqNo: 1,
          id: 'root-run',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: LOG_LEVELS.INFO,
          timestamp: 100,
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'Run',
          data: { status: 'running' },
        },
        {
          seqNo: 2,
          id: 'inner-round',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: LOG_LEVELS.INFO,
          timestamp: 110,
          groupId: 'root-run',
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'Round',
          data: { status: 'running' },
        },
        {
          seqNo: 3,
          id: 'inner-round',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          level: LOG_LEVELS.INFO,
          timestamp: 120,
          groupId: 'root-run',
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'Round',
          data: { status: 'stopped', endTime: 120 },
        },
      ],
    };

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).toBe(STREAM_STATUS.READY);
  });

  it('ignores a cleanly-closed tool-use round when the root run stage never closed (issue #7267)', () => {
    // Tool-use rounds (ToolUseCycleNode) are opened without an ambient
    // parent stage — runFlowWithLifecycle never wraps flow execution in the
    // root "Run:" stage's `within(...)` — so a round's GROUP_END row carries
    // `groupId: undefined`, the same "no parent" shape as the root run
    // stage's own GROUP_END. Only `data.kind` (preserved through the
    // stage.end merge by TexraTranscriptRecorder) tells them apart.
    const getState = () => appState.get();
    const trace: TraceDocument = {
      ...legacyTrace(undefined),
      config: AgentConfigSchema.parse({
        agent: 'correct',
        model: 'gemini35f',
        agentCategory: AgentCategory.ToolUse,
      }),
      entries: [
        {
          seqNo: 1,
          id: 'root-run',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: LOG_LEVELS.INFO,
          timestamp: 100,
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'Run: correct',
          data: { status: 'running', kind: 'run' },
          // No matching GROUP_END: the root run stage never closed (crash
          // mid-run), so this entry stays a GROUP_START forever.
        },
        {
          seqNo: 2,
          id: 'r0',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          level: LOG_LEVELS.INFO,
          timestamp: 120,
          // No groupId — the bug: rounds have no ambient parent, so this is
          // indistinguishable from a root stage by groupId alone.
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'r0',
          data: { status: 'stopped', endTime: 120, kind: 'round' },
        },
      ],
    };

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).toBe(STREAM_STATUS.READY);
  });

  it('ignores a cleanly-closed tool-use round with no data.kind at all — archived before the stage.end kind fix (issue #7291)', () => {
    // Traces archived before TexraTranscriptRecorder started re-attaching
    // `kind` to `stage.end` (this same effort, #7267) have GROUP_END rows
    // with NO `data.kind` whatsoever: `store.update` replaces `data`
    // wholesale, so the round's `kind: 'round'` tag from stage.start never
    // made it onto its GROUP_END row. `data.kind` alone can't tell this
    // legacy round's end apart from the legacy root run's end (crash
    // mid-run) — the fallback must key on entry ordering instead (see
    // `findRootStageId`): the root run's stage entry is always the first
    // top-level ("no parent") stage entry in the trace, since the round
    // only starts after the root run stage has already opened. Labels are
    // deliberately non-canonical ("Legacy run" / "Round 0", not "Run: ...")
    // to prove the fallback doesn't key on label text either.
    const getState = () => appState.get();
    const trace: TraceDocument = {
      ...legacyTrace(undefined),
      config: AgentConfigSchema.parse({
        agent: 'correct',
        model: 'gemini35f',
        agentCategory: AgentCategory.ToolUse,
      }),
      entries: [
        {
          seqNo: 1,
          id: 'root-run',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: LOG_LEVELS.INFO,
          timestamp: 100,
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'Legacy run',
          // Legacy trace predates stage kinds entirely, so even the
          // GROUP_START row carries no `kind`.
          data: { status: 'running' },
          // No matching GROUP_END: the root run stage never closed (crash
          // mid-run), so this entry stays a GROUP_START forever.
        },
        {
          seqNo: 2,
          id: 'r0',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          level: LOG_LEVELS.INFO,
          timestamp: 120,
          // No groupId — rounds have no ambient parent, so this is
          // indistinguishable from a root stage by groupId alone.
          messageType: MESSAGE_TYPES.DEFAULT,
          text: 'Round 0',
          // No `kind` — the legacy shape this fix must handle: the round
          // closed cleanly before TexraTranscriptRecorder preserved `kind`
          // across the stage.end merge, so this row has only its entry
          // position (second top-level stage entry, opened after root) to
          // distinguish it from root.
          data: { status: 'stopped', endTime: 120 },
        },
      ],
    };

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).toBe(STREAM_STATUS.READY);
  });

  it('derives "failed" from snapshot.status "error" instead of defaulting to ready', () => {
    const getState = () => appState.get();
    const trace = legacyTrace('error');

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).not.toBe(STREAM_STATUS.READY);
    expect(replayed?.status).toBe('failed');
  });

  it('derives a non-ready status from snapshot.status "stopped" instead of defaulting to ready', () => {
    const getState = () => appState.get();
    const trace = legacyTrace('stopped');

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    // STOPPED folds into the canonical COMPLETED phase (the same collapse
    // `streamStatusToLifecycleStatus` performs everywhere else in the app) —
    // the point of this regression is that it must not silently become
    // READY, not that the literal legacy string survives.
    expect(replayed?.status).not.toBe(STREAM_STATUS.READY);
    expect(replayed?.status).toBe('completed');
  });

  it('still reports READY when neither terminalStatus nor snapshot.status is set', () => {
    const getState = () => appState.get();
    const trace = legacyTrace(undefined);

    replayTrace(trace);

    const replayed = getState().streamStates.get(trace.streamId);
    expect(replayed?.status).toBe(STREAM_STATUS.READY);
  });
});
