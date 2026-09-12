/**
 * The TUI's one session state under test: a `SessionView` seeded straight
 * into the signal the Ink components read (`sessionView()`), so a suite
 * states the fold's output and asserts what the surface renders from it.
 * The runtime bridge is bound once over an empty level; `seedView` writes
 * the signal directly, which is what a folded change would do.
 */
import '@test/support/sessionGraphTestSetup';
import { SubscriptionRef } from 'effect';
import { bindSessionView, sessionView } from '@cli/chat/tui/state/sessionView';
import { effectRuntime } from '@platform/processRuntime';
import {
  AgentCategory,
  isPlainAgentIdentity,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
} from '@shared/schemas';
import {
  emptySessionView,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import { compareByNewestCreationTime } from '@shared/runs/runOrdering';
import {
  isInFlightPhase,
  isTerminalOutcomePhase,
} from '@shared/runs/runStatus';
import { runStatusCopy } from '@shared/runs/runStatusDisplay';

let unbind: (() => void) | undefined;

/** Bind an empty view for the file; idempotent. */
export async function bindTestSessionView(): Promise<void> {
  if (unbind) return;
  const ref = await effectRuntime().runPromise(
    SubscriptionRef.make(emptySessionView('test')),
  );
  unbind = bindSessionView(ref);
}

/** Replace the whole view the components read. */
export function seedView(view: SessionView): void {
  sessionView().set(view);
}

type RunViewOverrides = Partial<Omit<RunView, 'category'>> & {
  readonly id: string;
  readonly category?: RunView['category'];
};

/** One stream as the fold would state it; every field explicit. The label,
 *  tone, and group follow the status the way the fold derives them. */
export function makeRunView(over: RunViewOverrides): RunView {
  const id = over.id as RunId;
  const status = over.status ?? RUN_PHASE.RUNNING;
  const copy = runStatusCopy(status, {
    substate: over.substate ?? undefined,
  });
  const common = {
    id,
    identity: { kind: 'agent' as const, agent: 'agent' },
    isRemote: false,
    ownerId: null,
    label: over.id,
    description: null,
    model: null,
    modelLabel: null,
    command: null,
    inputFiles: [],
    worktree: null,
    status,
    substate: null,
    durableOutcome: null,
    statusDetail: null,
    statusLabel: copy.statusLabel,
    tone: copy.tone,
    createdAt: 1,
    launchedAt: 1,
    runStartedAt: null,
    lastTimestamp: null,
    conversationProgress: { toolCallCount: 0 },
    flow: null,
    followUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    resumeEligible:
      (over.category ?? AgentCategory.ToolUse) === AgentCategory.ToolUse &&
      isPlainAgentIdentity(over.identity ?? { kind: 'agent', agent: 'agent' }),
    context: null,
    parentId: null,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    readOnly: false,
    forceExpanded: false,
    group: isInFlightPhase(status) ? ('running' as const) : ('recent' as const),
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    thinkingActive: false,
    compactingActive: false,
    latestLine: null,
    transcript: {
      rows: [],
      taskGroups: [],
      settledRows: 0,
      run: null,
    },
  };
  const { category, ...rest } = over;
  if (category === AgentCategory.Workflow) {
    return {
      ...common,
      category: AgentCategory.Workflow,
      files: {},
      missingOutputs: {},
      compileFailures: {},
      ...rest,
      id,
    } as RunView;
  }
  return {
    ...common,
    category: AgentCategory.ToolUse,
    todos: [],
    plan: null,
    goal: { active: false },
    outputs: {},
    missingOutputs: {},
    compileFailures: {},
    ...rest,
    id,
  } as RunView;
}

/**
 * A view over the given runs: `order` lists the roots in the order
 * given, each parent's `childIds` are completed from the children's
 * `parentId` when the caller did not state them (in the fold's
 * `runOrdering`: newest `createdAt` first, ties by id), and every
 * stream's `rollup` counts its descendants the way the fold does.
 */
export function viewWith(
  runs: readonly RunView[],
  over: Partial<Omit<SessionView, 'runs' | 'order'>> = {},
): SessionView {
  const byId = new Map<RunId, RunView>();
  for (const stream of runs) byId.set(stream.id, stream);
  const completed = new Set<RunId>();
  for (const stream of runs) {
    if (stream.parentId === null) continue;
    const parent = byId.get(stream.parentId);
    if (parent && !parent.childIds.includes(stream.id)) {
      completed.add(parent.id);
      byId.set(parent.id, {
        ...parent,
        childIds: [...parent.childIds, stream.id],
      });
    }
  }
  const orderingKey = (id: RunId) => ({
    name: id,
    creationTimestamp: byId.get(id)?.createdAt ?? 0,
  });
  for (const parentId of completed) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    byId.set(parentId, {
      ...parent,
      childIds: [...parent.childIds].sort((a, b) =>
        compareByNewestCreationTime(orderingKey(a), orderingKey(b)),
      ),
    });
  }
  const rollupOf = (
    stream: RunView,
  ): { total: number; running: number; finished: number } => {
    const rollup = { total: 0, running: 0, finished: 0 };
    for (const childId of stream.childIds) {
      const child = byId.get(childId);
      if (!child) continue;
      const nested = rollupOf(child);
      rollup.total += 1 + nested.total;
      rollup.running +=
        (isInFlightPhase(child.status) ? 1 : 0) + nested.running;
      rollup.finished +=
        (isTerminalOutcomePhase(child.status) ? 1 : 0) + nested.finished;
    }
    return rollup;
  };
  for (const stream of [...byId.values()]) {
    if (stream.childIds.length === 0) continue;
    byId.set(stream.id, { ...stream, rollup: rollupOf(stream) });
  }
  return {
    ...emptySessionView('test'),
    ...over,
    runs: byId,
    order: runs.filter((s) => s.parentId === null).map((s) => s.id),
  };
}
