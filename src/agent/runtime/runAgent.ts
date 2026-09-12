import { Cause, Effect, Exit } from 'effect';

import { registerRun, getRunRecords } from '@agent/storage';
import {
  acquireResumedRunOwnership,
  finalizeRun,
} from '@agent/storage/runLifecycle';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import {
  AgentCategory,
  RUN_OUTCOME,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { aggregateError, generateRunId, linkAbortSignals } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { RunHandle } from './RunHandle';
import { runInSession } from './RunContext';
import type { SessionHandle } from './SessionHandle';
import type { AgentFlowResult } from './AgentFlowResult';
import type { AgentRunServices } from './toolInjection';

/**
 * Options for `runAgent`. Fields shared with the lower-level `executeAgent`
 * are picked from `ExecuteAgentOptions` (and forwarded as-is) so the two
 * option types can't drift apart silently; see that interface for their docs.
 */
export interface RunAgentOptions extends Pick<
  ExecuteAgentOptions,
  | 'stopAfterCycle'
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
  | 'tools'
  | 'modelCompatibilityKey'
  | 'ownApiKeyFallback'
  | 'onRun'
  | 'onRunResolved'
  | 'onIdle'
  | 'launchSignal'
  | 'openWorkflowOutput'
> {
  readonly session: SessionHandle;
  /** Reject an explicitly supplied category that differs from the resolved definition. */
  readonly enforceCategory?: boolean;
  /**
   * The caller owns presentation for failures before registration; after
   * that the run's `result` event presents.
   */
  suppressErrorNotification?: boolean;
  /**
   * Persist host-owned final state before the ordinary session drain. Return
   * true when the hook already drained artifacts and disposed of ownership.
   */
  beforeLeaseRelease?: () => Promise<boolean | void>;
  /** Fires once this run owns its run lease. */
  onRunLeaseAcquired?: (runId: RunId) => void;
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
      readonly runId?: RunId;
    }
  | {
      readonly kind: 'resume';
      readonly config: AgentConfig;
      readonly runId: RunId;
    };

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Validates-then-runs: assigns an runId when a fresh request omits one,
 * registers fresh runs in the run store, reuses a resumed run's record,
 * runs the agent, and — for a
 * workflow result — invokes `openWorkflowOutput` so the host can surface output.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent`, where the
 * caller owns runId generation and `registerRun`.
 */
export const runAgent = Effect.fn('runAgent')(function* (
  request: RunAgentRequest,
  options: RunAgentOptions,
): Effect.fn.Return<AgentFlowResult, Error, AgentRunServices> {
  const {
    beforeLeaseRelease,
    onRunLeaseAcquired,
    preferHelperModel,
    suppressErrorNotification,
    ...executeAgentOptions
  } = options;
  const runId = request.runId ?? generateRunId();
  const shouldRegister = request.kind === 'fresh';
  const runSession = executeAgentOptions.session;
  // A resumed run's prior terminal fact: what a launch that fails before its
  // lifecycle starts restores, so the run does not read as still running.
  const priorEnd = shouldRegister
    ? null
    : yield* getRunRecords(runSession, runId).readRunEnd();
  if (!shouldRegister && !(yield* getRunRecords(runSession, runId).exists()))
    return yield* Effect.fail(new Error(`Run not found: ${runId}`));
  const launchAbortController = new AbortController();
  const detachLaunchAbortLink = linkAbortSignals(
    [executeAgentOptions.launchSignal],
    launchAbortController,
  );
  const launchSignal = launchAbortController.signal;
  const launchHandle = runSession.runs.getHandle(runId)
    ? undefined
    : new RunHandle(
        {
          runId,
          identity: { kind: 'agent', agent: request.config.agent },
          category: request.config.agentCategory,
        },
        null,
      );
  const detachLaunchInterrupt = launchHandle?.attachInterruptHandler({
    interrupt: () => launchAbortController.abort(),
  });

  return yield* Effect.gen(function* () {
    if (launchHandle) runSession.runs.track(launchHandle);
    return yield* runSession.runs.launchRun(
      runId,
      Effect.gen(function* () {
        // Resolve the selected model before registering the run. The helper
        // model swap reads the enabled-model list and the provider keys, so
        // both process stores come from this run's context.
        const modelStores = {
          globalState: yield* AppState,
          secrets: yield* Secrets,
        };
        const requestedConfig = preferHelperModel
          ? yield* Effect.tryPromise({
              try: async () =>
                runInSession(runSession, () =>
                  applyHelperModelPreference(request.config, modelStores),
                ),
              catch: ensureError,
            })
          : request.config;
        const definition = yield* prepareAgentDefinition({
          config: requestedConfig,
          session: runSession,
          enforceCategory: request.kind === 'resume' || options.enforceCategory,
          signal: launchSignal,
          suppressErrorNotification,
        });
        const { config } = definition;
        const userFollowUpSupport =
          config.agentCategory === AgentCategory.ToolUse &&
          executeAgentOptions.stopAfterCycle !== true
            ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
            : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
        if (shouldRegister) {
          yield* registerRun(runSession, runId, config, config.agent, {
            identity: { kind: 'agent', agent: config.agent },
            userFollowUpSupport,
          });
        } else {
          yield* acquireResumedRunOwnership(runSession, runId);
        }

        let lifecycleStarted = false;
        const callerOnRun = executeAgentOptions.onRun;
        const run = yield* Effect.exit(
          Effect.gen(function* () {
            onRunLeaseAcquired?.(runId);
            return yield* executeAgent(definition, runId, {
              ...executeAgentOptions,
              launchSignal,
              session: runSession,
              resumed: !shouldRegister,
              onRun: async (handle) => {
                lifecycleStarted = true;
                await callerOnRun?.(handle);
              },
            });
          }),
        );

        const failures: unknown[] = [];
        if (Exit.isFailure(run)) {
          const error = Cause.squash(run.cause);
          failures.push(error);
          const restoredOutcome = shouldRegister
            ? RUN_OUTCOME.FAILED
            : priorEnd?.outcome;
          if (!lifecycleStarted && restoredOutcome !== undefined) {
            const finalization = yield* Effect.exit(
              finalizeRun(runSession, {
                runId,
                outcome: restoredOutcome,
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
          const release = yield* Effect.exit(runSession.releaseRunLease(runId));
          if (Exit.isFailure(release))
            failures.push(Cause.squash(release.cause));
        }
        if (failures.length > 0) {
          return yield* Effect.fail(
            ensureError(
              aggregateError(
                failures,
                `Run ${runId} failed or its final artifacts could not be persisted`,
              ),
            ),
          );
        }
        return yield* run;
      }).pipe(Effect.uninterruptible),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        detachLaunchAbortLink();
        detachLaunchInterrupt?.();
        if (launchHandle && runSession.runs.getHandle(runId) === launchHandle) {
          runSession.runs.untrack(runId);
        }
      }),
    ),
  );
});
