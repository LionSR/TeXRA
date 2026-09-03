// The pure fold over a recorded fan-out session: a workflow-script root, one
// child agent run, a background process stream. The scenario is the seq
// numbered event log a publisher would replay; every assertion compares the
// fold's output to the existing shared folds it must reproduce, so the two
// can never drift.

import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  runIdentityDisplayName,
  type FoldInput,
  type RunIdentity,
  type SessionEvent,
  type SessionEventBody,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { projectTranscriptRow, type TranscriptRow } from '@shared/transcript';
import { fold } from '@shared/session/sessionFold';
import {
  createSessionView,
  type SessionView,
  type StreamView,
} from '@shared/session/sessionView';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import {
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/streams/workflowRunModel';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ROOT = 'review#aaaaaaaaaaaa' as StreamTabId;
const CHILD = 'search#bbbbbbbbbbbb' as StreamTabId;
const PROCESS = 'bash@tool#cccccccccccc' as StreamTabId;

const ROOT_IDENTITY: RunIdentity = {
  kind: 'multiAgentWorkflow',
  workflowName: 'review',
};
const CHILD_IDENTITY: RunIdentity = { kind: 'agent', agent: 'custom:search' };

/** Seq numbered per stream, the way the event table keys them. */
class Log {
  readonly events: SessionEvent[] = [];
  private readonly seq = new Map<StreamTabId, number>();
  private readonly entrySeq = new Map<StreamTabId, number>();

  emit(streamId: StreamTabId, timestamp: number, body: SessionEventBody): void {
    const seq = (this.seq.get(streamId) ?? 0) + 1;
    this.seq.set(streamId, seq);
    this.events.push({
      ...body,
      streamId,
      seq,
      ownerId: OWNER,
      timestamp,
    } as SessionEvent);
  }

  entry(
    streamId: StreamTabId,
    timestamp: number,
    entry: Omit<StreamLogEntry, 'seqNo' | 'timestamp' | 'level'>,
  ): StreamLogEntry {
    const seqNo = (this.entrySeq.get(streamId) ?? 0) + 1;
    this.entrySeq.set(streamId, seqNo);
    const full = {
      ...entry,
      seqNo,
      timestamp,
      level: 'info',
    } as StreamLogEntry;
    this.emit(streamId, timestamp, { type: 'legacy.entry', entry: full });
    return full;
  }
}

function call(
  status: WorkflowCallProgress['status'],
  childStreamId?: StreamTabId,
): WorkflowCallProgress {
  return {
    id: 'inspect',
    label: 'inspect',
    phase: 'Map',
    attemptId: 'attempt-1',
    ...(childStreamId ? { childStreamId } : {}),
    status,
  } as WorkflowCallProgress;
}

function foldAll(inputs: readonly FoldInput[], from = createSessionView()) {
  return inputs.reduce(fold, from);
}

function stream(view: SessionView, id: StreamTabId): StreamView {
  const found = view.streams.get(id);
  if (!found) throw new Error(`stream ${id} missing from the view`);
  return found;
}

/** Full replay through the production reducer (the resync path). */
function taskGroupsOf(entries: readonly StreamLogEntry[]): TaskGroup[] {
  const taskGroups: TaskGroup[] = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    upsertTaskGroupFromStreamLog(taskGroups, index, entry);
  }
  return taskGroups;
}

/** Sequential projection keyed by id, the way a host upserts rows. */
function rowsOf(entries: readonly StreamLogEntry[]): TranscriptRow[] {
  const byId = new Map<string, TranscriptRow>();
  for (const entry of entries) {
    const row = projectTranscriptRow(entry, {
      previousRow: byId.get(entry.id),
      projectLifecycleToTaskGroups: true,
    });
    if (row) byId.set(entry.id, row);
  }
  return [...byId.values()];
}

