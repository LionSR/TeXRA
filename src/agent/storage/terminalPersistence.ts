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
import {
  finalizeExecution,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
} from './executionLifecycle';

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
 * Shared `finalizeExecution` tail used by both terminal-persistence sites:
 * `AgentRunLifecycle.finalizeRunTerminal`'s finalize arm and
 * `ExecutionRegistry.finishWaitingTermination`'s waiting-stop arm. Warns on a
 * `'failed'` result and hands back whether the terminal status reached disk.
 * Never throws: `finalizeExecution` converts every persistence failure into
 * a `'failed'` result.
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
  const finalization = await finalizeExecution({
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
