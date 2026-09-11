/**
 * Native child-run strategy over the shared `childRunLoop`, for both agent
 * categories — a native (in-process TeXRA agent) subagent is launched the
 * same way whether it is `toolUse` or `workflow`; only its result shape and
 * whether it ever produces a WAITING turn differ, and both of those are
 * already category-derived data rather than category-specific code paths.
 *
 * `launch` is the standard native child-run primitive. Both detached
 * delegation (through `childRunLoop`) and durable in-band workflow calls invoke
 * it, so launch options, progress, stream identity, approval inheritance,
 * cancellation, failure capture, and cost observation cannot drift between
 * those callers. `runTurn` is every following interactive turn: resolve the
 * persisted flow-record cursor for this run
 * (`retrieveSessionResumeData`) and drive it to the next WAITING/terminal
 * boundary via `resumeToolUseTurn`, handing it the batch already
 * consumed by `childRunLoop`. `runTurn` is unreachable for a workflow child —
 * a workflow flow never produces a WAITING result, so `isTerminal` is always
 * true on its first (and only) turn, and `childRunLoop.ts`'s loop breaks on a
 * terminal turn before ever consulting `runTurn`.
 * The subagent WAITING admission is likewise inert for workflow —
 * `isWaitingFlowResult` requires `category === 'toolUse'`, so a workflow
 * result can never satisfy it. Delivery choreography (format/persist/
 * manifest/deliver), duplicate-delivery prevention (there is exactly one
 * delivery site — the loop), and WAITING-cleanup registration all live in the
 * loop; this strategy owns only what is specific to a native subagent:
 * launching, resuming (tool-use only), and formatting its result shape.
 */

import { Cause, Effect, Exit } from 'effect';

