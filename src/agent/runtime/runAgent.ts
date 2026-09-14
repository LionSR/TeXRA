import { Cause, Deferred, Effect, Exit } from 'effect';

import { registerRun, getRunRecords } from '@agent/storage';
import {
  acquireResumedRunOwnership,
  finalizeRun,
} from '@agent/storage/runLifecycle';
import { persistedParentRunId } from '@agent/storage/runRecords';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AppState } from '@platform/interfaces';
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
import {
  failIfLaunchStopped,
  prepareAgentDefinition,
} from './AgentLaunchContext';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { RunHandle } from './RunHandle';
import { runInSession } from './RunContext';
import type { SessionHandle } from './SessionHandle';
import type { AgentFlowResult } from './AgentFlowResult';

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
 *
 * The launch admits on `options.session`'s runs (`session.runs`), the same
 * `Runs` `executeAgent` provides to the run below it.
 */
export const runAgent = Effect.fn('runAgent')(function* (
  request: RunAgentRequest,
  options: RunAgentOptions,
): Effect.fn.Return<AgentFlowResult, Error, ProcessServices> {
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
  // A resume of a run this session already runs is a duplicate, refused here
  // before any snapshot is taken: queued behind the live generation it would
  // wake without a handle of its own and restore a prior terminal fact over
  // the one that generation is about to write.
  if (!shouldRegister && runSession.runs.isActiveOrResuming(runId))
    return yield* Effect.fail(new Error(`Run is already running: ${runId}`));
  // A resumed run's prior terminal fact: what a launch that fails before its
  // lifecycle starts restores, so the run does not read as still running.
  const priorEnd = shouldRegister
    ? null
    : yield* getRunRecords(runSession, runId).readRunEnd();
  if (!shouldRegister && !(yield* getRunRecords(runSession, runId).exists()))
    return yield* Effect.fail(new Error(`Run not found: ${runId}`));
  // A resumed run's lineage, read before its handle is registered below: from
  // that moment a stop of the parent sees this child, so it cascades into the
  // launch (the handle's interrupt stops launch preparation) or detaches it,
  // and a parent whose stop has already begun refuses the admission outright.
  // The launch reads the edge back off the handle instead of deriving it a
  // second time, so nothing can install a parent after its stop finished.
  const resumedParentRunId = shouldRegister
    ? undefined
    : yield* persistedParentRunId(runSession, runId);
  // The launch's one stop: the launch handle's interrupt completes it, the
  // launch fails at its next preparation step once it has, and the run
  // adopts it as its own stop, so a stop reaches the run wherever the launch
  // has got to.
  const launchStopped = Deferred.makeUnsafe<void>();
  const launchHandle = runSession.runs.getHandle(runId)
    ? undefined
    : new RunHandle(
        {
          runId,
          identity: { kind: 'agent', agent: request.config.agent },
          category: request.config.agentCategory,
        },
        resumedParentRunId ?? null,
      );
  const detachLaunchInterrupt = launchHandle?.attachInterruptHandler({
    interrupt: () => Deferred.doneUnsafe(launchStopped, Effect.void),
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
          suppressErrorNotification,
        });
        yield* failIfLaunchStopped(launchStopped);
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
            // Ownership is the fence for the edge as well: a detach another
            // host committed while this launch prepared has folded by now,
            // and a foreign row never reaches a handle this session tracks,
            // so the registry applies the severed edge here (handle,
            // approval ancestry, the former parent's roster), before the
            // lifecycle reads the lineage back off the handle. Inside the
            // owned region: a failed read releases ownership like any other
            // launch failure.
            const formerParent = launchHandle?.parent ?? null;
            if (
              !shouldRegister &&
              formerParent !== null &&
              (yield* persistedParentRunId(runSession, runId)) === undefined
            )
              runSession.runs.detachChildren(formerParent, [runId]);
            return yield* executeAgent(definition, runId, {
              ...executeAgentOptions,
              launchStopped,
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
            // A resume restores its snapshot only while the snapshot is
            // still the run's terminal fact: a generation that admitted
            // itself beside this one (both passed the duplicate check before
            // either awaited) may have written a newer end, which this
            // failure must not undo. A read that fails here is one more
            // failure to report, never a reason to skip the release below.
            const current = shouldRegister
              ? Exit.succeed(priorEnd)
              : yield* Effect.exit(
                  getRunRecords(runSession, runId).readRunEnd(),
                );
            if (Exit.isFailure(current)) {
              failures.push(Cause.squash(current.cause));
            } else if (
              JSON.stringify(current.value) === JSON.stringify(priorEnd)
            ) {
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
        detachLaunchInterrupt?.();
        if (launchHandle && runSession.runs.getHandle(runId) === launchHandle) {
          runSession.runs.untrack(runId);
        }
      }),
    ),
  );
});
