import { describe, expect, it } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_STATUS,
  STREAM_LOG_ENTRY_TYPES,
  StreamSnapshotSchema,
  StreamLogEntrySchema,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import { emptySessionView } from '@shared/session/sessionView';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  appendTranscriptEntry,
  updateTranscriptEntry,
} from '@test/support/storeTestDrivers';
import type { TraceDocument } from '@transcript';
import { assembleTrace, StreamLogStore } from '@transcript';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.
import { traceFrames } from '../../../packages/trace-viewer/src/traceFrames';

const tempDirs = useTempDirs();

setupPlatform(() => createTempDirPlatform('texra-replay-trace-', tempDirs));

/** The view the fold reaches over the trace's listing and transcript rows,
 *  with the transcript tier subscribed for the run's stream. */
function foldTrace(trace: TraceDocument) {
  const frames = [
    ...traceFrames(trace, 'trace', {
      kind: 'subscribe',
      session: 'trace',
      generation: 1,
      cursor: 0,
      aggregates: [
        { id: qualifyAggregateId('stream', trace.streamId), fromSeq: 0 },
      ],
    }),
  ];
  const view = fold(emptySessionView('trace', 0), [
    {
      _tag: 'subscriptions',
      set: [{ id: qualifyAggregateId('stream', trace.streamId), fromSeq: 0 }],
    },
    ...frames.flatMap((frame) => frame.events),
    { _tag: 'local', local: { self: [], heldBy: [], unreadable: [] } },
  ]);
  return view.streams.get(trace.streamId);
}

type TraceEntry = TraceDocument['entries'][number];

function parseConfig(category: AgentCategory): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini35f',
    agentCategory: category,
  });
}

// Fills in the level/messageType boilerplate every stage row shares; groupId
// is omitted entirely (not set to undefined) when absent, matching real
// archived traces.
function stageEntry(
  entry: Pick<
    TraceEntry,
    'seqNo' | 'id' | 'type' | 'timestamp' | 'text' | 'data'
  > &
    Partial<Pick<TraceEntry, 'groupId'>>,
): TraceEntry {
  const { groupId, ...rest } = entry;
  return StreamLogEntrySchema.parse({
    ...rest,
    level: LOG_LEVELS.INFO,
    messageType: MESSAGE_TYPES.DEFAULT,
    ...(groupId === undefined ? {} : { groupId }),
  });
}

function legacyTrace(
  snapshotStatus: 'error' | 'stopped' | undefined,
  category: AgentCategory = AgentCategory.Workflow,
): TraceDocument {
  const streamId = 'stream:legacy-trace' as StreamTabId;
  return {
    executionId: 'abc123' as ExecutionId,
    streamId,
    config: parseConfig(category),
    // Legacy meta: no description, nothing replayTrace needs beyond the
    // optional `description` read.
    meta: null,
    entries: [],
    snapshot: StreamSnapshotSchema.parse({
      streamId,
      status: snapshotStatus,
    }),
  };
}

