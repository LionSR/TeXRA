/**
 * Shared terminal-persistence tail for the two run-finalization arms.
 *
 * Lives in its own module rather than beside either caller: `AgentRunLifecycle`
 * already imports `ExecutionRegistry`, so hosting this value here keeps the
 * registry from importing back into the lifecycle module and closing the graph.
 */

import { finalizeExecution, type FinalizeExecutionInput } from '@agent/storage';
import type { AgentTrace } from '@agent/trace';
import { markOwnedExecutionLeaseUndurable } from '@agent/storage/executionLease';
import type { ExecutionId, RunOutcome } from '@shared/schemas';
import { projectRunOutcome } from '@shared/streams/streamStatus';

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
  readonly terminalStatusPersisted: boolean;
}

/**
 * Shared `finalizeExecution` try/catch used by both terminal-persistence
 * sites: `AgentRunLifecycle.finalizeRunTerminal`'s finalize arm and
 * `ExecutionRegistry.finishWaitingTermination`'s waiting-stop arm. Both sides
 * previously duplicated this exactly: call `finalizeExecution`, mark the
 * owned lease undurable and warn on either a `'failed'` result or a rejected
 * promise, and hand back whether the terminal status reached disk. The
 * caller keeps everything this helper does not own: the registry keeps its
 * `synchronizeAgentResultOutcome` follow-up and root-lease release in its own
 * `finally`; this function never throws, so a caller-side `catch` is
 * unnecessary and would be dead code.
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
  try {
    const finalization = await finalizeExecution({
      executionId,
      terminalStatus: projectRunOutcome(outcome).executionStatus,
      flowRecord,
    });
    if (finalization.status === 'failed') {
      markOwnedExecutionLeaseUndurable(executionId);
      callerLogger.warn(failedMessage, {
        data: {
          ...agentData,
          executionId,
          stage: finalization.stage,
          terminalStatusPersisted: finalization.terminalStatusPersisted,
          error: finalization.error,
        },
      });
    }
    return { terminalStatusPersisted: finalization.terminalStatusPersisted };
  } catch (error) {
    markOwnedExecutionLeaseUndurable(executionId);
    callerLogger.warn(rejectedMessage, {
      data: {
        ...agentData,
        executionId,
        error,
      },
    });
    return { terminalStatusPersisted: false };
  }
}
