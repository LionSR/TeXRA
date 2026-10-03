// The recorded fan-out session every renderer is checked against: a
// background script root, one child agent run with a grandchild of its own, a
// process run. `buildScenario` is the commit-ordered event log a
// publisher would replay; `fanOutView` and its variants fold it into the
// `SessionView` the fold test asserts on and the design harness renders, so
// the two can never drift.

import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  AgentConfigFieldsSchema,
  emptyRunEndOutput,
  MESSAGE_TYPES,
  RunIdSchema,
  ToolConfigSchema,
  type ApprovalPolicySnapshot,
  type FoldInput,
  type LocalRuntimeState,
  type RunIdentity,
  type DisplaySessionEvent,
  type RunId,
  type RunParent,
} from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';

/** A process identity, never a lease token (contract C5). */
export const OWNER = '["test-host",4242,"2026-09-04T00:00:00.000Z"]';
export const OTHER_OWNER = '["test-host",4343,"2026-09-04T00:00:00.000Z"]';
export const ROOT = RunIdSchema.parse('aaaaaaaaaaaa');
export const CHILD = RunIdSchema.parse('bbbbbbbbbbbb');
export const GRANDCHILD = RunIdSchema.parse('dddddddddddd');
export const PROCESS = RunIdSchema.parse('cccccccccccc');

/** The board's clock: what a host passes as `nowMs` to read elapsed. Every
 *  fixture timestamp is anchored to it so the harness reads minutes. */
export const BOARD_NOW = 10_000_000;
const min = (n: number): number => n * 60_000;
const sec = (n: number): number => n * 1000;
/** The fan-out's beats: the root started 12m ago, the child 4m ago, the
 *  grandchild finished 1m ago, the process leads the order at 30s ago; the
 *  tail that closes the run lands in the last 20s. */
export const T = {
  root: BOARD_NOW - min(12),
  child: BOARD_NOW - min(4),
  childProgress: BOARD_NOW - min(3),
  proposal: BOARD_NOW - min(3) + sec(30),
  childApproval: BOARD_NOW - min(2) - sec(30),
  grandchild: BOARD_NOW - min(2),
  grandchildFiles: BOARD_NOW - min(2) + sec(10),
  grandchildDone: BOARD_NOW - min(1),
  process: BOARD_NOW - sec(30),
  approvalResolved: BOARD_NOW - sec(20),
  childDone: BOARD_NOW - sec(10),
  rootDone: BOARD_NOW - sec(8),
} as const;

export const ROOT_IDENTITY: RunIdentity = { kind: 'script', title: 'review' };
export const CHILD_IDENTITY: RunIdentity = {
  kind: 'agent',
  agent: 'custom:search',
};
const GRANDCHILD_IDENTITY: RunIdentity = {
  kind: 'agent',
  agent: 'custom:lint',
};
/** The root script's stage: its calls' cards carry it as their group. */
const SCRIPT_STAGE = 'script-review';
export const ROOT_POLICY: ApprovalPolicySnapshot = {
  policy: 'ask',
  bypasses: { bash: false, toolEdit: true, superYolo: false },
  own: {},
  goal: [],
};

/** A durable arm without its envelope: what a publisher builds before the
 *  aggregate, seq, commit, owner, and clock are stamped on. */
type DisplaySessionEventBody = DisplaySessionEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'aggregateId' | 'seq' | 'commit' | 'origin' | 'at'>
    : never
  : never;

/** Seq numbered per aggregate and committed in one session order, the way
 *  the event table keys them (contract C1). */
export class Log {
  readonly events: DisplaySessionEvent[] = [];
  private readonly seq = new Map<string, number>();
  /** Each run's incarnation uid: what the database stamps on a child's
   *  `run.start.parent` (one run model, section 3.2). */
  private readonly uid = new Map<RunId, string>();
  private commit = 0;

  emit(
    runId: RunId,
    at: number,
    body: DisplaySessionEventBody,
    origin: string | null = OWNER,
  ): DisplaySessionEvent {
    const key =
      body.type === 'inquiryThreadUpdated'
        ? // An inquiry aggregate is keyed by its thread id, a plain logical
          // id; this scenario threads one per run.
          qualifyAggregateId('inquiry', runId as string)
        : qualifyAggregateId('run', runId);
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    this.commit += 1;
    if (body.type === 'run.start') {
      const n = this.commit.toString(16).padStart(12, '0');
      this.uid.set(runId, `00000000-0000-4000-8000-${n}`);
    }
    // A body is a distributive omit over the union, so the spread cannot be
    // typed back into the union without this assertion.
    const event = {
      aggregateId: key,
      seq,
      commit: this.commit,
      origin,
      at,
      ...body,
    } as DisplaySessionEvent;
    this.events.push(event);
    return event;
  }

