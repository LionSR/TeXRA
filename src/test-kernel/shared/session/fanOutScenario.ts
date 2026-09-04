// The recorded fan-out session every renderer is checked against: a
// workflow-script root, one child agent run with a grandchild of its own, a
// background process stream. `buildScenario` is the commit-ordered event log a
// publisher would replay; `fanOutView` and its variants fold it into the
// `SessionView` the fold test asserts on and the design harness renders, so
// the two can never drift.

import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  ToolConfigSchema,
  type ApprovalPolicySnapshot,
  type FoldInput,
  type LocalRuntimeState,
  type RunIdentity,
  type SessionEvent,
  type StreamLogEntry,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';

/** A process identity, never a lease token (contract C5). */
export const OWNER = '4242:2026-09-04T00:00:00.000Z';
export const OTHER_OWNER = '4343:2026-09-04T00:00:00.000Z';
export const ROOT = 'review#aaaaaaaaaaaa' as StreamTabId;
export const CHILD = 'search#bbbbbbbbbbbb' as StreamTabId;
export const GRANDCHILD = 'lint#dddddddddddd' as StreamTabId;
export const PROCESS = 'bash@tool#cccccccccccc' as StreamTabId;

export const ROOT_IDENTITY: RunIdentity = {
  kind: 'multiAgentWorkflow',
  workflowName: 'review',
};
export const CHILD_IDENTITY: RunIdentity = {
  kind: 'agent',
  agent: 'custom:search',
};
const GRANDCHILD_IDENTITY: RunIdentity = {
  kind: 'agent',
  agent: 'custom:lint',
};
export const ROOT_POLICY: ApprovalPolicySnapshot = {
  policy: 'ask',
  bypasses: { bash: false, toolEdit: true, superYolo: false },
};

/** `Omit` over each member of a union, so a fixture keeps its arm. */
type EntryFixture = StreamLogEntry extends infer E
  ? E extends unknown
    ? Omit<E, 'seqNo' | 'timestamp' | 'level'>
    : never
  : never;

/** A durable arm without its envelope: what a publisher builds before the
 *  aggregate, seq, commit, owner, and clock are stamped on. */
type SessionEventBody = SessionEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'aggregateId' | 'seq' | 'commit' | 'ownerId' | 'at'>
    : never
  : never;

/** Seq numbered per aggregate and committed in one session order, the way
 *  the event table keys them (contract C1). */
export class Log {
  readonly events: SessionEvent[] = [];
  private readonly seq = new Map<string, number>();
  private readonly entrySeq = new Map<StreamTabId, number>();
  private commit = 0;

  emit(
    aggregateId: string,
    at: number,
    body: SessionEventBody,
    ownerId: string | null = OWNER,
  ): SessionEvent {
    const seq = (this.seq.get(aggregateId) ?? 0) + 1;
    this.seq.set(aggregateId, seq);
    this.commit += 1;
    // A body is a distributive omit over the union, so the spread cannot be
    // typed back into the union without this assertion.
    const event = {
      aggregateId,
      seq,
      commit: this.commit,
      ownerId,
      at,
      ...body,
    } as SessionEvent;
    this.events.push(event);
    return event;
  }

  entry(
    streamId: StreamTabId,
    at: number,
    entry: EntryFixture,
  ): StreamLogEntry {
    const seqNo = (this.entrySeq.get(streamId) ?? 0) + 1;
    this.entrySeq.set(streamId, seqNo);
    const full: StreamLogEntry = {
      ...entry,
      seqNo,
      timestamp: at,
      level: 'info',
    };
    this.emit(streamId, at, { type: 'transcript.entry', entry: full });
    return full;
  }
}

export function call(
  status: 'planned' | 'running' | 'completed',
  childStreamId?: StreamTabId,
): WorkflowCallProgress {
  return {
    id: 'inspect',
    label: 'inspect',
    phase: 'Map',
    attemptId: 'attempt-1',
    ...(childStreamId ? { childStreamId } : {}),
    status,
  };
}

export const tail = (event: SessionEvent): FoldInput => ({
  _tag: 'event',
  read: 'all',
  event,
});

export const subscribe = (...ids: StreamTabId[]): FoldInput => ({
  _tag: 'subscriptions',
  set: ids.map((id) => ({ id, fromSeq: 0 })),
});

export function local(state: Partial<LocalRuntimeState>): FoldInput {
  return {
    _tag: 'local',
    local: { self: [], heldBy: [], unreadable: [], ...state },
  };
}