import { getRunRecords } from '@agent/storage';
import {
  isWaitingFlowResult,
  type AgentFlowResult,
  type AgentRuntimeFlowResult,
} from '@agent/runtime/AgentFlowResult';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import type { AgentRunHandle } from '@agent/runtime/RunHandle';
import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { PreparedAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { createLog } from '@logger/logUtils';
import {
  AgentCategory,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { RUN_TRANSITION_CAUSE } from '@shared/runs/runStatus';
import { onAbort, unique } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import {
  buildSubagentFailureResultMeta,
  buildSubagentResult,
  formatSubagentDelivery,
  formatSubagentError,
  type BuiltSubagentResult,
} from './subagentResults';

/**
 * The two engine entry points a native child run needs. Provided by
 * `@agent/runtime/executeAgent` at its module load rather than imported: a
 * static import here would close the
 * registry -> DelegationTools -> proposalFlow -> subagentRun ->
 * nativeSubagentStrategy -> executeAgent -> runToolUseFlow -> registry cycle,
 * because the engine's flow driver statically imports the tool registry (a
 * kept edge). Agents launching agents is inherently recursive; this slot is
 * the single, typed point where that recursion closes at runtime.
 */
export interface AgentEngine {
  readonly executeAgent: typeof import('@agent/runtime/executeAgent').executeAgent;
  /**
   * The unlaned turn (`executeAgent`'s `resumeToolUseTurn`): a child loop
   * already holds its run's lane, so the laned
   * `resumeToolUseFromResumeData` would park the turn behind the loop's own
   * generation.
   */
  readonly resumeToolUseTurn: (
    resume: ToolUseResumeData,
    options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
  ) => Effect.Effect<AgentRuntimeFlowResult, Error>;
}

const log = createLog('nativeSubagentStrategy');

let agentEngine: AgentEngine | undefined;

/**
 * Scoped provider for the engine slot. Production has exactly one caller —
 * `@agent/runtime/executeAgent` at its own module load, guaranteed before any
 * strategy call because a subagent only launches from inside an engine-driven
 * run. Tests dispose their override after each case so a fake cannot leak into
 * another consumer of this module graph. Passing the engine as an explicit
 * parameter instead is not available: the strategy's callers are the
 * delegation tools, whose static import of the engine is the exact cycle this
 * slot exists to sever.
 */
export function provideAgentEngine(engine: AgentEngine): () => void {
  const previous = agentEngine;
  agentEngine = engine;
  return () => {
    if (agentEngine === engine) agentEngine = previous;
  };
}

function engine(): AgentEngine {
  if (!agentEngine) {
    throw new Error(
      'Native subagent launch requires the agent engine, but @agent/runtime/executeAgent has not been loaded.',
    );
  }
  return agentEngine;
}

/**
 * The launch fields every native child run needs, shared between the two
 * native subagent callers — durable in-band (`InBandSubagentRunBaseOptions`)
 * and detached (`NativeSubagentStrategyParams`) — so a new launch option has a
 * single home and can't drift between the two interfaces or the executeInBand
 * field mapping.
 */
export interface ChildRunLaunchOptions {
  readonly agentName: string;
  /** The launching run: the child's parent edge. */
  readonly parentRunId: RunId;
  readonly session: SessionHandle;
  readonly approvalPromptsUnavailable?: boolean;
  readonly onApprovalPolicyDenial?: () => void;
  readonly runtimeUnavailableTools?: readonly string[];
  /**
   * Workflow-script phase owning this child, when the caller is a
   * workflow-script run. Rides to the child's roster row so a host can group
   * grandchild rows by phase.
   */
  readonly workflowPhase?: string;
  /** Caller cancellation for a durable in-band launch. */
  readonly signal?: AbortSignal;
  /** Fires with the resolved child run id — the caller inherits approvals onto it. */
  readonly onRunResolved?: (runId: RunId) => void;
}

interface NativeSubagentStrategyParams extends ChildRunLaunchOptions {
  readonly definition: PreparedAgentDefinition;
  readonly runId: RunId;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  /** Omit for ordinary interactive delegation; durable calls end after one cycle. */
  readonly runMode?: 'single-cycle';
  /** Persist the typed result without constructing fallible prose delivery. */
  readonly resultOnly?: boolean;
  /**
   * Whether the launched child can take user follow-ups. Decided by the caller
   * (which also registers the child's roster row with it) so the two can't
   * disagree about the same run.
   */
  readonly userFollowUpSupport: UserFollowUpSupport;
}

/**
 * Fold a WAITING turn into the shape `formatSubagentDelivery` expects — for
 * the orchestrator, a suspended turn reads as a completed cycle.
 */
function toDeliveryResult(
  turn: AgentRuntimeFlowResult,
  runId: RunId,
): AgentFlowResult {
  if (!isWaitingFlowResult(turn)) return turn;
  return { ...turn, outcome: RUN_OUTCOME.COMPLETED, runId };
}

/** Bind every distinct caller/turn cancellation source to one live run handle. */
function bindAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
  handle: AgentRunHandle,
): () => void {
  // One listener per source, no `AbortSignal.any`: a composite built on the
  // parent run's signal stays reachable from it (listener and all) until it
  // aborts, which for a long-lived parent is never — one retained turn per
  // subagent (see `linkAbortSignals`).
  const detachers = unique(
    signals.filter((signal): signal is AbortSignal => signal !== undefined),
  ).map((signal) => onAbort(signal, () => handle.interrupt()));
  return () => {
    for (const detach of detachers) detach();
  };
}

export function createNativeSubagentStrategy(
  params: NativeSubagentStrategyParams,
): ChildRunStrategy<AgentRuntimeFlowResult> {
  let runHandle: AgentRunHandle | undefined;
  // Captured for the turn currently in flight; read once the call resolves.
  // `executeAgent`/`resumeToolUseTurn` never reject for a
  // subagent's own application-level failure (runFlowWithLifecycle returns a
  // terminal failed result instead) — the real underlying error is only
  // observable through this callback.
  let lastErr: unknown;
  let lastResult: AgentFlowResult | undefined;
  // Result construction computes and persists diffs, so every consumer of a
  // turn shares one result. Formatting remains separate: if it throws, the
  // already-built result manifest is still available for persistence.
  let cachedBuilt: BuiltSubagentResult | undefined;
  let cachedDelivery: string | undefined;

  const resolveDeliveryTarget = (): RunId | undefined =>
    runHandle ? runHandle.deliveryTarget : params.parentRunId;

  const runNative = Effect.fn('nativeSubagent.runTurn')(function* (
    ports: ChildRunPorts,
    signal: AbortSignal,
    call: (
      onRun: (handle: AgentRunHandle) => void,
    ) => Effect.Effect<AgentRuntimeFlowResult, Error>,
  ) {
    lastErr = undefined;
    lastResult = undefined;
    cachedBuilt = undefined;
    cachedDelivery = undefined;
    let detachAbort = (): void => {};
    return yield* call((handle) => {
      detachAbort();
      runHandle = handle;
      detachAbort = bindAbortSignals([params.signal, signal], handle);
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          lastResult = toDeliveryResult(result, params.runId);
          ports.recordCost(result.usage?.totalCost);
        }),
      ),
      Effect.ensuring(Effect.sync(() => detachAbort())),
    );
  });

  const buildResult = async (
    turn: AgentRuntimeFlowResult,
  ): Promise<BuiltSubagentResult> => {
    if (!cachedBuilt) {
      const result = toDeliveryResult(turn, params.runId);
      cachedBuilt = await buildSubagentResult(
        params.runId,
        params.agentName,
        result,
        { startedAt: params.startedAt },
      );
    }
    return cachedBuilt;
  };

  return {
    // Not used as a trace stage for native delegation (the loop gates
    // `logger.openStage` on `childRun`, which native delegation never
    // passes) — its only reader is the loop's non-throwing-failure message,
    // which becomes the persisted terminal `error.message` for the run
    // record. Keep it category-derived so a failed workflow subagent's record
    // never reads "tool-use".
    stageLabel:
      params.definition.config.agentCategory === AgentCategory.ToolUse
        ? 'Native tool-use subagent'
        : 'Native workflow subagent',

    // A single-cycle child has no later turn to consume a follow-up delivery;
    // its awaiting caller reads the persisted report/result instead.
    ...(params.runMode === 'single-cycle' && {
      deliveryMode: 'persistOnly' as const,
    }),

    launch: (ports, signal) =>
      runNative(ports, signal, (onRun) =>
        Effect.gen(function* () {
          const executeOptions = {
            session: params.session,
            approvalPromptsUnavailable: params.approvalPromptsUnavailable,
            onApprovalPolicyDenial: params.onApprovalPolicyDenial,
            runtimeUnavailableTools: params.runtimeUnavailableTools,
            workflowPhase: params.workflowPhase,
            onRunResolved: params.onRunResolved,
            onProgress: (update: Parameters<ChildRunPorts['notify']>[0]) =>
              ports.notify(update),
            onRunError: (err: unknown) => {
              lastErr = err;
            },
            onRun,
          };
          const turn = yield* engine().executeAgent(
            params.definition,
            params.runId,
            {
              ...executeOptions,
              // This strategy only ever launches child runs: naming the parent
              // is what admits the WAITING result it consumes as a loop turn.
              parentRunId: params.parentRunId,
              ...(params.runMode === 'single-cycle'
                ? { stopAfterCycle: true }
                : {}),
            },
          );
          // A single-cycle run must end its cycle: a WAITING turn here is an
          // invariant violation, surfaced loudly as this turn's failure rather
          // than parked on a queue no follow-up will ever reach. Record the
          // turn's facts first so the failure meta and the parent's cost
          // accounting keep what the run actually spent.
          if (params.runMode === 'single-cycle' && isWaitingFlowResult(turn)) {
            lastResult = toDeliveryResult(turn, params.runId);
            ports.recordCost(turn.usage?.totalCost);
            return yield* Effect.fail(
              new Error(
                `Single-cycle subagent ${params.runId} unexpectedly suspended.`,
              ),
            );
          }
          return turn;
        }),
      ),

    runTurn: (followUps, ports, signal) =>
      runNative(ports, signal, (onRun) =>
        Effect.gen(function* () {
          const runId = runHandle?.runId;
          if (!runId) {
            return yield* Effect.fail(
              new Error(
                `Native subagent ${params.runId} has no live stream to resume.`,
              ),
            );
          }
          const config = yield* getRunRecords(
            params.session,
            params.runId,
          ).readConfig();
          if (!config)
            return yield* Effect.fail(
              new Error(
                `Native subagent ${params.runId} has no persisted config to resume.`,
              ),
            );
          const resume = yield* retrieveSessionResumeData(
            params.runId,
            config,
            params.session,
          );
          if (!resume || resume.type !== 'toolUse')
            return yield* Effect.fail(
              new Error(
                `Native subagent ${params.runId} has no resumable tool-use snapshot.`,
              ),
            );

          // childRunLoop already consumed this batch from the stream queue. A
          // queued-resume wrapper would append it to ToolUseSessionLifecycle,
          // which is backed by that same queue; the next WAITING result would
          // therefore feed the identical batch back into this method forever.
          // Hand it directly to the persisted WAITING cursor instead. Any item
          // that races into the queue after this drain remains there for the
          // loop's next turn.
          params.session.status.transition(
            runId,
            RUN_PHASE.RUNNING,
            RUN_TRANSITION_CAUSE.RESUME,
            { substate: RUN_SUBSTATE.RESUMING },
          );
          return yield* engine().resumeToolUseTurn(resume, {
            session: params.session,
            approvalPromptsUnavailable: params.approvalPromptsUnavailable,
            onApprovalPolicyDenial: params.onApprovalPolicyDenial,
            runtimeUnavailableTools: params.runtimeUnavailableTools,
            // The loop's queue never admits synthetic goal continuations for
            // a subagent, but its batch type is shared with root flows. Keep
            // the existing defensive downgrade rather than silently dropping
            // a future synthetic item.
            drainedFollowUps: followUps.map((item) => ({
              text: item.text,
              displayText: item.displayText,
              mediaFiles: item.mediaFiles,
              origin: item.origin === 'synthetic' ? 'user' : item.origin,
            })),
            onProgress: (update) => ports.notify(update),
            onRunError: (err) => {
              lastErr = err;
            },
            onRun,
          });
        }),
      ),

    isTerminal: (turn) => !isWaitingFlowResult(turn),
    isTurnError: () => lastErr !== undefined,

    resolveDeliveryTarget,

    formatDelivery: async (turn) => {
      if (cachedDelivery === undefined) {
        const built = await buildResult(turn);
        if (params.resultOnly) return '';
        cachedDelivery = formatSubagentDelivery(
          params.agentName,
          built.result,
          {
            runId: params.runId,
            memoryMisses: toDeliveryResult(turn, params.runId).memoryMisses,
            wallTimeMs: built.wallTimeMs,
            workingDirectory: params.workingDirectory,
          },
        );
      }
      return cachedDelivery;
    },

    formatError: (turn, err) => {
      if (params.resultOnly) return '';
      const wallTimeMs = Date.now() - params.startedAt;
      const result = turn ? toDeliveryResult(turn, params.runId) : lastResult;
      return formatSubagentError(
        params.runId,
        params.agentName,
        lastErr ?? err,
        {
          wallTimeMs,
          workingDirectory: params.workingDirectory,
          memoryMisses: result?.memoryMisses,
        },
      );
    },

    buildResultMeta: (turn, isError, _wallTimeMs, error) =>
      Effect.gen(function* () {
        if (isError || turn === null) {
          // Overwrite any interim success manifest from an earlier turn so
          // /executions/{id}/result never claims success for a failed run.
          const result = turn
            ? toDeliveryResult(turn, params.runId)
            : lastResult;
          const wallTimeMs = Date.now() - params.startedAt;
          const failureOptions = { cause: lastErr ?? error };
          const built = yield* Effect.exit(
            Effect.sync(() =>
              buildSubagentFailureResultMeta(
                params.agentName,
                params.definition.config.agentCategory,
                result,
                wallTimeMs,
                failureOptions,
              ),
            ),
          );
          if (Exit.isSuccess(built)) return built.value;
          // Even an unconstructable failure result must leave a durable
          // failure manifest (with the child's real error), never a stale
          // interim record. The category-only form cannot throw.
          log.warn('Failed to build the full subagent failure manifest', {
            data: {
              runId: params.runId,
              error: Cause.squash(built.cause),
            },
          });
          return buildSubagentFailureResultMeta(
            params.agentName,
            params.definition.config.agentCategory,
            undefined,
            wallTimeMs,
            failureOptions,
          );
        }
        const built = yield* Effect.tryPromise({
          try: () => runInSession(params.session, () => buildResult(turn)),
          catch: ensureError,
        });
        return built.resultMeta;
      }),
  };
}
