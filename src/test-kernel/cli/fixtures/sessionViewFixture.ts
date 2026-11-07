/**
 * The TUI's one session state under test: a `SessionView` the production
 * fold builds from a few rows, seeded straight into the signal the Ink
 * components read (`sessionView()`), so a suite asserts what the surface
 * renders from the fold's own output.
 * The runtime bridge is bound over an empty level on the block's session
 * graph (`boundTestSessionView`); `seedView` writes the signal directly,
 * which is what a folded change would do.
 */
import { Effect, Layer, Schema, SubscriptionRef } from 'effect';
import {
  AgentConfigSchema,
  type RequestPayload,
  type RunId,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { bindSessionView, sessionView } from '@cli/chat/tui/state/sessionView';
import { emptySessionView } from '@shared/session/sessionView';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';
import { SessionGraph } from '@test/support/testKernel';
import { local, Log, tail, viewOf } from '@test/shared/session/fanOutScenario';

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

/** A run the fixture view holds: a started agent run mid-turn, a child when
 *  it names its parent, and held by this terminal unless `held` is false. */
interface FixtureRun {
  readonly id: RunId;
  readonly parentId?: RunId;
  readonly held?: boolean;
}

/** A request a run opened, as the view lists it. */
interface FixtureRequest {
  readonly runId: RunId;
  readonly requestId: string;
  readonly payload: RequestPayload;
}

/**
 * The view the fold states for `runs`, given parents first, and the requests
 * they opened: each run's start, activation, config and first turn, and its
 * requests, applied through the production updater, so every derived field
 * (order, rollups, approval, actions) is the fold's own.
 */
export function viewWith(
  runs: readonly FixtureRun[],
  { requests = [] }: { readonly requests?: readonly FixtureRequest[] } = {},
): SessionView {
  const log = new Log();
  for (const run of runs) {
    log.emit(run.id, 1, {
      type: 'run.start',
      identity: { kind: 'agent', agent: 'agent' },
      parent: run.parentId === undefined ? null : log.parent(run.parentId),
      provenance: null,
      takesFollowUps: true,
    });
    log.emit(run.id, 1, { type: 'run.activate' });
    log.emit(run.id, 1, {
      type: 'run.config',
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: 'agent',
        model: 'test-model',
        instruction: 'go',
      }),
    });
    log.emit(run.id, 1, {
      type: 'run.position',
      payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
    });
  }
  for (const request of requests) {
    log.emit(request.runId, 2, {
      type: 'request.opened',
      requestId: request.requestId,
      payload: request.payload,
    });
  }
  return viewOf(
    [
      ...log.events.map(tail),
      log.drained(),
      local({
        runsHere: runs.flatMap((run) => (run.held === false ? [] : [run.id])),
      }),
    ],
    makeSessionViewUpdater('test'),
  );
}
