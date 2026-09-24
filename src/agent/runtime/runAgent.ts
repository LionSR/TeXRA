import { Cause, Effect, Exit } from 'effect';
import stableStringify from 'safe-stable-stringify';

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
import { prepareAgentDefinition } from './AgentLaunchContext';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { RunLive } from './runRoster';
import type { AgentRunHandle } from './RunHandle';
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
   * The owning session is passed explicitly so the hook does not depend on an
   * ambient run frame during Effect resumption. A failure of this program is
   * one more failure the launch reports; it is never read as a `false`
   * answer, so the ordinary release still runs.
   */
  beforeLeaseRelease?: (
    session: SessionHandle,
  ) => Effect.Effect<boolean | void, Error>;
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
  // Refuse duplicates before any snapshot is taken: either request kind can
  // supply a run id, and a resume of a run this session already runs would
  // queue behind the live generation, wake it without a handle of its own,
  // and restore a prior terminal fact over the one that generation is about
  // to write. The lane takes the same refusal ({@link RunRegistry.launchRun});
  // this early read only spares the launch the snapshot it would take first.
  const existingHandle = runSession.runs.getHandle(runId);
  if (runSession.runs.isLive(runId) || existingHandle !== undefined)
    return yield* Effect.fail(new RunLive({ runId }));

  // The launch's fiber is the admission, so a stop by run id
  // (`RunRegistry.interrupt`) reaches the launch wherever it has got to — no
  // launch-scoped stop latch exists beside it.
  return yield* runSession.runs.launchRun(
    runId,
    Effect.gen(function* () {
      // The lineage reads run inside the operation the lane forks, so the
      // launch's fiber exists — and is the stop's target — from the first
      // instant the run is admitted. A stop landing during them interrupts
      // the fiber rather than missing a launch that has not started.
      // A resumed run's prior terminal fact: what a launch that fails before
      // its lifecycle starts restores, so the run does not read as still
      // running.
      const priorEnd = shouldRegister
        ? null
        : yield* getRunRecords(runSession, runId).readRunEnd();
      const priorEndStable = stableStringify(priorEnd);
      if (
        !shouldRegister &&
        !(yield* getRunRecords(runSession, runId).exists())
      )
        return yield* Effect.fail(new Error(`Run not found: ${runId}`));
      // A resumed run's parentage is the persisted `run.start`, re-read
      // here inside the owned launch and handed to the lifecycle as
      // `parentRunId` — never a caller's own word about which run launched
      // it. A detach another host committed while the launch prepared has
      // folded by the re-read below, so the edge arrives already severed.
      const resumedParentRunId = shouldRegister
        ? undefined
        : yield* persistedParentRunId(runSession, runId);
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
        enforceCategory: request.kind === 'resume' || options.enforceCategory,
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
          onRunLeaseAcquired?.(runId);
          // Ownership is the fence for the edge as well: a detach another
          // host committed while this launch prepared has folded by now, and
          // a foreign row never reaches a handle this session tracks, so the
          // registry applies the severed edge here (approval ancestry, the
          // former parent's roster) before the lifecycle reads the lineage
          // back off the fresh edge below. Inside the owned region: a failed
          // read releases ownership like any other launch failure.
          const liveParent = shouldRegister
            ? undefined
            : yield* persistedParentRunId(runSession, runId);
          if (resumedParentRunId !== undefined && liveParent === undefined)
            runSession.runs.detachChildren(resumedParentRunId, [runId]);
          const onRun = (handle: AgentRunHandle): Effect.Effect<void, Error> =>
            Effect.suspend(() => {
              lifecycleStarted = true;
              return callerOnRun?.(handle) ?? Effect.void;
            });
          return liveParent !== undefined
            ? yield* executeAgent(definition, runId, {
                ...executeAgentOptions,
                parentRunId: liveParent,
                session: runSession,
                resumed: !shouldRegister,
                onRun,
              })
            : yield* executeAgent(definition, runId, {
                ...executeAgentOptions,
                session: runSession,
                resumed: !shouldRegister,
                onRun,
              });
        }).pipe(
          // The launch's terminal: a stop lands before it or after it, never
          // inside — the prior-outcome restore, the host's final artifacts
          // and the lease release settle atomically, on every exit.
          Effect.onExit((exit) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const failures: unknown[] = [];
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause);
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
                    } else {
                      const currentStable = stableStringify(current.value);
                      if (
                        currentStable !== undefined &&
                        priorEndStable !== undefined &&
                        currentStable === priorEndStable
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
                }

                const artifacts = yield* Effect.exit(
                  Effect.suspend(
                    () => beforeLeaseRelease?.(runSession) ?? Effect.void,
                  ),
                );
                if (Exit.isFailure(artifacts))
                  failures.push(Cause.squash(artifacts.cause));
                if (Exit.isFailure(artifacts) || artifacts.value !== true) {
                  const release = yield* Effect.exit(
                    runSession.releaseRunLease(runId),
                  );
                  if (Exit.isFailure(release))
                    failures.push(Cause.squash(release.cause));
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
    }),
  );
});