  /** The parent edge a child's `run.start` carries: the launching run and
   *  its incarnation uid. A parent with no `run.start` is refused, as the
   *  database refuses it. */
  parent(id: RunId): RunParent {
    const uid = this.uid.get(id);
    if (uid === undefined) {
      throw new Error(`fixture parent ${id} has no run.start`);
    }
    return { id, uid, callId: null };
  }

  /** Finite-read marker for this fixture log, whose first facts acquire its claims. */
  drained(through = this.events.length): FoldInput {
    const claims = new Map<DisplaySessionEvent['aggregateId'], string | null>();
    const removed = new Set<DisplaySessionEvent['aggregateId']>();
    for (const event of this.events.slice(0, through)) {
      if (event.seq === 1) claims.set(event.aggregateId, event.origin);
      if (event.type === 'run.removed') {
        claims.delete(event.aggregateId);
        removed.add(event.aggregateId);
      }
    }
    return {
      _tag: 'drained',
      cursor: this.events[through - 1]?.commit ?? 0,
      existence: {
        checkedAggregateIds: [...claims.keys(), ...removed],
        removedAggregateIds: [...removed],
        claims: [...claims].map(([aggregateId, ownerId]) => ({
          aggregateId,
          ownerId,
        })),
      },
    };
  }
}

export const tail = (event: DisplaySessionEvent): FoldInput => ({
  _tag: 'event',
  read: 'all',
  event,
});

export const subscribe = (...ids: RunId[]): FoldInput => ({
  _tag: 'subscriptions',
  set: ids.map((id) => ({ id: qualifyAggregateId('run', id), fromSeq: 0 })),
});

export function local(state: Partial<LocalRuntimeState>): FoldInput {
  return {
    _tag: 'local',
    local: { self: [], dead: [], unreadable: [], resumeBlocked: [], ...state },
  };
}

export function foldAll(
  inputs: readonly FoldInput[],
  from = emptySessionView('paper'),
): SessionView {
  return inputs.reduce(fold, from);
}

/**
 * The fan-out log. With `proposal`, the root also records its script's
 * agent request awaiting approval (`req-plan`) in the pending prefix.
 */
