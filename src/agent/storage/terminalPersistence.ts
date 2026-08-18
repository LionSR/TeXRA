/**
 * Shared terminal-persistence tail for the two run-finalization arms.
 *
 * Lives at storage level rather than beside either caller: `AgentRunLifecycle`
 * and `ExecutionRegistry` already import from `@agent/storage`, so hosting this
 * value here keeps the registry from importing back into the lifecycle module
 * and closing the graph.
 */

import type { AgentTrace } from '@agent/trace';
import type { ExecutionId, RunOutcome } from '@shared/schemas';
import { markOwnedExecutionLeaseUndurable } from './executionLease';
import {
  finalizeExecution,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
} from './executionLifecycle';

/**
 * Calls `finalizeExecution` and marks the owned lease undurable whenever the
 * terminal status did not reach disk — a `'failed'` result, which carries the
 * underlying error. This is the shared step both `persistTerminalExecution`
 * and `runAgent`'s pre-lifecycle finalize arm used to duplicate inline, so
 * the mark-undurable decision lives in one place. Callers own their failure
 * reporting: `persistTerminalExecution` warns, `runAgent` folds the error
 * into its AggregateError. Never throws: `finalizeExecution` converts every
 * persistence failure into a `'failed'` result.
 */
export async function finalizeExecutionWithLease(params: {
  executionId: ExecutionId;
  outcome: RunOutcome;
  flowRecord: FinalizeExecutionInput['flowRecord'];
}): Promise<FinalizeExecutionResult> {
  const finalization = await finalizeExecution(params);
  if (finalization.status === 'failed') {
    markOwnedExecutionLeaseUndurable(params.executionId);
  }
  return finalization;
}

export interface PersistTerminalExecutionParams {
  readonly executionId: ExecutionId;
  /** Included in warn-log `data` only when the caller has one to report. */
  readonly agentName?: string;
  readonly outcome: RunOutcome;
  readonly flowRecord: FinalizeExecutionInput['flowRecord'];
  /** Caller's own channel trace, so warn logs keep their originating channel. */
  readonly logger: AgentTrace;
  /** Message text differs per call site and is asserted verbatim by existing tests. */
  readonly failedMessage: string;
}

export interface PersistTerminalExecutionResult {
  readonly outcomePersisted: boolean;
}

/**
 * Shared `finalizeExecution` tail used by both terminal-persistence
 * sites: `AgentRunLifecycle.finalizeRunTerminal`'s finalize arm and
 * `ExecutionRegistry.finishWaitingTermination`'s waiting-stop arm. Both sides
 * previously duplicated this exactly: call `finalizeExecution`, mark the
 * owned lease undurable and warn on a `'failed'` result, and hand back
 * whether the terminal status reached disk. The
 * caller keeps everything this helper does not own: the registry keeps its
 * root-lease release in its own `finally`; this function never throws, so a
 * caller-side `catch` is unnecessary and would be dead code.
 */
export async function persistTerminalExecution(
  params: PersistTerminalExecutionParams,
): Promise<PersistTerminalExecutionResult> {
  const {
    executionId,
    agentName,
    outcome,
    flowRecord,
    logger: callerLogger,
    failedMessage,
  } = params;
  const finalization = await finalizeExecutionWithLease({
    executionId,
    outcome,
    flowRecord,
  });
  if (finalization.status === 'failed') {
    callerLogger.warn(failedMessage, {
      data: {
        ...(agentName ? { agentIdentifier: agentName } : {}),
        executionId,
        stage: finalization.stage,
        outcomePersisted: finalization.outcomePersisted,
        error: finalization.error,
      },
    });
  }
  return { outcomePersisted: finalization.outcomePersisted };
}
