import { Effect } from 'effect';

// Local imports
import type { AgentTrace } from '@agent/trace';
import {
  RunHandle,
  type RunFacts,
} from '@agent/runtime/RunHandle';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
import { AgentCategory } from '@shared/schemas';
import type { RunId, RunIdentity, RunId } from '@shared/schemas';

/**
 * A live run handle for tests.
 *
 * The run struct is assembled here and typed as the canonical
 * {@link RunFacts}, so a schema change breaks every fixture in one place.
 */
export function testRunHandle(input: {
  runId: string;
  parentRunId: RunId;
  /** Defaults to `parentRunId`, i.e. a run that is its own parent. */
  childRunId?: RunId;
  agent: string;
  category?: AgentCategory;
  /** Defaults to a native agent identity for `agent`. */
  identity?: RunIdentity;
  trace?: AgentTrace;
}): RunHandle {
  const runId = input.childRunId ?? input.parentRunId;
  const run: RunFacts = {
    runId,
    runId: input.runId as RunId,
    identity: input.identity ?? { kind: 'agent', agent: input.agent },
    category: input.category ?? AgentCategory.ToolUse,
  };
  return new RunHandle(run, input.parentRunId, input.trace);
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