export function buildScenario({ proposal = false } = {}) {
  const log = new Log();

  log.emit(ROOT, T.root, {
    type: 'run.start',
    identity: ROOT_IDENTITY,
    category: AgentCategory.ToolUse,
    worktree: { workingDirectory: '/paper', branch: 'main' },
    parent: null,
    provenance: null,
    userFollowUpSupport: 'unsupported',
    approvalPolicy: ROOT_POLICY,
  });
  log.emit(ROOT, T.root, {
    type: 'run.activate',
    category: AgentCategory.ToolUse,
  });
  log.emit(ROOT, T.root, {
    type: 'run.config',
    config: AgentConfigFieldsSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      model: 'claude-sonnet-4-5',
      instruction: 'review the draft',
      agent: 'review',
    }),
  });
  log.emit(ROOT, T.root + 1, {
    type: 'stage.start',
    id: SCRIPT_STAGE,
    label: 'review',
    kind: 'script',
  });
  // The script's one `agent` call: its card opens under the script's stage
  // and launches the child.
  log.emit(ROOT, T.root + 2, {
    type: 'tool.start',
    logId: 'call-1',
    stageId: SCRIPT_STAGE,
    toolName: 'agent',
    input: { agentName: 'custom:search', prompt: 'search', label: 'inspect' },
    phase: 'Map',
  });

  // The child agent run: its run.start carries the whole parent edge.
  log.emit(CHILD, T.child, {
    type: 'run.start',
    identity: CHILD_IDENTITY,
    category: AgentCategory.ToolUse,
    parent: log.parent(ROOT),
    provenance: null,
    parentCard: 'call-1',
    userFollowUpSupport: 'nativeInteractive',
  });
  log.emit(CHILD, T.child, {
    type: 'run.config',
    config: AgentConfigFieldsSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      model: 'claude-sonnet-4-5',
      instruction: 'search',
    }),
  });
  log.emit(CHILD, T.child, {
    type: 'run.activate',
    category: AgentCategory.ToolUse,
  });
  // The loop's position: an agent run reads as initializing until its first
  // step, so a mid-flight fixture carries one (one run model, 3.3).
  log.emit(CHILD, T.childProgress, {
    type: 'run.position',
    payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
  });
  log.emit(CHILD, T.childProgress, {
    type: 'conversation.progress',
    progress: { toolCallCount: 3 },
  });
  log.emit(CHILD, T.childApproval, {
    type: 'request.opened',
    requestId: 'req-1',
    payload: {
      kind: 'bash',
      data: {
        requestId: 'req-1',
        allowBypass: true,
        runId: CHILD,
        command: 'ls',
      },
    },
  });

  // The child's own delegate: the dispatching tool row, then a grandchild
  // that starts and finishes while the child waits, and one empty-round file
  // fact the tab must not show.
  const dispatchData = {
    toolName: 'agent',
    input: { agentName: 'lint', prompt: 'lint appendix B' },
  };
  log.emit(CHILD, T.grandchild - 1, {
    type: 'tool.start',
    logId: 'dispatch-lint',
    toolName: dispatchData.toolName,
    input: dispatchData.input,
  });
  log.emit(GRANDCHILD, T.grandchild, {
    type: 'run.start',
    identity: GRANDCHILD_IDENTITY,
    category: AgentCategory.ToolUse,
    userFollowUpSupport: 'unsupported',
    parent: log.parent(CHILD),
    provenance: null,
  });
  log.emit(GRANDCHILD, T.grandchild, {
    type: 'run.activate',
    category: AgentCategory.ToolUse,
  });
  log.emit(GRANDCHILD, T.grandchild, {
    type: 'run.position',
    payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
  });
  log.emit(GRANDCHILD, T.grandchildFiles, {
    type: 'output.produced',
    rounds: [
      {
        round: 1,
        rawOutput: null,
        outputs: [],
        compileFailures: [],
        missingOutputs: [],
      },
    ],
  });
  log.emit(GRANDCHILD, T.grandchildDone, {
    type: 'run.end',
    outcome: 'completed',
    output: emptyRunEndOutput(AgentCategory.ToolUse),
  });
  // The tool's result lands the way the recorder settles it: the outcome
  // merged over the stored row, so the row keeps its id, seqNo, and
  // timestamp under a later commit.
  log.emit(CHILD, T.grandchildDone + 1, {
    type: 'tool.end',
    logId: 'dispatch-lint',
    status: 'completed',
    result: { ...dispatchData, output: 'Appendix B: no findings.' },
  });

  // A top-level process run, newer than the root: leads the order.
  log.emit(PROCESS, T.process, {
    type: 'run.start',
    identity: { kind: 'process', tool: 'bash' },
    category: AgentCategory.ToolUse,
    parent: null,
    provenance: null,
    userFollowUpSupport: 'unsupported',
  });
  log.emit(PROCESS, T.process, {
    type: 'run.config',
    config: AgentConfigFieldsSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      model: 'unused',
      instruction: 'npm test',
    }),
  });
  // Its output arrives as raw stdout chunks, one plain log entry each; the
  // process conversation paints them back as one terminal text.
  for (const [offset, text] of [
    '\n> texra-workspace@0.40.9 test\n> vitest run\n\n',
    ' RUN  v4.0.0 /paper\n\n',
    ' ✓ src/test-kernel/latex/Compile.vitest.ts (12 tests) 340ms\n',
    ' ✓ src/test-kernel/shared/session/sessionFold.vitest.ts (31 tests) 1.2s\n',
  ].entries()) {
    log.emit(PROCESS, T.process + sec(1 + offset), {
      type: 'log',
      level: 'info',
      messageType: MESSAGE_TYPES.DEFAULT,
      message: text,
    });
  }

  if (proposal) {
    log.emit(ROOT, T.proposal, {
      type: 'request.opened',
      requestId: 'req-plan',
      payload: {
        kind: 'proposal',
        data: {
          requestId: 'req-plan',
          runId: ROOT,
          agentCategory: AgentCategory.Workflow,
          agent: 'review',
          model: 'claude-sonnet-4-5',
          instruction: 'Review the draft.',
          memories: [],
          inputFiles: ['draft.tex'],
          contextFiles: ['refs.bib'],
          mediaFiles: [],
          outputFiles: [],
          toolConfig: ToolConfigSchema.parse(undefined),
          script: {
            title: 'review',
            source: [
              "phase('Review')",
              'const reviews = await Promise.all(',
              "  ['agent', 'model'].map((part) =>",
              "    agent(`Review the ${part} section.`, { agentName: 'review', inputFiles: ['draft.tex'] }),",
              '  ),',
              ')',
              'return reviews.map((review) => review.outputs)',
            ].join('\n'),
            calls: [],
          },
        },
      },
    });
  }

  const pending = log.events.length;

  log.emit(CHILD, T.approvalResolved, {
    type: 'request.decided',
    requestId: 'req-1',
    decision: { action: 'approve' },
  });
  log.emit(CHILD, T.childDone, {
    type: 'run.end',
    outcome: 'completed',
    output: emptyRunEndOutput(AgentCategory.ToolUse),
  });
  log.emit(ROOT, T.childDone + 1, {
    type: 'tool.end',
    logId: 'call-1',
    status: 'completed',
    result: { output: 'search done', summary: "Completed 'custom:search'" },
  });
  log.emit(ROOT, T.childDone + 2, {
    type: 'stage.end',
    id: SCRIPT_STAGE,
    status: 'completed',
  });
  log.emit(ROOT, T.rootDone, {
    type: 'run.end',
    outcome: 'completed',
    output: emptyRunEndOutput(AgentCategory.ToolUse),
  });

  const events = log.events.map(tail);
  return {
    log,
    /** The replay a subscriber of every transcript folds. */
    events: [
      subscribe(ROOT, CHILD, GRANDCHILD, PROCESS),
      ...events,
      log.drained(),
    ],
    /** The prefix that ends with the child's approval still pending. */
    pending: [
      subscribe(ROOT, CHILD, GRANDCHILD, PROCESS),
      ...events.slice(0, pending),
      log.drained(pending),
    ],
  };
}

