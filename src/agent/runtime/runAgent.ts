import { Cause, Effect, Exit } from 'effect';

import { registerRun } from '@agent/storage';
import { finalizeRun } from '@agent/storage/runLifecycle';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ProcessServices } from '@platform/processRuntime';
import { Secrets } from '@platform/secrets';
import {
  AgentCategory,
  RUN_OUTCOME,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { aggregateError, generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { applyHelperModelPreference } from './helperModelPreference';
import {
  executeAgent,
  type ExecuteAgentOptions,
  type ResumeToolUseFromResumeDataOptions,
} from './executeAgent';
import type { SessionHandle } from './SessionHandle';
import type { AgentFlowResult } from './AgentFlowResult';

/**
 * Options for `runAgent`. Fields shared with the lower-level `executeAgent`
 * are picked from `ExecuteAgentOptions` (and forwarded as-is) so the two
 * option types can't drift apart silently; see that interface for their docs.
 */
export interface RunAgentOptions
  extends
    Pick<
      ExecuteAgentOptions,
      | 'stopAfterCycle'
      | 'approvalPromptsUnavailable'
      | 'onApprovalPolicyDenial'
      | 'tools'
      | 'ownApiKeyFallback'
      | 'onRun'
      | 'onRunResolved'
      | 'onTraceEvent'
      | 'onIdle'
      | 'publishWorkflowOutput'
    >,
    Pick<ResumeToolUseFromResumeDataOptions, 'beforeRunEnd' | 'onRunClaimed'> {
  readonly session: SessionHandle;
  /** Reject an explicitly supplied category that differs from the resolved definition. */
  readonly enforceCategory?: boolean;
  /**
   * The caller owns presentation for failures before registration; after
   * that the run's `result` event presents.
   */
  suppressErrorNotification?: boolean;
  /**
   * Opt-in set by the "fix LaTeX" VS Code actions (Fix-Compilation command, the
   * progress-view compile fixer): run the launched agent on the configured
   * helper model instead of the selected one. Off for a direct main-view launch,
   * the CLI, and orchestrator delegations, which all keep the chosen model.
   */
  preferHelperModel?: boolean;
}

/** A fresh launch; a persisted run resumes through `resumeRun`. */
export interface RunAgentRequest {
  readonly config: AgentConfig;
  /** The id to register the run under; one is minted when omitted. */
  readonly runId?: RunId;
}

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Validates-then-runs: assigns a runId when the request omits one,
 * registers the run in the run store, runs the agent, and — for a
 * workflow result — awaits the host's `publishWorkflowOutput` before the run's
 * terminal commit. Presenting the result is the caller's, once this returns.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent`, where the
 * caller owns runId generation and `registerRun`.
 *
 * The launch admits on `options.session`'s runs (`session.runs`), the same
 * `Runs` `executeAgent` provides to the run below it.
 */
export const runAgent = Effect.fn('runAgent')(function* (
  request: RunAgentRequest,
  options: RunAgentOptions,
): Effect.fn.Return<AgentFlowResult, Error, ProcessServices> {
  const {
    beforeRunEnd,
    onRunClaimed,
    preferHelperModel,
    suppressErrorNotification,
    ...executeAgentOptions
  } = options;
  const runId = request.runId ?? generateRunId();
  const runSession = executeAgentOptions.session;
  // The launch's fiber is the admission, and the lane refuses a run that
  // already has a live generation here in the same synchronous step as its
  // claim ({@link RunRegistry.launchRun}). A stop by run id
  // (`RunRegistry.interrupt`) reaches the launch wherever it has got to.
  return yield* runSession.runs.launchRun(
    runId,
    Effect.gen(function* () {
      // Resolve the selected model before registering the run. The helper
      // model swap reads the enabled-model list, the routing switches and
      // the provider keys, so it takes this session's setting slots and the
      // process secret store.
      const modelStores = {
        ...runSession.roots,
        secrets: yield* Secrets,
      };
      const requestedConfig = preferHelperModel
        ? yield* applyHelperModelPreference(request.config, modelStores)
        : request.config;
      const definition = yield* prepareAgentDefinition({
        config: requestedConfig,
        session: runSession,
        enforceCategory: options.enforceCategory,
        suppressErrorNotification,
      });
      const { config } = definition;
      const userFollowUpSupport =
        config.agentCategory === AgentCategory.ToolUse &&
        executeAgentOptions.stopAfterCycle !== true
          ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
          : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
      yield* registerRun(runSession, runId, config, {
        identity: { kind: 'agent', agent: config.agent },
        userFollowUpSupport,
      });

      let lifecycleStarted = false;
      const callerOnRun = executeAgentOptions.onRun;
      // The terminal aggregation REPLACES the run's own failure: it is a
      // value the exit handler records and this fold re-fails, never the
      // handler's own failure — `Effect.onExit` combines a handler failure
      // with the run's cause instead of replacing it, and the aggregate
      // would drown beneath the failure it diagnoses. Interruption still
      // unwinds straight past the `Effect.exit` below, with the handler's
      // uninterruptible cleanup already run.
      let aggregated: Error | undefined;
      const run = yield* Effect.exit(
        Effect.gen(function* () {
          // The run's claim, held by this launch for the run's whole life:
          // the run's birth claim. Taken inside the terminal's reach, so a
          // hold that fails still ends the run this launch registered; and
          // released when this launch's scope closes, after its ending has
          // committed below.
          yield* runSession.holdRunClaim(runId);
          onRunClaimed?.(runId);
          return yield* executeAgent(definition, runId, {
            ...executeAgentOptions,
            session: runSession,
            onRun: (id) =>
              Effect.suspend(() => {
                lifecycleStarted = true;
                return callerOnRun?.(id) ?? Effect.void;
              }),
          });
        }).pipe(
          // The launch's terminal: a stop lands before it or after it, never
          // inside — the FAILED ending of a launch that failed before its
          // lifecycle started, the host's final artifacts and the run's
          // ending commit atomically, on every exit, before the claim this
          // launch holds is released.
          Effect.onExit((exit) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const failures: unknown[] = [];
                if (Exit.isFailure(exit)) {
                  failures.push(Cause.squash(exit.cause));
                  if (!lifecycleStarted) {
                    const finalization = yield* Effect.exit(
                      finalizeRun(runSession, {
                        runId,
                        outcome: RUN_OUTCOME.FAILED,
                      }),
                    );
                    if (Exit.isFailure(finalization))
                      failures.push(Cause.squash(finalization.cause));
                    else if (!finalization.value.ok)
                      failures.push(finalization.value.error);
                  }
                }

                const artifacts = yield* Effect.exit(
                  Effect.suspend(
                    () => beforeRunEnd?.(runSession) ?? Effect.void,
                  ),
                );
                if (Exit.isFailure(artifacts))
                  failures.push(Cause.squash(artifacts.cause));
                if (Exit.isFailure(artifacts) || artifacts.value !== true) {
                  const ended = yield* Effect.exit(
                    runSession.commitRunEnd(runId),
                  );
                  if (Exit.isFailure(ended))
                    failures.push(Cause.squash(ended.cause));
                }
                if (failures.length > 0) {
                  aggregated = ensureError(
                    aggregateError(
                      failures,
                      `Run ${runId} failed or its final artifacts could not be persisted`,
                    ),
                  );
                }
              }),
            ),
          ),
        ),
      );
      if (Exit.isSuccess(run)) return run.value;
      if (Cause.hasInterruptsOnly(run.cause))
        return yield* Effect.failCause(run.cause);
      return yield* Effect.fail(
        aggregated ?? ensureError(Cause.squash(run.cause)),
      );
    }).pipe(Effect.scoped),
  );
});
