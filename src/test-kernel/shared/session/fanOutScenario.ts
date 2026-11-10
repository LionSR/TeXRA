// The recorded fan-out session every renderer is checked against: a
// background script root, one child agent run with a grandchild of its own, a
// process run. `buildScenario` is the commit-ordered event log a
// publisher would replay; `fanOutView` and its variants apply it to the
// `SessionView` the view test asserts on and the design harness renders, so
// the two can never drift.

import { Schema } from 'effect';
import {
  AgentConfigSchema,
  type ApprovalGrants,
  type DisplayRow,
  emptyRunEndOutput,
  type LocalRuntimeState,
  MESSAGE_TYPES,
  qualifyAggregateId,
  type RunId,
  type RunIdentity,
  RunIdSchema,
  type SessionView,
} from '@texra-ai/harness/schemas';
import type { RunParent } from '@shared/schemas';
import {
  makeSessionViewUpdater,
  type SessionViewUpdater,
} from '@shared/session/sessionViewUpdate';
import { DOCUMENTS_OUTPUT_KIND } from '@texra/shared/plugins/documents';
import type { SessionViewInput } from '@texra-ai/harness/transcript';

export const ROOT = Schema.decodeUnknownSync(RunIdSchema)('aaaaaaaaaaaa');
export const CHILD = Schema.decodeUnknownSync(RunIdSchema)('bbbbbbbbbbbb');
export const GRANDCHILD = Schema.decodeUnknownSync(RunIdSchema)('dddddddddddd');
export const PROCESS = Schema.decodeUnknownSync(RunIdSchema)('cccccccccccc');

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

const ROOT_IDENTITY: RunIdentity = { kind: 'script', title: 'review' };
const CHILD_IDENTITY: RunIdentity = {
  kind: 'agent',
  agent: 'custom:search',
};
const GRANDCHILD_IDENTITY: RunIdentity = {
  kind: 'agent',
  agent: 'custom:lint',
};
/** The root script's `script` card, its stage: its calls' cards carry it
 *  as their group. */
const SCRIPT_STAGE = 'script-card';
const ROOT_POLICY: ApprovalGrants = {
  own: { toolEdit: 'on' },
  goal: [],
};

/** A durable arm without its envelope: what a publisher builds before the
 *  aggregate, seq, commit and clock are stamped on. */
type DisplaySessionEventBody = DisplayRow extends infer E
  ? E extends unknown
    ? Omit<E, 'aggregateId' | 'seq' | 'commit' | 'at'>
    : never
  : never;

/** Seq numbered per aggregate and committed in one session order, the way
 *  the event table keys them. */
export class Log {
  readonly events: DisplayRow[] = [];
  private readonly seq = new Map<string, number>();
  /** Each run's incarnation uid: what the database stamps on a child's
   *  `run.start.parent` (one run model, section 3.2). */
  private readonly uid = new Map<RunId, string>();
  private commit = 0;

  emit(runId: RunId, at: number, body: DisplaySessionEventBody): DisplayRow {
    const key = qualifyAggregateId('run', runId);
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    this.commit += 1;
    if (body.type === 'run.start') {
      const n = this.commit.toString(16).padStart(12, '0');
      this.uid.set(runId, `00000000-0000-4000-8000-${n}`);
    }
    // cast: a body is a distributive omit; its spread is one of the union.
    const event = {
      aggregateId: key,
      seq,
      commit: this.commit,
      at,
      ...body,
    } as DisplayRow;
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
    return { id, uid, call: null };
  }

  /** Finite-read marker for this fixture log: every aggregate its first
   *  facts created exists until its removal. */
  drained(through = this.events.length): SessionViewInput {
    const present = new Set<DisplayRow['aggregateId']>();
    const removed = new Set<DisplayRow['aggregateId']>();
    for (const event of this.events.slice(0, through)) {
      if (event.seq === 1) present.add(event.aggregateId);
      if (event.type === 'run.removed') {
        present.delete(event.aggregateId);
        removed.add(event.aggregateId);
      }
    }
    return {
      _tag: 'drained',
      cursor: this.events[through - 1]?.commit ?? 0,
      existence: {
        checkedAggregateIds: [...present, ...removed],
        present: [...present],
        unreadable: [],
      },
    };
  }
}

export const tail = (event: DisplayRow): SessionViewInput => ({
  _tag: 'event',
  read: 'all',
  event,
});

export const subscribe = (...ids: RunId[]): SessionViewInput => ({
  _tag: 'subscriptions',
  set: ids.map((id) => ({ id: qualifyAggregateId('run', id), fromSeq: 0 })),
});

/** Every run of the scenario, as launched here. */
export const ALL_RUNS: readonly RunId[] = [ROOT, CHILD, GRANDCHILD, PROCESS];

export function local(state: Partial<LocalRuntimeState>): SessionViewInput {
  return { _tag: 'local', local: { runsHere: [], ...state } };
}

/** `updater`'s view (by default a fresh one of session `paper`) after
 *  `inputs`, each applied in its own call, as frames of one. */
