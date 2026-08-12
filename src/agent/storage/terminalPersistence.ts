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

export type FinalizeExecutionWithLeaseResult =
  | { readonly finalization: FinalizeExecutionResult }
  | { readonly thrownError: unknown };

/**
 * Calls `finalizeExecution` and marks the owned lease undurable whenever the
 * terminal status did not reach disk: a `'failed'` result (which carries the
 * underlying error) or a thrown error. This is the shared step both
 * `persistTerminalExecution` and `runAgent`'s pre-lifecycle finalize arm used
 * to duplicate inline, so the mark-undurable decision lives in one place.
 * Callers own their failure reporting: `persistTerminalExecution` warns,
 * `runAgent` folds the error into its AggregateError. Never throws.
 */
export async function finalizeExecutionWithLease(params: {
  executionId: ExecutionId;
  outcome: RunOutcome;
  flowRecord: FinalizeExecutionInput['flowRecord'];
}): Promise<FinalizeExecutionWithLeaseResult> {
  try {
    const finalization = await finalizeExecution(params);
    if (finalization.status === 'failed') {
      markOwnedExecutionLeaseUndurable(params.executionId);
    }
    return { finalization };
  } catch (error) {
    markOwnedExecutionLeaseUndurable(params.executionId);
    return { thrownError: error };
  }
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
  readonly rejectedMessage: string;
}

export interface PersistTerminalExecutionResult {
  readonly outcomePersisted: boolean;
}

/**
 * Shared `finalizeExecution` try/catch used by both terminal-persistence
 * sites: `AgentRunLifecycle.finalizeRunTerminal`'s finalize arm and
 * `ExecutionRegistry.finishWaitingTermination`'s waiting-stop arm. Both sides
 * previously duplicated this exactly: call `finalizeExecution`, mark the
 * owned lease undurable and warn on either a `'failed'` result or a rejected
 * promise, and hand back whether the terminal status reached disk. The
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
    rejectedMessage,
  } = params;
  const agentData =
    agentName !== undefined ? { agentIdentifier: agentName } : {};
  const result = await finalizeExecutionWithLease({
    executionId,
    outcome,
    flowRecord,
  });
  if ('thrownError' in result) {
    callerLogger.warn(rejectedMessage, {
      data: {
        ...agentData,
        executionId,
        error: result.thrownError,
      },
    });
    return { outcomePersisted: false };
  }
  if (result.finalization.status === 'failed') {
    callerLogger.warn(failedMessage, {
      data: {
        ...agentData,
        executionId,
        stage: result.finalization.stage,
        outcomePersisted: result.finalization.outcomePersisted,
        error: result.finalization.error,
      },
    });
  }
  return { outcomePersisted: result.finalization.outcomePersisted };
}
