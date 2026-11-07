/**
 * The TUI's one session state under test: a `SessionView` seeded straight
 * into the signal the Ink components read (`sessionView()`), so a suite
 * states the fold's output and asserts what the surface renders from it.
 * The runtime bridge is bound over an empty level on the block's session
 * graph (`boundTestSessionView`); `seedView` writes the signal directly,
 * which is what a folded change would do.
 */
import { Effect, Layer, SubscriptionRef } from 'effect';
import {
  blocksCaller,
  isInterrupted,
  rollupOf as viewRollupOf,
  type RunId,
  type RunView,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { compareByNewestCreationTime } from '@texra-ai/harness/transcript';
import { bindSessionView, sessionView } from '@cli/chat/tui/state/sessionView';
import { USER_FOLLOW_UP_SUPPORT } from '@shared/schemas';
import { emptySessionView } from '@shared/session/sessionView';
import { runActions } from '@shared/session/runActions';
import { SessionGraph } from '@test/support/testKernel';

/**
 * An empty view bound for the block's life, on a runtime over the block's
 * session graph: `layer(Layer.provideMerge(boundTestSessionView,
 * SessionGraph.hosted))`. The block's release unbinds it.
 */
export const boundTestSessionView = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* SessionGraph.runtime;
    const ref = yield* SubscriptionRef.make(emptySessionView('test'));
    const unbind = bindSessionView(runtime, {
      current: () => SubscriptionRef.getUnsafe(ref),
      changes: SubscriptionRef.changes(ref),
    });
    yield* Effect.addFinalizer(() => Effect.sync(unbind));
  }),
);

/** Replace the whole view the components read. */
export function seedView(view: SessionView): void {
  sessionView().set(view);
}

type RunViewOverrides = Partial<RunView> & Pick<RunView, 'id'>;

/** One stream as the fold would state it; every field explicit. A run
 *  with no outcome is held here unless the case says otherwise, and the
 *  actions follow the final fields through the fold's own rule. */
export function makeRunView(over: RunViewOverrides): RunView {
  const run = runViewFields(over);
  // A case may blank the identity to stand for metadata not yet folded; the
  // fold never states such a run, so it offers nothing.
  // cast: `RunView` types the identity as always present; a case's may not be.
  const identity = run.identity as RunView['identity'] | undefined;
  return { ...run, actions: identity ? runActions(run, false) : [] };
}

function runViewFields(over: RunViewOverrides): RunView {
  const { id } = over;
  const outcome = over.outcome ?? null;
  const common = {
    id,
    identity: { kind: 'agent' as const, agent: 'agent' },
    label: over.id,
    description: null,
    descriptionBy: null,
    model: null,
    modelLabel: null,
    command: null,
    inputFiles: [],
    agentScope: null,
    worktree: null,
    position: 'running' as const,
    outcome,
    holder: outcome === null ? ('here' as const) : ('none' as const),
    statusNotice: null,
    createdAt: 1,
    launchedAt: 1,
    turnStartedAt: null,
    runStartedAt: null,
    lastTimestamp: 1,
    turn: null,
    followUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    context: null,
    parentId: null,
    ancestors: [],
    childIds: [],
    rollup: { total: 0, running: 0, finished: 0 },
    approval: 'none' as const,
    actions: [],
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    treeUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    thinkingActive: false,
    compactingActive: false,
    latestLine: null,
    transcript: {
      rows: [],
      taskGroups: [],
      settledRows: 0,
    },
  };
  // cast: every field is stated above; a case's override may blank one.
  return {
    ...common,
    recipe: null,
    facts: {},
    ...over,
    id,
    title: over.title ?? (over.description || (over.label ?? over.id)),
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
    id,
    createdAt: byId.get(id)?.createdAt ?? 0,
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
  // A held run with a request that parks its caller is waiting on it, as the
  // fold's aggregates derive it. Fixture runs model runs this process holds;
  // one built interrupted (unheld) or with its own approval keeps it.
  for (const request of over.requests ?? []) {
    const run = byId.get(request.runId);
    if (
      !run ||
      run.approval !== 'none' ||
      isInterrupted(run) ||
      !blocksCaller(request.payload)
    )
      continue;
    byId.set(run.id, { ...run, approval: 'own' });
  }
  for (const stream of [...byId.values()]) {
    if (stream.childIds.length === 0) continue;
    byId.set(stream.id, {
      ...stream,
      rollup: viewRollupOf(stream.childIds.flatMap((id) => byId.get(id) ?? [])),
    });
  }
  return {
    ...emptySessionView('test'),
    ...over,
    runs: byId,
    order: runs.filter((s) => s.parentId === null).map((s) => s.id),
  };
}
