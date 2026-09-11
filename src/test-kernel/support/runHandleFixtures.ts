import { Effect } from 'effect';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { RunHandle, type RunFacts } from '@agent/runtime/RunHandle';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
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

/** A registry with a status machine whose facts reach its `handleStatus`. */
export function testRunRegistry(): RunRegistry {
  // The machine's facts reach the registry built below; the closure runs
  // only once a transition is published, after the registry exists.
  const runStatus = new RunStatusMachine(
    (event) => registry.handleStatus(event.runId),
    () => {},
  );
  const registry = new RunRegistry({
    publish: () => {},
    runStatus,
    approvals: createSessionApprovals({ setApprovalBypassState() {} }),
    publishResult: () => {},
    releaseRootRunLease: () => Effect.void,
    finalizeRun: (input) =>
      Effect.succeed({ ok: true, outcome: input.outcome }),
  });
  return registry;
}