// ---------------------------------------------------------------------------
// Folded views for the renderers
// ---------------------------------------------------------------------------

/**
 * The fan-out mid-flight, owned by this process: `review` running with its
 * `inspect` call open, `search` waiting on the bash approval, `lint` done,
 * the `bash` process run leading the order.
 */
export function fanOutView(): SessionView {
  return foldAll([...buildScenario().pending, local({ self: [OWNER] })]);
}

/** Every recorded event of one aggregate re-owned: what the log holds when
 *  another process ran that run. */
function ownedBy(
  inputs: readonly FoldInput[],
  aggregateId: RunId,
  ownerId: string,
): FoldInput[] {
  const key = qualifyAggregateId('run', aggregateId);
  return inputs.map((input) => {
    if (input._tag === 'drained' || input._tag === 'replay.complete') {
      return {
        ...input,
        existence: {
          ...input.existence,
          claims: input.existence.claims.map((claim) =>
            claim.aggregateId === key ? { ...claim, ownerId } : claim,
          ),
        },
      };
    }
    return input;
  });
}

/** `fanOutView` with no approval pending: nothing forces the tree open, so
 *  a collapsed parent shows its rollup. */
export function withoutApproval(): SessionView {
  return foldAll([
    ...buildScenario().pending.filter(
      (input) =>
        !(input._tag === 'event' && input.event.type === 'request.opened'),
    ),
    local({ self: [OWNER] }),
  ]);
}

/** `fanOutView` with `search` run by a process nobody holds any more: an
 *  in-flight run whose owner is gone reads as interrupted. */
export function withInterruptedChild(): SessionView {
  return foldAll([
    ...ownedBy(buildScenario().pending, CHILD, OTHER_OWNER),
    local({ self: [OWNER], dead: [OTHER_OWNER] }),
  ]);
}

/** `fanOutView` with the approval on `lint`, still running under `search`:
 *  the waiting row is a grandchild of the root. */
export function withWaitingGrandchild(): SessionView {
  const { pending } = buildScenario();
  const inputs = pending.filter(
    (input) =>
      !(
        input._tag === 'event' &&
        ((input.event.aggregateId === qualifyAggregateId('run', GRANDCHILD) &&
          input.event.type === 'run.end' &&
          input.event.at === T.grandchildDone) ||
          input.event.type === 'request.opened')
      ),
  );
  const log = new Log();
  log.emit(GRANDCHILD, T.grandchildDone, {
    type: 'request.opened',
    requestId: 'req-lint',
    payload: {
      kind: 'bash',
      data: {
        requestId: 'req-lint',
        allowBypass: true,
        runId: GRANDCHILD,
        command: 'latexmk -pdf appendixB.tex',
      },
    },
  });
  return foldAll([
    ...inputs,
    ...log.events.map(tail),
    local({ self: [OWNER] }),
  ]);
}

/** `fanOutView` plus its script's agent request pending on the root. */
export function withProposal(): SessionView {
  return foldAll([
    ...buildScenario({ proposal: true }).pending,
    local({ self: [OWNER] }),
  ]);
}