describe('traceEvents legacy-status fallback (issue #7188)', () => {
  it('delivers an oversized first row intact without an empty intermediate frame', () => {
    const name = 'a'.repeat(300 * 1024);
    const trace = legacyTrace(undefined);
    trace.config = AgentConfigSchema.parse({ ...trace.config, agent: name });
    const frames = [
      ...traceFrames(trace, 'trace', {
        kind: 'subscribe',
        session: 'trace',
        generation: 1,
        cursor: 0,
        aggregates: [
          { id: qualifyAggregateId('stream', trace.streamId), fromSeq: 0 },
        ],
      }),
    ];
    expect(frames.every((frame) => frame.events.length > 0)).toBe(true);
    expect(frames[0]?.events[0]).toMatchObject({
      _tag: 'event',
      event: { type: 'run.start', identity: { agent: name } },
    });
    expect(frames.at(-1)?.replayComplete).toBe(true);
  });

  it('replays workflow content without tool-use state', () => {
    const trace = legacyTrace(undefined);
    trace.entries.push(
      StreamLogEntrySchema.parse({
        id: 'archived-log',
        seqNo: 1,
        timestamp: 1,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        text: 'Archived derivation',
      }),
    );

    const replayed = foldTrace(trace);
    expect(replayed).toMatchObject({
      category: AgentCategory.Workflow,
      files: {},
      missingOutputs: {},
      compileFailures: {},
    });
    expect(replayed).not.toHaveProperty('todos');
    expect(replayed?.transcript.rows).toContainEqual(
      expect.objectContaining({
        id: 'archived-log',
        kind: 'log',
        text: expect.objectContaining({ full: 'Archived derivation' }),
      }),
    );
  });

  it('replays tool-use content without workflow output state', () => {
    const workflow = legacyTrace(undefined);
    const trace: TraceDocument = {
      ...workflow,
      config: parseConfig(AgentCategory.ToolUse),
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

    const replayed = foldTrace(trace);
    expect(replayed).toMatchObject({
      category: AgentCategory.ToolUse,
      todos: [{ content: 'Replay the plan' }],
      plan: null,
    });
    expect(replayed).not.toHaveProperty('files');
  });

  it('derives failed status from a real exported legacy trace without snapshot.status', async () => {
    const executionId = 'abc124' as ExecutionId;
    const config = parseConfig(AgentCategory.Workflow);
    const streamId = getStreamTabId(config.agent, { executionId });
    const executionStore = getExecutionStore(executionId);
    await executionStore.writeRunRecord(config);
    await executionStore.writeMeta({
      timestamp: '2026-07-06T00:00:00.000Z',
      streamId,
    });
    const store = await StreamLogStore.open();
    appendTranscriptEntry(store, streamId, {
      id: 'terminal-stage',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'Legacy run',
      data: { status: 'running' },
    });
    updateTranscriptEntry(store, streamId, 'terminal-stage', {
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: 'error', endTime: 200 },
    });
    await store.flush();

    const result = await assembleTrace(executionId);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.trace.meta?.outcome).toBeUndefined();
    expect(result.trace.snapshot.status).toBeUndefined();

    expect(foldTrace(result.trace)?.status).toBe('failed');
  });

  it('ignores nested group-end status when the root run stage never closed', () => {
    const trace: TraceDocument = {
      ...legacyTrace(undefined),
      entries: [
        stageEntry({
          seqNo: 1,
          id: 'root-run',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          timestamp: 100,
          text: 'Run',
          data: { status: 'running' },
        }),
        stageEntry({
          seqNo: 2,
          id: 'inner-round',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          timestamp: 110,
          groupId: 'root-run',
          text: 'Round',
          data: { status: 'running' },
        }),
        stageEntry({
          seqNo: 3,
          id: 'inner-round',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          timestamp: 120,
          groupId: 'root-run',
          text: 'Round',
          data: { status: 'stopped', endTime: 120 },
        }),
      ],
    };

    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(foldTrace(trace)?.durableOutcome).toBeNull();
  });

  it('ignores a cleanly-closed tool-use round when the root run stage never closed (issue #7267)', () => {
    // Tool-use rounds (ToolUseCycleNode) are opened without an ambient
    // parent stage — runFlowWithLifecycle never wraps flow execution in the
    // root "Run:" stage's `within(...)` — so a round's GROUP_END row carries
    // `groupId: undefined`, the same "no parent" shape as the root run
    // stage's own GROUP_END. Only `data.kind` (preserved through the
    // stage.end merge by TexraTranscriptRecorder) tells them apart.
    const trace: TraceDocument = {
      ...legacyTrace(undefined, AgentCategory.ToolUse),
      entries: [
        stageEntry({
          seqNo: 1,
          id: 'root-run',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          timestamp: 100,
          text: 'Run: correct',
          data: { status: 'running', kind: 'run' },
          // No matching GROUP_END: the root run stage never closed (crash
          // mid-run), so this entry stays a GROUP_START forever.
        }),
        stageEntry({
          seqNo: 2,
          id: 'r0',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          timestamp: 120,
          // No groupId — the bug: rounds have no ambient parent, so this is
          // indistinguishable from a root stage by groupId alone.
          text: 'r0',
          data: { status: 'stopped', endTime: 120, kind: 'round' },
        }),
      ],
    };

    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(foldTrace(trace)?.durableOutcome).toBeNull();
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
    const trace: TraceDocument = {
      ...legacyTrace(undefined, AgentCategory.ToolUse),
      entries: [
        stageEntry({
          seqNo: 1,
          id: 'root-run',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          timestamp: 100,
          text: 'Legacy run',
          // Legacy trace predates stage kinds entirely, so even the
          // GROUP_START row carries no `kind`.
          data: { status: 'running' },
          // No matching GROUP_END: the root run stage never closed (crash
          // mid-run), so this entry stays a GROUP_START forever.
        }),
        stageEntry({
          seqNo: 2,
          id: 'r0',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          timestamp: 120,
          // No groupId — rounds have no ambient parent, so this is
          // indistinguishable from a root stage by groupId alone.
          text: 'Round 0',
          // No `kind` — the legacy shape this fix must handle: the round
          // closed cleanly before TexraTranscriptRecorder preserved `kind`
          // across the stage.end merge, so this row has only its entry
          // position (second top-level stage entry, opened after root) to
          // distinguish it from root.
          data: { status: 'stopped', endTime: 120 },
        }),
      ],
    };

    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(foldTrace(trace)?.durableOutcome).toBeNull();
  });

  // STOPPED folds into the canonical COMPLETED phase (the same collapse
  // `streamStatusToLifecycleStatus` performs everywhere else in the app) — the
  // point of these regressions is that a terminal snapshot status must not
  // silently become READY, not that the literal legacy string survives.
  it.each([
    { snapshotStatus: 'error', expected: 'failed' },
    { snapshotStatus: 'stopped', expected: 'completed' },
  ] as const)(
    'derives "$expected" from snapshot.status "$snapshotStatus" instead of defaulting to ready',
    ({ snapshotStatus, expected }) => {
      const trace = legacyTrace(snapshotStatus);

      const replayed = foldTrace(trace);
      expect(replayed?.status).toBe(expected);
      expect(replayed?.durableOutcome).toBe(expected);
    },
  );

  it('reports no durable outcome when neither meta.outcome nor snapshot.status is set', () => {
    const trace = legacyTrace(undefined);

    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(foldTrace(trace)?.durableOutcome).toBeNull();
  });
});