function buildScenario() {
  const log = new Log();
  const rootEntries: StreamLogEntry[] = [];

  log.emit(ROOT, 1000, {
    type: 'run.start',
    executionId: 'aaaaaaaaaaaa',
    identity: ROOT_IDENTITY,
    agentCategory: AgentCategory.Workflow,
    isRemote: false,
    worktree: { workingDirectory: '/paper', branch: 'main' },
    userFollowUpSupport: 'unsupported',
  });
  log.emit(ROOT, 1000, {
    type: 'run.config',
    executionId: 'aaaaaaaaaaaa',
    config: { model: 'claude-sonnet-4-5', instruction: 'review the draft' },
  });
  log.emit(ROOT, 1000, {
    type: 'status',
    phase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
    runStartedAt: 1000,
  });
  rootEntries.push(
    log.entry(ROOT, 1001, {
      id: 'phase-Map',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      text: 'Map',
      data: { kind: 'phase', index: 0, total: 1, attemptId: 'attempt-1' },
    }),
  );
  log.emit(ROOT, 1001, {
    type: 'stage.start',
    id: 'phase-Map',
    label: 'Map',
    kind: 'phase',
    index: 0,
    total: 1,
  });
  log.emit(ROOT, 1002, {
    type: 'workflow.call',
    logId: 'call-1',
    call: call('planned'),
  });
  rootEntries.push(
    log.entry(ROOT, 1002, {
      id: 'call-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      groupId: 'phase-Map',
      data: call('planned'),
    }),
  );

  // The child agent run: its run.start carries the parent, and the registry
  // confirms the edge as a session fact.
  log.emit(CHILD, 1500, {
    type: 'run.start',
    executionId: 'bbbbbbbbbbbb',
    identity: CHILD_IDENTITY,
    agentCategory: AgentCategory.ToolUse,
    isRemote: false,
    parentStreamId: ROOT,
    userFollowUpSupport: 'nativeInteractive',
  });
  log.emit(CHILD, 1500, { type: 'setParentStream', parentStreamId: ROOT });
  log.emit(CHILD, 1500, {
    type: 'run.config',
    executionId: 'bbbbbbbbbbbb',
    config: { model: 'claude-sonnet-4-5', instruction: 'search' },
  });
  log.emit(CHILD, 1500, {
    type: 'status',
    phase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
    runStartedAt: 1500,
  });
  log.emit(ROOT, 1501, {
    type: 'workflow.call',
    logId: 'call-1',
    call: call('running', CHILD),
  });
  rootEntries.push(
    log.entry(ROOT, 1501, {
      id: 'call-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      groupId: 'phase-Map',
      data: call('running', CHILD),
    }),
  );
  log.emit(CHILD, 1600, {
    type: 'conversation.progress',
    progress: { toolCallCount: 3 },
  });
  log.emit(CHILD, 1700, {
    type: 'approval.requested',
    requestId: 'req-1',
    payload: {
      kind: 'bash',
      data: {
        requestId: 'req-1',
        allowBypass: true,
        streamId: CHILD,
        command: 'ls',
      },
    },
  });

  // A background process stream, newer than the root: leads the order.
  log.emit(PROCESS, 2000, {
    type: 'run.start',
    executionId: 'cccccccccccc',
    identity: { kind: 'process', tool: 'bash' },
    isRemote: false,
  });
  log.emit(PROCESS, 2000, {
    type: 'run.config',
    executionId: 'cccccccccccc',
    config: { model: 'unused', instruction: 'npm test' },
  });

  const pending = log.events.length;

  log.emit(CHILD, 1800, { type: 'approval.resolved', requestId: 'req-1' });
  log.emit(CHILD, 1900, {
    type: 'result',
    outcome: 'completed',
    executionId: 'bbbbbbbbbbbb',
    category: AgentCategory.ToolUse,
    isSubagent: true,
  });
  log.emit(ROOT, 1901, {
    type: 'workflow.call',
    logId: 'call-1',
    call: call('completed', CHILD),
  });
  rootEntries.push(
    log.entry(ROOT, 1901, {
      id: 'call-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      groupId: 'phase-Map',
      data: call('completed', CHILD),
    }),
  );
  rootEntries.push(
    log.entry(ROOT, 1902, {
      id: 'phase-Map',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      text: 'Map',
      data: { kind: 'phase', status: 'completed', endTime: 1902 },
    }),
  );
  log.emit(ROOT, 1903, {
    type: 'result',
    outcome: 'completed',
    executionId: 'aaaaaaaaaaaa',
    category: AgentCategory.Workflow,
    isSubagent: false,
  });

  return {
    events: log.events,
    rootEntries,
    /** The prefix that ends with the child's approval still pending. */
    pending: log.events.slice(0, pending),
  };
}

