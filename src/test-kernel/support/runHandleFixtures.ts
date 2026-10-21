import { Effect, Fiber, SubscriptionRef } from 'effect';

// Local imports
import { RunHandle, type RunFacts } from '@agent/runtime/RunHandle';
import {
  registryOf,
  RunRegistry,
  type RunPrograms,
  type RunRegistryInit,
  type AgentRunServices,
} from '@agent/runtime/runRegistry';
import type { RunsShape } from '@agent/runtime/runs';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { emptySessionView } from '@shared/session/sessionView';
import type { RunId, RunIdentity } from '@shared/schemas';
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
}): RunHandle {
  const run: RunFacts = {
    runId: input.runId,
    identity: input.identity ?? { kind: 'agent', agent: input.agent },
  };
  return new RunHandle(run, input.parent ?? null);
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
  return new RunRegistry({
    session: () => session,
    fork: testRunFork,
    programs: testRunPrograms,
    wake: () => {},
  });
}

/** The run programs a test registry runs: the production ones, each read
 *  per call so a suite's own mock of its module is the program it reaches. */
export const testRunPrograms: RunPrograms = {
  root: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/runtime/rootLaunch')),
      (module) => module.rootRun(...args),
    ),
  executeAgent: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/runtime/executeAgent')),
      (module) => module.executeAgent(...args),
    ),
  resumeTurn: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/runtime/executeAgent')),
      (module) => module.resumeToolUseFromResumeData(...args),
    ),
  resume: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/runtime/resumeRun')),
      (module) => module.resumeRun(...args),
    ),
};

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
  runs: RunsShape,
  runId: RunId,
  onInterrupt: () => void,
): Fiber.Fiber<void> {
  const interruptEffect = Effect.sync(onInterrupt);
  // Awaited as a root launch awaits: interrupting this fiber stops the run.
  return Effect.runFork(
    startAwaited(
      runs,
      runId,
      Effect.never.pipe(Effect.onInterrupt(() => interruptEffect)),
    ).pipe(Effect.ignore),
  );
}

/** A run admitted at `runs`' door and awaited, as a root launch awaits its
 *  program: the caller's interruption stops it. */
export function startAwaited<A, E, R extends AgentRunServices>(
  runs: RunsShape,
  runId: RunId,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error> {
  return Effect.flatMap(
    registryOf(runs).start(runId, program, (run) => run),
    (fiber) =>
      Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
  );
}
