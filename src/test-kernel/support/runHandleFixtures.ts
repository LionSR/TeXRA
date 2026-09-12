import { Effect } from 'effect';

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
    publish: () => {},
    approvals: createSessionApprovals({ setApprovalBypassState() {} }),
    releaseRootRunLease: () => Effect.void,
    finalizeRun: (input) =>
      Effect.succeed({ ok: true, outcome: input.outcome }),
  });
}