export function viewOf(
  inputs: readonly SessionViewInput[],
  updater: SessionViewUpdater = makeSessionViewUpdater('paper'),
): SessionView {
  for (const input of inputs) updater.apply(input);
  return updater.current();
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
    worktree: { workingDirectory: '/paper' },
    parent: null,
    provenance: null,
    takesFollowUps: false,
    approvalPolicy: ROOT_POLICY,
  });
  log.emit(ROOT, T.root, {
    type: 'run.activate',
  });
  log.emit(ROOT, T.root, {
    type: 'run.config',
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      model: 'claude-sonnet-5-5',
      instruction: 'review the draft',
      agent: 'review',
    }),
  });
  log.emit(ROOT, T.root + 1, {
    type: 'tool.start',
    logId: SCRIPT_STAGE,
    toolName: 'script',
    input: { code: '', title: 'review' },
  });
  // The script's one `agent` call: its card opens under the script's stage
  // and launches the child.
  log.emit(ROOT, T.root + 2, {
    type: 'tool.start',
    logId: 'call-1',
    stageId: SCRIPT_STAGE,
    toolName: 'agent',
    input: { agentName: 'custom:search', prompt: 'search', label: 'inspect' },
    section: 'Map',
  });

  // The child agent run: its run.start carries the whole parent edge.
  log.emit(CHILD, T.child, {
    type: 'run.start',
    identity: CHILD_IDENTITY,
    parent: {
      ...log.parent(ROOT),
      call: { callId: 'call-1', card: 'call-1', awaited: false },
    },
    provenance: null,
    takesFollowUps: true,
  });
  log.emit(CHILD, T.child, {
    type: 'run.config',
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      model: 'claude-sonnet-5-5',
      instruction: 'search',
    }),
  });
  log.emit(CHILD, T.child, {
    type: 'run.activate',
  });
  // The loop's position: an agent run reads as initializing until its first
  // step, so a mid-flight fixture carries one (one run model, 3.3).
  log.emit(CHILD, T.childProgress, {
    type: 'run.position',
    payload: { at: 'turn.begin', turn: 1 },
  });
  log.emit(CHILD, T.childApproval, {
    type: 'request.opened',
    requestId: 'req-1',
    payload: {
      kind: 'bash',
      data: {
        requestId: 'req-1',
        runId: CHILD,
        command: 'ls',
      },
    },
    answeredBy: 'bash',
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
    takesFollowUps: false,
    parent: log.parent(CHILD),
    provenance: null,
  });
  log.emit(GRANDCHILD, T.grandchild, {
    type: 'run.activate',
  });
  log.emit(GRANDCHILD, T.grandchild, {
    type: 'run.position',
    payload: { at: 'turn.begin', turn: 1 },
  });
  log.emit(GRANDCHILD, T.grandchildFiles, {
    type: 'plugin.fact',
    plugin: DOCUMENTS_OUTPUT_KIND.plugin,
    kind: DOCUMENTS_OUTPUT_KIND.kind,
    version: DOCUMENTS_OUTPUT_KIND.version,
    parent: null,
    value: {
      rounds: [
        {
          round: 1,
          outputs: [],
          compile: null,
          missingOutputs: [],
          latexdiffs: [],
          reply: null,
        },
      ],
    },
  });
  log.emit(GRANDCHILD, T.grandchildDone, {
    type: 'run.end',
    outcome: 'completed',
    output: emptyRunEndOutput(),
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
    parent: null,
    provenance: null,
    takesFollowUps: false,
  });
  log.emit(PROCESS, T.process, {
    type: 'run.config',
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
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
          task: true,
          agent: 'review',
          model: 'claude-sonnet-5-5',
          instruction: 'Review the draft.',
          memories: [],
          inputFiles: ['draft.tex'],
          contextFiles: ['refs.bib'],
          mediaFiles: [],
          outputFiles: [],
          script: {
            title: 'review',
            source: [
              "section('Review')",
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
      answeredBy: 'superYolo',
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
    output: emptyRunEndOutput(),
  });
  log.emit(ROOT, T.childDone + 1, {
    type: 'tool.end',
    logId: 'call-1',
    status: 'completed',
    result: { output: 'search done', summary: "Completed 'custom:search'" },
  });
  log.emit(ROOT, T.childDone + 2, {
    type: 'tool.end',
    logId: SCRIPT_STAGE,
    status: 'completed',
    result: { output: 'review done' },
  });
  log.emit(ROOT, T.rootDone, {
    type: 'run.end',
    outcome: 'completed',
    output: emptyRunEndOutput(),
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
// Views for the renderers
// ---------------------------------------------------------------------------

/**
 * The fan-out mid-flight, owned by this process: `review` running with its
 * `inspect` call open, `search` waiting on the bash approval, `lint` done,
 * the `bash` process run leading the order.
 */
export function fanOutView(): SessionView {
  return viewOf([...buildScenario().pending, local({ runsHere: ALL_RUNS })]);
}

/** `fanOutView` with no approval pending: nothing forces the tree open, so
 *  a collapsed parent shows its rollup. */
export function withoutApproval(): SessionView {
  return viewOf([
    ...buildScenario().pending.filter(
      (input) =>
        !(input._tag === 'event' && input.event.type === 'request.opened'),
    ),
    local({ runsHere: ALL_RUNS }),
  ]);
}

/** `fanOutView` with `search` run by nothing any more: an in-flight run
 *  no launch here holds reads as interrupted. */
export function withInterruptedChild(): SessionView {
  return viewOf([
    ...buildScenario().pending,
    local({ runsHere: ALL_RUNS.filter((id) => id !== CHILD) }),
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
        runId: GRANDCHILD,
        command: 'latexmk -pdf appendixB.tex',
      },
    },
    answeredBy: 'bash',
  });
  return viewOf([
    ...inputs,
    ...log.events.map(tail),
    local({ runsHere: ALL_RUNS }),
  ]);
}

/** `fanOutView` plus its script's agent request pending on the root. */
export function withProposal(): SessionView {
  return viewOf([
    ...buildScenario({ proposal: true }).pending,
    local({ runsHere: ALL_RUNS }),
  ]);
}
