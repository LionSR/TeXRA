import { Cause, Effect, Exit } from 'effect';

import { registerExecution, getExecutionRecords } from '@agent/storage';
import {
  clearTerminalExecutionState,
  acquireResumedExecutionOwnership,
  finalizeRun,
} from '@agent/storage/executionLifecycle';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import {
  aggregateError,
  generateExecutionId,
  linkAbortSignals,
} from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { AgentExecutionHandle } from './ExecutionHandle';
import { runInSession } from './RunContext';
import { getStreamTabId } from './streamTab';
import type { SessionHandle } from './SessionHandle';
import type { AgentFlowResult } from './AgentFlowResult';

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
  | 'modelHandlerCompatibilityKey'
  | 'copilotRouteOverride'
  | 'onRun'
  | 'onStreamResolved'
  | 'onIdle'
  | 'launchSignal'
  | 'openWorkflowOutput'
> {
  readonly session: SessionHandle;
  /**
   * Persist host-owned final state before the ordinary session drain. Return
   * true when the hook already drained artifacts and disposed of ownership.
   */
  beforeLeaseRelease?: () => Promise<boolean | void>;
  /** Fires once this run owns its execution lease. */
  onExecutionLeaseAcquired?: (executionId: ExecutionId) => void;
  /**
   * Opt-in set by the "fix LaTeX" VS Code actions (Fix-Compilation command, the
   * progress-view compile fixer): run the launched agent on the configured
   * helper model instead of the selected one. Off for a direct main-view launch,
   * the CLI, and orchestrator delegations, which all keep the chosen model.
   */
  preferHelperModel?: boolean;
}

export type RunAgentRequest =
  | {
      readonly kind: 'fresh';
      readonly config: AgentConfig;
      readonly executionId?: ExecutionId;
    }
  | {
      readonly kind: 'resume';
      readonly config: AgentConfig;
      readonly executionId: ExecutionId;
    };

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Validates-then-runs: assigns an executionId when a fresh request omits one,
 * registers fresh runs in the execution store, reuses a resumed run's record,
 * runs the agent, and — for a
 * workflow result — invokes `openWorkflowOutput` so the host can surface output.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent`, where the
 * caller owns executionId generation and `registerExecution`.
 */
export const runAgent = Effect.fn('runAgent')(function* (
  request: RunAgentRequest,
  options: RunAgentOptions,
): Effect.fn.Return<AgentFlowResult, Error> {
  const {
    beforeLeaseRelease,
    onExecutionLeaseAcquired,
    preferHelperModel,
    ...executeAgentOptions
  } = options;
  const executionId = request.executionId ?? generateExecutionId();
  const shouldRegister = request.kind === 'fresh';
  const runSession = executeAgentOptions.session;
  const launchAbortController = new AbortController();
  const detachLaunchAbortLink = linkAbortSignals(
    [executeAgentOptions.launchSignal],
    launchAbortController,
  );
  const launchSignal = launchAbortController.signal;
  const prior = shouldRegister
    ? null
    : yield* getExecutionRecords(runSession, executionId).readMeta();
  if (!shouldRegister && !prior?.streamId)
    return yield* Effect.fail(
      new Error(`Execution metadata not found for ${executionId}`),
    );
  const launchStreamId =
    prior?.streamId ?? getStreamTabId(request.config.agent, { executionId });
  const launchHandle = runSession.executions.getHandle(executionId)
    ? undefined
    : new AgentExecutionHandle(
        {
          streamId: launchStreamId,
          executionId,
          identity: { kind: 'agent', agent: request.config.agent },
          category: request.config.agentCategory,
        },
        launchStreamId,
      );
  const detachLaunchInterrupt = launchHandle?.attachInterruptHandler({
    interrupt: () => launchAbortController.abort(),
  });

  return yield* Effect.gen(function* () {
    if (launchHandle) runSession.executions.track(launchHandle);
    return yield* runSession.executions.launchExecution(
      executionId,
      Effect.gen(function* () {
        // Resolve the selected model before registering the execution.
        const config = preferHelperModel
          ? yield* Effect.tryPromise({
              try: async () =>
                runInSession(runSession, () =>
                  applyHelperModelPreference(request.config),
                ),
              catch: ensureError,
            })
          : request.config;
        const userFollowUpSupport =
          config.agentCategory === AgentCategory.ToolUse &&
          executeAgentOptions.stopAfterCycle !== true
            ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
            : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
        if (shouldRegister) {
          yield* registerExecution(
            runSession,
            executionId,
            config,
            config.agent,
            {
              streamId: launchStreamId,
              identity: { kind: 'agent', agent: config.agent },
              userFollowUpSupport,
            },
          );
        } else {
          yield* acquireResumedExecutionOwnership(
            runSession,
            executionId,
            launchStreamId,
          );
        }

        let lifecycleStarted = false;
        let previousTerminalOutcome: RunOutcome | undefined;
        let resumedStreamId: StreamTabId | undefined;
        const callerOnRun = executeAgentOptions.onRun;
        const execution = yield* Effect.exit(
          Effect.gen(function* () {
            onExecutionLeaseAcquired?.(executionId);
            if (!shouldRegister) {
              const cleared = yield* clearTerminalExecutionState(
                executionId,
                runSession,
              );
              resumedStreamId = cleared.streamId;
              previousTerminalOutcome = cleared.previousOutcome;
            }
            return yield* executeAgent(config, executionId, {
              ...executeAgentOptions,
              launchSignal,
              session: runSession,
              streamTabIdOverride: resumedStreamId,
              userFollowUpSupport,
              onRun: async (handle) => {
                lifecycleStarted = true;
                await callerOnRun?.(handle);
              },
            });
          }),
        );

        const failures: unknown[] = [];
        if (Exit.isFailure(execution)) {
          const error = Cause.squash(execution.cause);
          failures.push(error);
          const restoredOutcome = shouldRegister
            ? RUN_OUTCOME.FAILED
            : previousTerminalOutcome;
          if (!lifecycleStarted && restoredOutcome !== undefined) {
            const finalization = yield* Effect.exit(
              finalizeRun(runSession, {
                executionId,
                outcome: restoredOutcome,
                flowRecord: shouldRegister ? 'delete' : 'preserve',
              }),
            );
            if (Exit.isFailure(finalization))
              failures.push(Cause.squash(finalization.cause));
            else if (!finalization.value.ok)
              failures.push(finalization.value.error);
          }
        }

        const artifacts = yield* Effect.exit(
          Effect.tryPromise({
            try: async () =>
              runInSession(runSession, async () => beforeLeaseRelease?.()),
            catch: ensureError,
          }),
        );
        if (Exit.isFailure(artifacts))
          failures.push(Cause.squash(artifacts.cause));
        if (Exit.isFailure(artifacts) || artifacts.value !== true) {
          const release = yield* Effect.exit(
            runSession.releaseExecutionLease(executionId),
          );
          if (Exit.isFailure(release))
            failures.push(Cause.squash(release.cause));
        }
        if (failures.length > 0) {
          return yield* Effect.fail(
            ensureError(
              aggregateError(
                failures,
                `Execution ${executionId} failed or its final artifacts could not be persisted`,
              ),
            ),
          );
        }
        return yield* execution;
      }).pipe(Effect.uninterruptible),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        detachLaunchAbortLink();
        detachLaunchInterrupt?.();
        if (
          launchHandle &&
          runSession.executions.getHandle(executionId) === launchHandle
        ) {
          runSession.executions.untrack(executionId);
        }
      }),
    ),
  );
});