const alive: FoldInput = { type: 'owner.liveness', owners: [OWNER] };
const nobody: FoldInput = { type: 'owner.liveness', owners: [] };

describe('sessionFold', () => {
  const scenario = buildScenario();

  it('reproduces topology, order, labels, and launch facts from run.start', () => {
    const view = foldAll(scenario.events);
    const root = stream(view, ROOT);
    const child = stream(view, CHILD);

    const expectedOrder = [...view.streams.values()]
      .filter((s) => s.parentId === null)
      .map((s) => ({ name: s.id, creationTimestamp: s.creationTimestamp }))
      .sort(compareByNewestCreationTime)
      .map((s) => s.name);
    expect(view.order).toStrictEqual(expectedOrder);
    expect(view.order).toStrictEqual([PROCESS, ROOT]);

    expect(root.label).toBe(runIdentityDisplayName(ROOT_IDENTITY));
    expect(root.category).toBe(AgentCategory.Workflow);
    expect(root.worktree).toStrictEqual({
      workingDirectory: '/paper',
      branch: 'main',
    });
    expect(root.childIds).toStrictEqual([CHILD]);
    expect(root.creationTimestamp).toBe(1000);
    expect(child.parentId).toBe(ROOT);
    expect(child.ancestors).toStrictEqual([{ id: ROOT, label: 'review' }]);
    expect(child.label).toBe(runIdentityDisplayName(CHILD_IDENTITY));
    expect(child.model).toBe('claude-sonnet-4-5');
    expect(child.followUpSupport).toBe('nativeInteractive');
    expect(child.ownerId).toBe(OWNER);
    // Process streams carry the command, never a model.
    expect(stream(view, PROCESS).command).toBe('npm test');
    expect(stream(view, PROCESS).model).toBeNull();
    expect(stream(view, PROCESS).category).toBe(AgentCategory.ToolUse);
  });

  it('folds the transcript through the shared row, group, and run reducers', () => {
    const view = foldAll(scenario.events);
    const root = stream(view, ROOT);
    const child = stream(view, CHILD);

    expect(root.transcript.taskGroups).toStrictEqual(
      taskGroupsOf(scenario.rootEntries),
    );
    expect(root.transcript.rows).toStrictEqual(rowsOf(scenario.rootEntries));
    expect(root.transcript.settledSeq).toBe(
      scenario.events.filter((e) => e.streamId === ROOT).length,
    );

    const childProgress = new Map<StreamTabId, ChildRunProgress>([
      [
        CHILD,
        {
          toolCallCount: 3,
          outputTokens: 0,
          costUsd: 0,
        },
      ],
    ]);
    expect(root.transcript.run).toStrictEqual(
      workflowRunModel({
        taskGroups: root.transcript.taskGroups,
        rows: root.transcript.rows,
        workflowAttemptId: undefined,
        plan: undefined,
        runSettled: true,
        childProgress,
      }),
    );
    expect(root.transcript.run?.childStreamOf.get('call-1')).toBe(CHILD);
    expect(child.transcript.run).toBeNull();
  });

  it('settles status copy, rollups, and groups from status and result', () => {
    const pending = foldAll(scenario.pending);
    const rootPending = stream(pending, ROOT);
    expect(rootPending.status).toBe(STREAM_PHASE.RUNNING);
    expect(rootPending.statusLabel).toBe('Running');
    expect(rootPending.tone).toBe('running');
    expect(rootPending.stage).toStrictEqual({
      kind: 'phase',
      label: 'Map',
      index: 0,
      total: 1,
    });
    expect(rootPending.rollup).toStrictEqual({
      total: 1,
      running: 1,
      finished: 0,
    });

    const settled = foldAll(scenario.events);
    const root = stream(settled, ROOT);
    expect(root.status).toBe(STREAM_PHASE.COMPLETED);
    expect(root.statusLabel).toBe('Completed');
    expect(root.tone).toBe('success');
    expect(root.group).toBe('recent');
    expect(root.rollup).toStrictEqual({ total: 1, running: 0, finished: 1 });
    expect(stream(settled, CHILD).runStartedAt).toBeNull();
    expect(settled.approvals).toStrictEqual([]);
  });

  it('folds a pending approval to waiting only with a live owner', () => {
    const withOwner = foldAll([...scenario.pending, alive]);
    expect(withOwner.liveOwners).toStrictEqual([OWNER]);
    expect(stream(withOwner, CHILD).group).toBe('waiting');
    expect(stream(withOwner, CHILD).approval).toBe('own');
    expect(stream(withOwner, ROOT).approval).toBe('descendant');
    expect(stream(withOwner, ROOT).group).toBe('running');
    expect(withOwner.approvals.map((a) => a.requestId)).toStrictEqual([
      'req-1',
    ]);

    // The same log with nobody alive: interrupted, never waiting.
    const interrupted = foldAll([...scenario.pending, nobody]);
    expect(stream(interrupted, CHILD).group).toBe('recent');
    expect(stream(interrupted, CHILD).approval).toBe('none');
    expect(stream(interrupted, ROOT).approval).toBe('none');
    expect(interrupted.approvals).toHaveLength(1);

    // A replay that never received a snapshot folds the same way.
    const unknown = foldAll(scenario.pending);
    expect(stream(unknown, CHILD).group).toBe('recent');
  });

  it('applies text chunks to the streaming row without advancing settledSeq', () => {
    const log = new Log();
    log.emit(CHILD, 1500, {
      type: 'run.start',
      executionId: 'bbbbbbbbbbbb',
      identity: CHILD_IDENTITY,
      agentCategory: AgentCategory.ToolUse,
    });
    log.entry(CHILD, 1501, {
      id: 'response-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      text: 'Hel',
      data: { status: 'running' },
    });
    const view = foldAll([
      ...log.events,
      {
        type: 'text.chunk',
        streamId: CHILD,
        entryId: 'response-1',
        chunkIndex: 0,
        text: 'lo',
      },
      // A replayed chunk is idempotent.
      {
        type: 'text.chunk',
        streamId: CHILD,
        entryId: 'response-1',
        chunkIndex: 0,
        text: 'lo',
      },
    ]);
    const child = stream(view, CHILD);
    const row = child.transcript.rows[0];
    expect(row.kind).toBe('assistant');
    expect(row.kind === 'assistant' && row.text.full).toBe('Hello');
    expect(row.kind === 'assistant' && row.streaming).toBe(true);
    expect(child.transcript.settledSeq).toBe(2);
  });

  it('keeps an evicted parent in the ancestors of its orphans', () => {
    const view = foldAll([
      ...scenario.events,
      {
        type: 'removeStream',
        streamId: ROOT,
        seq: 99,
        ownerId: OWNER,
        timestamp: 3000,
      },
    ]);
    expect(view.streams.has(ROOT)).toBe(false);
    expect(view.order).toStrictEqual([PROCESS, CHILD]);
    expect(stream(view, CHILD).ancestors).toStrictEqual([
      { id: ROOT, label: 'review' },
    ]);
  });
});
