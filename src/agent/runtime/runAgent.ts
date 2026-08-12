import { registerExecution } from '@agent/storage';
import { clearTerminalExecutionState } from '@agent/storage/executionLifecycle';
import {
  abandonOwnedExecutionLease,
  acquireResumedExecutionLease,
  captureOwnedExecutionLease,
  completeOwnedExecutionLease,
  type OwnedExecutionLeaseScope,
} from '@agent/storage/executionLease';
import { finalizeExecutionWithLease } from '@agent/storage/terminalPersistence';

import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import {
  AgentCategory,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { generateExecutionId } from '@utils/core';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { getStreamTabId } from './streamTab';
import { defaultSession } from './SessionHandle';
import { flushOwnedExecutionArtifacts } from './executionOwnership';
import { ResumeAdmissionCancelledError } from './resumeAdmission';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';

/**
 * Options for `runAgent`. Fields shared with the lower-level `executeAgent`
 * are picked from `ExecuteAgentOptions` (and forwarded as-is) so the two
 * option types can't drift apart silently; see that interface for their docs.
 */
export interface RunAgentOptions extends Pick<
  ExecuteAgentOptions,
  | 'suppressErrorNotification'
  | 'enforceCategory'
  | 'stopAfterCycle'
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
  | 'tools'
  | 'session'
  | 'modelHandlerCompatibilityKey'
  | 'copilotRouteOverride'
  | 'onRun'
  | 'onStreamResolved'
  | 'onIdle'
> {
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  /** Persist host-owned final artifacts while this run still owns its lease. */
  beforeLeaseRelease?: () => Promise<void>;
  /** Bind host callbacks that may run outside the agent's async context. */
  onExecutionLeaseAcquired?: (
    scope: OwnedExecutionLeaseScope,
    executionId: ExecutionId,
  ) => void;
  registerExecution?: boolean;
  /** Recheck canonical admission atomically while acquiring a resumed lease. */
  canAcquireResumeLease?: () => boolean | Promise<boolean>;
  /**
   * Opt-in set by the "fix LaTeX" VS Code actions (Fix-Compilation command, the
   * progress-view compile fixer): run the launched agent on the configured
   * helper model instead of the selected one. Off for a direct main-view launch,
   * the CLI, and orchestrator delegations, which all keep the chosen model.
   */
  preferHelperModel?: boolean;
}

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Validates-then-runs: assigns an executionId when the request omits one (a
 * fresh run), registers fresh runs in the execution store (resume reuses the
 * record; override via `registerExecution`), runs the agent, and — for a
 * workflow result — invokes `openWorkflowOutput` so the host can surface output.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent`, where the
 * caller owns executionId generation and `registerExecution`.
 */
export async function runAgent(
  request: ValidatedExecutionRequest,
  options: RunAgentOptions,
): Promise<AgentFlowResult> {
  // Split the `runAgent`-only options off; the rest (`executeAgentOptions`) is
  // exactly the `Pick<ExecuteAgentOptions, …>` that `RunAgentOptions` extends, so
  // it forwards verbatim and a newly-picked option needs no change here.
  const {
    openWorkflowOutput,
    beforeLeaseRelease,
    onExecutionLeaseAcquired,
    registerExecution: registerExecutionOption,
    canAcquireResumeLease,
    preferHelperModel,
    ...executeAgentOptions
  } = options;

  const executionId = request.executionId ?? generateExecutionId();
  const shouldRegister =
    registerExecutionOption ?? request.executionId === undefined;
  const runSession = executeAgentOptions.session ?? defaultSession();

  // Resolved before registerExecution so the stored record and the run agree
  // on the model.
  const config = preferHelperModel
    ? await applyHelperModelPreference(request.config)
    : request.config;

  const userFollowUpSupport =
    config.agentCategory === AgentCategory.ToolUse &&
    executeAgentOptions.stopAfterCycle !== true
      ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
      : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;

  if (shouldRegister) {
    await registerExecution(executionId, config, config.agent, {
      streamId: getStreamTabId(config.agent, { executionId }),
      identity: { kind: 'agent', agent: config.agent },
      userFollowUpSupport,
    });
  } else {
    const lease = await acquireResumedExecutionLease(
      executionId,
      canAcquireResumeLease,
    );
    if (lease === 'cancelled') {
      throw new ResumeAdmissionCancelledError(executionId);
    }
  }

  const runWithOwnership = captureOwnedExecutionLease(executionId);
  onExecutionLeaseAcquired?.(runWithOwnership, executionId);
  return await runWithOwnership(async () => {
    let lifecycleStarted = false;
    let runResult: AgentFlowResult | undefined;
    let runFailure: { error: unknown } | undefined;
    let artifactsDurable = false;
    let previousTerminalOutcome: RunOutcome | undefined;
    let resumedStreamId: StreamTabId | undefined;
    const callerOnRun = executeAgentOptions.onRun;
    try {
      try {
        // A resumed execution is no longer described by the terminal facts its
        // previous run persisted; drop them before this run writes anything a
        // reader would project them onto.
        if (!shouldRegister) {
          const cleared = await clearTerminalExecutionState(executionId);
          resumedStreamId = cleared.streamId;
          previousTerminalOutcome = cleared.previousOutcome;
        }
        const result = await executeAgent(config, executionId, {
          ...executeAgentOptions,
          streamTabIdOverride: resumedStreamId,
          userFollowUpSupport,
          onRun: async (handle) => {
            lifecycleStarted = true;
            await callerOnRun?.(handle);
          },
        });
        if (result.category === 'workflow') {
          await openWorkflowOutput?.(result);
        }
        runResult = result;
      } catch (error) {
        runFailure = { error };
        const restoredOutcome = shouldRegister
          ? RUN_OUTCOME.FAILED
          : previousTerminalOutcome;
        if (!lifecycleStarted && restoredOutcome !== undefined) {
          // finalizeExecutionWithLease already marks the owned lease undurable
          // when the terminal status did not reach disk; this site only needs
          // to fold the persistence error into the run failure.
          const finalization = await finalizeExecutionWithLease({
            executionId,
            outcome: restoredOutcome,
            flowRecord: shouldRegister ? 'delete' : 'preserve',
          });
          let finalizationError: unknown;
          if ('thrownError' in finalization) {
            finalizationError = finalization.thrownError;
          } else if (finalization.finalization.status === 'failed') {
            finalizationError = finalization.finalization.error;
          }
          if (finalizationError !== undefined) {
            runFailure = {
              error: new AggregateError(
                [error, finalizationError],
                `Execution ${executionId} failed before lifecycle startup and its terminal status could not be persisted`,
              ),
            };
          }
        }
      }

      const artifactFailures: unknown[] = [];
      try {
        await beforeLeaseRelease?.();
      } catch (error) {
        artifactFailures.push(error);
      }
      try {
        await flushOwnedExecutionArtifacts(runSession, executionId);
      } catch (error) {
        artifactFailures.push(error);
      }
      artifactsDurable = artifactFailures.length === 0;

      if (artifactFailures.length > 0) {
        const artifactFailure =
          artifactFailures.length === 1
            ? artifactFailures[0]
            : new AggregateError(
                artifactFailures,
                `Execution ${executionId} has multiple final artifact failures`,
              );
        if (runFailure) {
          throw new AggregateError(
            [runFailure.error, artifactFailure],
            `Execution ${executionId} failed and its final artifacts could not be persisted`,
          );
        }
        throw artifactFailure;
      }
      if (runFailure) throw runFailure.error;
      if (!runResult) {
        throw new Error(`Execution ${executionId} finished without a result.`);
      }
      return runResult;
    } finally {
      if (artifactsDurable) {
        await completeOwnedExecutionLease(executionId);
      } else {
        abandonOwnedExecutionLease(executionId);
      }
    }
  });
}
