import {
  abandonOwnedExecutionLease,
  acquireResumedExecutionLease,
  completeOwnedExecutionLease,
  finalizeExecution,
  registerExecution,
} from '@agent/storage';
import {
  captureOwnedExecutionLease,
  markOwnedExecutionLeaseUndurable,
  type OwnedExecutionLeaseScope,
} from '@agent/storage/executionLease';

import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
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
  | 'runtimeHost'
  | 'enforceCategory'
  | 'stopAfterCycle'
  | 'approvalPromptsUnavailable'
  | 'runtimeUnavailableTools'
  | 'session'
  | 'modelHandlerCompatibilityKey'
  | 'onRun'
  | 'onStreamResolved'
  | 'onIdle'
> {
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  /** Persist host-owned final artifacts while this run still owns its lease. */
  beforeLeaseRelease?: () => Promise<void>;
  /** Bind host callbacks that may run outside the agent's async context. */
  onExecutionLeaseAcquired?: (scope: OwnedExecutionLeaseScope) => void;
  registerExecution?: boolean;
  /** Recheck canonical admission atomically while acquiring a resumed lease. */
  canAcquireResumeLease?: () => boolean;
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

  const executionId =
    request.executionId ?? (generateExecutionId() as ExecutionId);
  const shouldRegister =
    registerExecutionOption ?? request.executionId === undefined;
  const runSession = executeAgentOptions.session ?? defaultSession();

  // Only the "fix LaTeX" VS Code actions opt in (preferHelperModel); the agent
  // then runs on the configured helper model. A direct main-view launch keeps the
  // model the user picked. Resolved before registerExecution so the stored record
  // and the run agree.
  const config = preferHelperModel
    ? await applyHelperModelPreference(request.config)
    : request.config;

  if (shouldRegister) {
    await registerExecution(
      executionId,
      config,
      config.agent,
      undefined,
      config.agentCategory,
    );
  } else {
    const lease = canAcquireResumeLease
      ? await acquireResumedExecutionLease(executionId, canAcquireResumeLease)
      : await acquireResumedExecutionLease(executionId);
    if (lease === 'cancelled') {
      throw new ResumeAdmissionCancelledError(executionId);
    }
  }

  const runWithOwnership = captureOwnedExecutionLease(executionId);
  onExecutionLeaseAcquired?.(runWithOwnership);
  return await runWithOwnership(async () => {
    let lifecycleStarted = false;
    let runResult: AgentFlowResult | undefined;
    let runFailure: { error: unknown } | undefined;
    let artifactsDurable = false;
    const callerOnRun = executeAgentOptions.onRun;
    try {
      try {
        const result = await executeAgent(config, executionId, {
          ...executeAgentOptions,
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
        if (shouldRegister && !lifecycleStarted) {
          try {
            const finalization = await finalizeExecution({
              executionId,
              terminalStatus: EXECUTION_STATUS.ERROR,
              flowRecord: 'delete',
            });
            if (finalization.status === 'failed') {
              markOwnedExecutionLeaseUndurable(executionId);
              runFailure = {
                error: new AggregateError(
                  [error, finalization.error],
                  `Execution ${executionId} failed before lifecycle startup and its error status could not be persisted`,
                ),
              };
            }
          } catch (finalizationError) {
            markOwnedExecutionLeaseUndurable(executionId);
            runFailure = {
              error: new AggregateError(
                [error, finalizationError],
                `Execution ${executionId} failed before lifecycle startup and its error status could not be persisted`,
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
      const artifactFailure =
        artifactFailures.length === 1
          ? artifactFailures[0]
          : new AggregateError(
              artifactFailures,
              `Execution ${executionId} has multiple final artifact failures`,
            );

      if (runFailure) {
        if (artifactFailures.length > 0) {
          throw new AggregateError(
            [runFailure.error, artifactFailure],
            `Execution ${executionId} failed and its final artifacts could not be persisted`,
          );
        }
        throw runFailure.error;
      }
      if (artifactFailures.length > 0) throw artifactFailure;
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