export function foldAll(
  inputs: readonly FoldInput[],
  from = emptySessionView('paper'),
): SessionView {
  return inputs.reduce(fold, from);
}

/**
 * The fan-out log. With `proposal`, the root also records a workflow-script
 * proposal awaiting approval (`req-plan`) in the pending prefix.
 */
export function buildScenario({ proposal = false } = {}) {
  const log = new Log();
  const rootEntries: StreamLogEntry[] = [];

  log.emit(ROOT, 1000, {
    type: 'run.start',
    executionId: 'aaaaaaaaaaaa',
    identity: ROOT_IDENTITY,
    category: AgentCategory.Workflow,
    isRemote: false,
    worktree: { workingDirectory: '/paper', branch: 'main' },
    userFollowUpSupport: 'unsupported',
    approvalPolicy: ROOT_POLICY,
    checkpointId: 'review@chat',
  });
  log.emit(ROOT, 1000, {
    type: 'run.activate',
    category: AgentCategory.Workflow,
    isRemote: false,
    background: false,
  });
  log.emit(ROOT, 1000, {
    type: 'run.config',
    executionId: 'aaaaaaaaaaaa',
    config: {
      model: 'claude-sonnet-4-5',
      instruction: 'review the draft',
      agent: 'review',
      inputFiles: ['draft.tex'],
    },
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
    category: AgentCategory.ToolUse,
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

  // The child's own delegate: a grandchild that starts and finishes while the
  // child waits, and one empty-round file fact the tab must not show.
  log.emit(GRANDCHILD, 1750, {
    type: 'run.start',
    executionId: 'dddddddddddd',
    identity: GRANDCHILD_IDENTITY,
    category: AgentCategory.ToolUse,
    isRemote: false,
    userFollowUpSupport: 'unsupported',
    parentStreamId: CHILD,
  });
  log.emit(GRANDCHILD, 1750, {
    type: 'status',
    phase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
    runStartedAt: 1750,
  });
  log.emit(GRANDCHILD, 1760, {
    type: 'addOutputFiles',
    filesByRound: { 1: [] },
  });
  log.emit(GRANDCHILD, 1780, {
    type: 'result',
    outcome: 'completed',
    executionId: 'dddddddddddd',
    category: AgentCategory.ToolUse,
    isSubagent: true,
  });
  log.emit(GRANDCHILD, 1780, {
    type: 'status',
    phase: STREAM_PHASE.COMPLETED,
    previousPhase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
  });

  // A background process stream, newer than the root: leads the order.
  log.emit(PROCESS, 2000, {
    type: 'run.start',
    executionId: 'cccccccccccc',
    identity: { kind: 'process', tool: 'bash' },
    category: AgentCategory.ToolUse,
    isRemote: false,
    userFollowUpSupport: 'unsupported',
  });
  log.emit(PROCESS, 2000, {
    type: 'run.config',
    executionId: 'cccccccccccc',
    config: { model: 'unused', instruction: 'npm test' },
  });

  if (proposal) {
    log.emit(ROOT, 1650, {
      type: 'approval.requested',
      requestId: 'req-plan',
      payload: {
        kind: 'proposal',
        data: {
          requestId: 'req-plan',
          streamId: ROOT,
          agentCategory: AgentCategory.Workflow,
          agent: 'review',
          model: 'claude-sonnet-4-5',
          instruction: 'review the draft',
          memories: [],
          inputFiles: ['draft.tex'],
          contextFiles: ['refs.bib'],
          mediaFiles: [],
          outputFiles: [],
          toolConfig: ToolConfigSchema.parse(undefined),
          workflowScript: {
            name: 'review',
            description:
              'Scout the draft, review every section in parallel, verify the fixes, report.',
            scriptPath: '.texra/workflows/review.mjs',
            phases: [
              { title: 'Scout' },
              { title: 'Review' },
              { title: 'Verify' },
              { title: 'Report' },
            ],
            tasks: [
              { id: 'scout', label: 'scout', phase: 'Scout' },
              { id: 'review:agent', label: 'review:agent', phase: 'Review' },
              { id: 'review:model', label: 'review:model', phase: 'Review' },
              { id: 'verify', label: 'verify', phase: 'Verify' },
              { id: 'report', label: 'report', phase: 'Report' },
            ],
          },
        },
      },
    });
  }

  const pending = log.events.length;

  log.emit(CHILD, 1800, { type: 'approval.resolved', requestId: 'req-1' });
  log.emit(CHILD, 1900, {
    type: 'result',
    outcome: 'completed',
    executionId: 'bbbbbbbbbbbb',
    category: AgentCategory.ToolUse,
    isSubagent: true,
  });
  log.emit(CHILD, 1900, {
    type: 'status',
    phase: STREAM_PHASE.COMPLETED,
    previousPhase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
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
  log.emit(ROOT, 1903, {
    type: 'status',
    phase: STREAM_PHASE.COMPLETED,
    previousPhase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
  });

  const events = log.events.map(tail);
  return {
    log,
    rootEntries,
    /** The replay a subscriber of every transcript folds. */
    events: [subscribe(ROOT, CHILD, GRANDCHILD, PROCESS), ...events],
    /** The prefix that ends with the child's approval still pending. */
    pending: [
      subscribe(ROOT, CHILD, GRANDCHILD, PROCESS),
      ...events.slice(0, pending),
    ],
  };
}

// ---------------------------------------------------------------------------
// Folded views for the renderers
// ---------------------------------------------------------------------------

/**
 * The fan-out mid-flight, owned by this process: `review` running with its
 * `inspect` call open, `search` waiting on the bash approval, `lint` done,
 * the `bash` process stream leading the order.
 */
export function fanOutView(): SessionView {
  return foldAll([...buildScenario().pending, local({ self: [OWNER] })]);
}

/** `fanOutView` plus a workflow-script proposal pending on the root. */
export function withProposal(): SessionView {
  return foldAll([
    ...buildScenario({ proposal: true }).pending,
    local({ self: [OWNER] }),
  ]);
}

interface BoardCall {
  readonly id: string;
  readonly phase: string;
  readonly status: WorkflowCallProgress['status'];
  /** The child stream the call opened; its label doubles as the stream's. */
  readonly child?: {
    readonly id: StreamTabId;
    readonly executionId: string;
    readonly startedAt: number;
    readonly latest?: string;
    readonly outputTokens?: number;
    readonly toolCalls?: number;
    /** A bash approval the child is waiting on. */
    readonly wantsBash?: string;
  };
  readonly error?: string;
  readonly attemptNumber?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

const child = (
  id: string,
  startedAt: number,
  extra: Omit<
    NonNullable<BoardCall['child']>,
    'id' | 'executionId' | 'startedAt'
  > = {},
): NonNullable<BoardCall['child']> => ({
  id: `${id}#${id
    .replace(/[^a-z]/g, '')
    .padEnd(12, 'e')
    .slice(0, 12)}` as StreamTabId,
  executionId: id
    .replace(/[^a-z]/g, '')
    .padEnd(12, 'e')
    .slice(0, 12),
  startedAt,
  ...extra,
});

/** The board's clock: what a host passes as `nowMs` to read elapsed. */
export const BOARD_NOW = 10_000_000;
const min = (n: number): number => n * 60_000;

/**
 * Two calls in `Scout`, every kind of row in `Review`, `Verify` and `Report`
 * only declared: a waiting call (its child holds a bash approval), a failed
 * one on its second attempt, four running with live lines and tokens, five
 * finished (one a saved result), two planned, and one plan task unissued.
 */
const BOARD_CALLS: readonly BoardCall[] = [
  {
    id: 'scout:tree',
    phase: 'Scout',
    status: 'completed',
    durationMs: min(3),
    costUsd: 0.21,
  },
  {
    id: 'scout:deps',
    phase: 'Scout',
    status: 'completed',
    durationMs: min(2),
    costUsd: 0.12,
  },
  {
    id: 'review:agent',
    phase: 'Review',
    status: 'running',
    child: child('review:agent', BOARD_NOW - min(2), {
      wantsBash: 'pnpm vitest src/agent',
      toolCalls: 4,
    }),
  },
  {
    id: 'review:model',
    phase: 'Review',
    status: 'failed',
    error: 'Context budget exceeded',
    attemptNumber: 2,
    child: child('review:model', BOARD_NOW - min(9)),
  },
  {
    id: 'review:tools',
    phase: 'Review',
    status: 'running',
    child: child('review:tools', BOARD_NOW - min(6), {
      latest: 'Reading 14 files',
      outputTokens: 4100,
      toolCalls: 14,
    }),
  },
  {
    id: 'review:cli',
    phase: 'Review',
    status: 'running',
    child: child('review:cli', BOARD_NOW - min(5), {
      latest: 'grep dead exports',
      outputTokens: 2800,
      toolCalls: 9,
    }),
  },
  {
    id: 'review:desktop',
    phase: 'Review',
    status: 'running',
    child: child('review:desktop', BOARD_NOW - min(3), {
      latest: 'typecheck',
      outputTokens: 1100,
      toolCalls: 2,
    }),
  },
  {
    id: 'review:shared',
    phase: 'Review',
    status: 'running',
    child: child('review:shared', BOARD_NOW - min(1)),
  },
  {
    id: 'review:latex',
    phase: 'Review',
    status: 'completed',
    durationMs: min(4),
    costUsd: 0.4,
  },
  {
    id: 'review:docs',
    phase: 'Review',
    status: 'completed',
    durationMs: min(2),
    costUsd: 0.18,
  },
  {
    id: 'review:tests',
    phase: 'Review',
    status: 'completed',
    durationMs: min(5),
    costUsd: 0.33,
  },
  {
    id: 'review:scripts',
    phase: 'Review',
    status: 'completed',
    durationMs: min(1),
    costUsd: 0.09,
  },
  { id: 'review:legal', phase: 'Review', status: 'cached' },
  { id: 'review:relay', phase: 'Review', status: 'planned' },
  { id: 'review:auth', phase: 'Review', status: 'planned' },
];

function boardProgress(entry: BoardCall): WorkflowCallProgress {
  const base = {
    id: entry.id,
    label: entry.id,
    phase: entry.phase,
    attemptId: 'attempt-1',
    kind: 'structured' as const,
    agent: 'review',
    model: 'claude-sonnet-4-5',
    ...(entry.attemptNumber === undefined
      ? {}
      : { attemptNumber: entry.attemptNumber }),
    ...(entry.child ? { childStreamId: entry.child.id } : {}),
  };
  const terminal = {
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    ...(entry.costUsd === undefined ? {} : { totalCostUsd: entry.costUsd }),
  };
  switch (entry.status) {
    case 'failed':
      return { ...base, status: 'failed', error: entry.error ?? 'failed' };
    case 'completed':
      return { ...base, status: 'completed', ...terminal };
    case 'cancelled':
      return { ...base, status: 'cancelled', ...terminal };
    case 'skipped':
      return { ...base, status: 'skipped', reason: 'user', ...terminal };
    case 'cached':
    case 'declared':
    case 'planned':
    case 'queued':
    case 'running':
      return { ...base, status: entry.status };
  }
}

/**
 * A workflow run mid-flight for the run board: the `review` root with its
 * `Scout` phase closed, `Review` open with every row kind, `Verify` and
 * `Report` declared by the plan marker. Each running call's child stream
 * carries the facts the board joins (start time, tokens, tool calls, the
 * latest line); the waiting call's child holds a bash approval.
 */
export function withWaitingCall(): SessionView {
  const log = new Log();
  const startedAt = BOARD_NOW - min(38);
  log.emit(ROOT, startedAt, {
    type: 'run.start',
    executionId: 'aaaaaaaaaaaa',
    identity: { kind: 'multiAgentWorkflow', workflowName: 'review' },
    category: AgentCategory.Workflow,
    isRemote: false,
    worktree: { workingDirectory: '/paper', branch: 'main' },
    userFollowUpSupport: 'unsupported',
    approvalPolicy: ROOT_POLICY,
    checkpointId: 'review@chat',
  });
  log.emit(ROOT, startedAt, {
    type: 'run.activate',
    category: AgentCategory.Workflow,
    isRemote: false,
    background: false,
  });
  log.emit(ROOT, startedAt, {
    type: 'run.config',
    executionId: 'aaaaaaaaaaaa',
    config: {
      model: 'claude-sonnet-4-5',
      instruction: 'simplification survey over the draft',
      agent: 'review',
      inputFiles: ['draft.tex'],
    },
  });
  log.emit(ROOT, startedAt, {
    type: 'status',
    phase: STREAM_PHASE.RUNNING,
    cause: 'lifecycle',
    runStartedAt: startedAt,
  });
  log.emit(ROOT, startedAt, {
    type: 'usage',
    storageKey: 'aaaaaaaaaaaa',
    usage: { inputTokens: 210_000, outputTokens: 41_000, cost: 1.84 },
  });
  const phases = ['Scout', 'Review', 'Verify', 'Report'];
  log.entry(ROOT, startedAt + 1, {
    id: 'plan',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    messageType: MESSAGE_TYPES.INTERNAL,
    text: '',
    data: {
      kind: 'workflowPlan',
      attemptId: 'attempt-1',
      phases: phases.map((title) => ({ title })),
      tasks: [
        ...BOARD_CALLS.map((entry) => ({
          id: entry.id,
          label: entry.id,
          phase: entry.phase,
        })),
        { id: 'review:release', label: 'review:release', phase: 'Review' },
        { id: 'verify', label: 'verify', phase: 'Verify' },
        { id: 'report', label: 'report', phase: 'Report' },
      ],
    },
  });

  const openPhase = (title: string, at: number): void => {
    const index = phases.indexOf(title);
    log.entry(ROOT, at, {
      id: `phase-${title}`,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      text: title,
      data: {
        kind: 'phase',
        index,
        total: phases.length,
        attemptId: 'attempt-1',
      },
    });
    log.emit(ROOT, at, {
      type: 'stage.start',
      id: `phase-${title}`,
      label: title,
      kind: 'phase',
      index,
      total: phases.length,
    });
  };
  const closePhase = (title: string, at: number): void => {
    log.entry(ROOT, at, {
      id: `phase-${title}`,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      text: title,
      data: { kind: 'phase', status: 'completed', endTime: at },
    });
  };
  const card = (entry: BoardCall, at: number): void => {
    log.entry(ROOT, at, {
      id: `call-${entry.id}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      groupId: `phase-${entry.phase}`,
      data: boardProgress(entry),
    });
  };

  openPhase('Scout', startedAt + 2);
  for (const entry of BOARD_CALLS.filter((c) => c.phase === 'Scout')) {
    card(entry, startedAt + 3);
  }
  closePhase('Scout', startedAt + min(5));
  openPhase('Review', startedAt + min(5) + 1);
  let at = startedAt + min(5) + 2;
  for (const entry of BOARD_CALLS.filter((c) => c.phase === 'Review')) {
    at += 1;
    if (entry.child) {
      const { child: kid } = entry;
      log.emit(kid.id, kid.startedAt, {
        type: 'run.start',
        executionId: kid.executionId,
        identity: { kind: 'agent', agent: `custom:${entry.id}` },
        category: AgentCategory.ToolUse,
        isRemote: false,
        parentStreamId: ROOT,
        userFollowUpSupport: 'unsupported',
      });
      log.emit(kid.id, kid.startedAt, {
        type: 'run.config',
        executionId: kid.executionId,
        config: { model: 'claude-sonnet-4-5', instruction: entry.id },
      });
      log.emit(kid.id, kid.startedAt, {
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
        runStartedAt: kid.startedAt,
      });
      if (kid.latest) {
        log.entry(kid.id, kid.startedAt + 1, {
          id: `${entry.id}-instruction`,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          messageType: MESSAGE_TYPES.USER_MESSAGE,
          text: kid.latest,
        });
      }
      if (kid.toolCalls !== undefined) {
        log.emit(kid.id, kid.startedAt + 2, {
          type: 'conversation.progress',
          progress: { toolCallCount: kid.toolCalls },
        });
      }
      if (kid.outputTokens !== undefined) {
        log.emit(kid.id, kid.startedAt + 3, {
          type: 'usage',
          storageKey: kid.executionId,
          usage: {
            inputTokens: kid.outputTokens * 5,
            outputTokens: kid.outputTokens,
            cost: kid.outputTokens / 20_000,
          },
        });
      }
      if (kid.wantsBash) {
        log.emit(kid.id, kid.startedAt + 4, {
          type: 'approval.requested',
          requestId: `req-${entry.id}`,
          payload: {
            kind: 'bash',
            data: {
              requestId: `req-${entry.id}`,
              allowBypass: true,
              streamId: kid.id,
              command: kid.wantsBash,
            },
          },
        });
      }
      if (entry.status === 'failed') {
        log.emit(kid.id, kid.startedAt + min(2), {
          type: 'result',
          outcome: 'failed',
          executionId: kid.executionId,
          category: AgentCategory.ToolUse,
          isSubagent: true,
        });
        log.emit(kid.id, kid.startedAt + min(2), {
          type: 'status',
          phase: STREAM_PHASE.FAILED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        });
      }
    }
    card(entry, at);
  }
  const ids = [ROOT, ...BOARD_CALLS.flatMap((c) => c.child?.id ?? [])];
  return foldAll([
    subscribe(...ids),
    ...log.events.map(tail),
    local({ self: [OWNER] }),
  ]);
}
