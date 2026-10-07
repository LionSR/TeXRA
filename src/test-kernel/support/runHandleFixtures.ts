import { Effect, type Fiber, SubscriptionRef } from 'effect';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { RunHandle, type RunFacts } from '@agent/runtime/RunHandle';
import { RunRegistry, type RunRegistryInit } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { emptySessionView } from '@shared/session/sessionView';
import type { RunId, RunIdentity } from '@shared/schemas';
import { testPinPlugins } from './testPluginServices';
import { testRuntime } from './testProcessRuntime';

/** A registry's launch door over the harness's process runtime, standing in
 *  for the session context the session layer forks runs from. */
export const testRunFork: RunRegistryInit['fork'] = (effect) =>
  testRuntime().runFork(effect);

/**
 * A live run handle for tests.
 *
 * The run struct is assembled here and typed as the canonical
 * {@link RunFacts}, so a schema change breaks every fixture in one place.
 */
export function testRunHandle(input: {
  runId: RunId;
  /** The parent edge; omitted (or null) for a root. */
  parent?: RunId | null;
  agent: string;
  /** Defaults to a native agent identity for `agent`. */
  identity?: RunIdentity;
  trace?: AgentTrace;
}): RunHandle {
  const run: RunFacts = {
    runId: input.runId,
    identity: input.identity ?? { kind: 'agent', agent: input.agent },
  };
  return new RunHandle(run, input.parent ?? null, input.trace);
}

/** A registry over an empty fold: no run has a view, which is what a
 *  fixture that never publishes a phase-moving row would see. */
export function testRunRegistry(): RunRegistry {
  // The registry reads its session's view (empty here), claims (no-ops)
  // and its own `run.detach` batches (dropped); nothing else.
  const session = {
    view: { run: () => undefined, ref: emptyView },
    log: {
      transact: () => Effect.succeed([]),
      hold: () => Effect.void,
    },
  } as unknown as SessionHandle;
  const registry: RunRegistry = new RunRegistry({
    session: () => session,
    fork: testRunFork,
    pinPlugins: testPinPlugins(() => registry),
  });
  // No run is ever persisted here: a run's end is accepted as asked.
  registry.end = (input) =>
    Effect.succeed({ ok: true, outcome: input.outcome });
  return registry;
}

/** The empty fold a {@link testRunRegistry} reads its grants from. */
const emptyView = Effect.runSync(
  SubscriptionRef.make(emptySessionView('test-run-registry')),
);

/**
 * A run whose generation is live on the run registry, the way a real launch
 * admits one: the fiber is the run's stop target, and a stop reaches the
 * run by interrupting it. `onInterrupt` fires from the fiber's own
 * unwinding, so it has observably landed once the stop's settlement (or an
 * await of the returned fiber) resolves.
 */
export function admitInterruptibleRun(
  registry: RunRegistry,
  runId: RunId,
  onInterrupt: () => void,
): Fiber.Fiber<void> {
  const interruptEffect = Effect.sync(onInterrupt);
  return Effect.runFork(
    registry
      .launchRun(
        runId,
        Effect.never.pipe(Effect.onInterrupt(() => interruptEffect)),
      )
      .pipe(Effect.ignore),
  );
}
