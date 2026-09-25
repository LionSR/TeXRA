import { Effect, type Fiber } from 'effect';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { RunHandle, type RunFacts } from '@agent/runtime/RunHandle';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { AgentCategory } from '@shared/schemas';
import type { RunId, RunIdentity } from '@shared/schemas';

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
  category?: AgentCategory;
  /** Defaults to a native agent identity for `agent`. */
  identity?: RunIdentity;
  trace?: AgentTrace;
}): RunHandle {
  const run: RunFacts = {
    runId: input.runId,
    identity: input.identity ?? { kind: 'agent', agent: input.agent },
    category: input.category ?? AgentCategory.ToolUse,
  };
  return new RunHandle(run, input.parent ?? null, input.trace);
}

/** A registry over an empty fold: no run has a view, which is what a
 *  fixture that never publishes a phase-moving row would see. */
export function testRunRegistry(): RunRegistry {
  return new RunRegistry({
    runView: () => undefined,
    commit: () => Effect.void,
    approvals: createSessionApprovals(),
    finalizeRun: (input) =>
      Effect.succeed({ ok: true, outcome: input.outcome }),
    acquireRunClaim: () => Effect.succeed(Effect.void),
  });
}

/**
 * A run whose generation is live on the roster, the way a real launch
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
