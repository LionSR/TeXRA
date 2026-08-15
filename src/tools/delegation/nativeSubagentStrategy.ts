/**
 * Native child-run strategy over the shared `childRunLoop`, for both agent
 * categories — a native (in-process TeXRA agent) subagent is launched the
 * same way whether it is `toolUse` or `workflow`; only its result shape and
 * whether it ever produces a WAITING turn differ, and both of those are
 * already category-derived data rather than category-specific code paths.
 *
 * `launch` is the standard native child-execution primitive. Both detached
 * delegation (through `childRunLoop`) and durable in-band workflow calls invoke
 * it, so launch options, progress, stream identity, approval inheritance,
 * cancellation, failure capture, and cost observation cannot drift between
 * those callers. `runTurn` is every following interactive turn: resolve the
 * persisted flow-record cursor for this execution
 * (`retrieveSessionResumeData`) and drive it to the next WAITING/terminal
 * boundary via `resumeToolUseFromResumeData`, handing it the batch already
 * consumed by `childRunLoop`. `runTurn` is unreachable for a workflow child —
 * a workflow flow never produces a WAITING result, so `isTerminal` is always
 * true on its first (and only) turn, and `childRunLoop.ts`'s loop breaks on a
 * terminal turn before ever consulting `runTurn`.
 * `allowWaitingResult: true` is likewise inert for workflow —
 * `isWaitingFlowResult` requires `category === 'toolUse'`, so a workflow
 * result can never satisfy it. Delivery choreography (format/persist/
 * manifest/deliver), duplicate-delivery prevention (there is exactly one
 * delivery site — the loop), and WAITING-cleanup registration all live in the
 * loop; this strategy owns only what is specific to a native subagent:
 * launching, resuming (tool-use only), and formatting its result shape.
 */

import { getExecutionStore } from '@agent/storage';
import {
  isWaitingFlowResult,
  type AgentFlowResult,
  type AgentRuntimeFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { onAbort, unique } from '@utils/core';
import {
  buildSubagentFailureResultMeta,
  formatSubagentError,
} from './subagentResults';

import {
  buildSubagentResult,
  formatBuiltSubagentDelivery,
  type BuiltSubagentResult,
} from './subagentDeliveryFormat';

/**
 * The two engine entry points a native child run needs. Provided by
 * `@agent/runtime/executeAgent` at its module load rather than imported: a
 * static import here would close the
 * registry -> DelegationTools -> proposalFlow -> subagentExecution ->
 * nativeSubagentStrategy -> executeAgent -> runToolUseFlow -> registry cycle,
 * because the engine's flow driver statically imports the tool registry (a
 * kept edge). Agents launching agents is inherently recursive; this slot is
 * the single, typed point where that recursion closes at runtime.
 */
export interface AgentEngine {
  readonly executeAgent: typeof import('@agent/runtime/executeAgent').executeAgent;
  readonly resumeToolUseFromResumeData: typeof import('@agent/runtime/executeAgent').resumeToolUseFromResumeData;
}

let agentEngine: AgentEngine | undefined;

/** Called once at `@agent/runtime/executeAgent` module load (tests substitute fakes). */
export function provideAgentEngine(engine: AgentEngine): void {
  agentEngine = engine;
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
 * native subagent callers — durable in-band (`InBandSubagentExecutionBaseOptions`)
 * and detached (`NativeSubagentStrategyParams`) — so a new launch option has a
 * single home and can't drift between the two interfaces or the executeInBand
 * field mapping.
 */
export interface ChildRunLaunchOptions {
  readonly agentName: string;
  readonly parentStreamId: StreamTabId;
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
  /** Fires with the resolved child stream id — the caller inherits approvals onto it. */
  readonly onStreamResolved?: (streamId: StreamTabId) => void;
}

export interface NativeSubagentStrategyParams extends ChildRunLaunchOptions {
  readonly config: AgentConfig;
  readonly agentCategoryExplicit: boolean;
  readonly executionId: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  /** Omit for ordinary interactive delegation; durable calls end after one cycle. */
  readonly executionMode?: 'single-cycle';
  /** Fires with the resolved child stream id — the caller inherits approvals onto it. */
  readonly onStreamResolved: (streamId: StreamTabId) => void;
}

/**
 * Fold a WAITING turn into the shape `formatSubagentDelivery` expects — for
 * the orchestrator, a suspended turn reads as a completed cycle.
 */
function toDeliveryResult(
  turn: AgentRuntimeFlowResult,
  executionId: ExecutionId,
): AgentFlowResult {
  if (!isWaitingFlowResult(turn)) return turn;
  return {
    category: 'toolUse',
    outcome: RUN_OUTCOME.COMPLETED,
    response: turn.response,
    files: turn.files,
    executionId,
    streamId: turn.streamId,
    memoryMisses: turn.memoryMisses,
    totalCostUsd: turn.totalCostUsd,
  };
}

/** Bind every distinct caller/turn cancellation source to one live run handle. */
function bindAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
  handle: AgentRunHandle,
): () => void {
  const uniqueSignals = unique(
    signals.filter((signal): signal is AbortSignal => signal !== undefined),
  );
  if (uniqueSignals.length === 0) return () => {};
  const combined = AbortSignal.any(uniqueSignals);
  return onAbort(combined, () => handle.interrupt());
}

export function createNativeSubagentStrategy(
  params: NativeSubagentStrategyParams,
): ChildRunStrategy<AgentRuntimeFlowResult> & {
  /** Underlying application error captured for the most recent turn. */
  readonly getTurnError: () => unknown;
  /** Terminal-shaped result captured from the most recent turn's return. */
  readonly getTurnResult: () => AgentFlowResult | undefined;
  /** Shared typed result construction used by detached and in-band drivers. */
  readonly buildResult: (
    turn: AgentRuntimeFlowResult,
  ) => Promise<BuiltSubagentResult>;
} {
  let runHandle: AgentRunHandle | undefined;
  // Captured for the turn currently in flight; read once the call resolves.
  // `executeAgent`/`resumeToolUseFromResumeData` never reject for a
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

  const resolveDeliveryTarget = (): StreamTabId | undefined =>
    runHandle ? runHandle.deliveryTargetStreamId : params.parentStreamId;

  const runNative = async (
    ports: ChildRunPorts,
    abortController: AbortController,
    call: (
      onRun: (handle: AgentRunHandle) => void,
    ) => Promise<AgentRuntimeFlowResult>,
  ): Promise<AgentRuntimeFlowResult> => {
    lastErr = undefined;
    lastResult = undefined;
    cachedBuilt = undefined;
    cachedDelivery = undefined;
    let detachAbort = (): void => {};
    try {
      const result = await call((handle) => {
        detachAbort();
        runHandle = handle;
        detachAbort = bindAbortSignals(
          [params.signal, abortController.signal],
          handle,
        );
      });
      lastResult = toDeliveryResult(result, params.executionId);
      // Every turn's totalCostUsd is the run's cumulative cost to date, not a
      // per-turn delta. The loop retains the best value and commits it to the
      // parent exactly once, when the child's run ends. A failed turn resolves
      // with its terminal result too, so its cost is recorded here as well; a
      // rejection means the turn never produced one.
      ports.recordCost(result.totalCostUsd);
      return result;
    } finally {
      detachAbort();
    }
  };

  const buildResult = async (
    turn: AgentRuntimeFlowResult,
  ): Promise<BuiltSubagentResult> => {
    if (!cachedBuilt) {
      const result = toDeliveryResult(turn, params.executionId);
      cachedBuilt = await buildSubagentResult(
        params.executionId,
        params.agentName,
        result,
        {
          startedAt: params.startedAt,
          parentExecutionId: params.parentExecutionId,
        },
      );
    }
    return cachedBuilt;
  };

  return {
    // Not used as a trace stage for native delegation (the loop gates
    // `logger.openStage` on `childStream`, which native delegation never
    // passes) — its only reader is the loop's non-throwing-failure message,
    // which becomes the persisted terminal `error.message` for the execution
    // record. Keep it category-derived so a failed workflow subagent's record
    // never reads "tool-use".
    stageLabel:
      params.config.agentCategory === AgentCategory.ToolUse
        ? 'Native tool-use subagent'
        : 'Native workflow subagent',

    launch: (ports, abortController) =>
      runNative(ports, abortController, async (onRun) => {
        const executeOptions = {
          session: params.session,
          isSubagent: true,
          enforceCategory: params.agentCategoryExplicit,
          parentStreamId: params.parentStreamId,
          approvalPromptsUnavailable: params.approvalPromptsUnavailable,
          onApprovalPolicyDenial: params.onApprovalPolicyDenial,
          runtimeUnavailableTools: params.runtimeUnavailableTools,
          workflowPhase: params.workflowPhase,
          onStreamResolved: params.onStreamResolved,
          onProgress: (update: Parameters<ChildRunPorts['notify']>[0]) =>
            ports.notify(update),
          onRunError: (err: unknown) => {
            lastErr = err;
          },
          onRun,
        };
        return engine().executeAgent(params.config, params.executionId, {
          ...executeOptions,
          allowWaitingResult: true,
          userFollowUpSupport:
            params.executionMode !== 'single-cycle' &&
            params.config.agentCategory === AgentCategory.ToolUse
              ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
              : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          ...(params.executionMode === 'single-cycle'
            ? { stopAfterCycle: true }
            : {}),
        });
      }),

    runTurn: (followUps, ports, abortController) =>
      runNative(ports, abortController, async (onRun) => {
        const streamId = runHandle?.childStreamId;
        if (!streamId) {
          throw new Error(
            `Native subagent ${params.executionId} has no live stream to resume.`,
          );
        }
        const config = await getExecutionStore(params.executionId).readConfig();
        if (!config) {
          throw new Error(
            `Native subagent ${params.executionId} has no persisted config to resume.`,
          );
        }
        const resume = await retrieveSessionResumeData(
          streamId,
          params.executionId,
          config,
        );
        if (!resume || resume.type !== 'toolUse') {
          throw new Error(
            `Native subagent ${params.executionId} has no resumable tool-use snapshot.`,
          );
        }

        // childRunLoop already consumed this batch from the stream queue. A
        // queued-resume wrapper would append it to ToolUseSessionLifecycle,
        // which is backed by that same queue; the next WAITING result would
        // therefore feed the identical batch back into this method forever.
        // Hand it directly to the persisted WAITING cursor instead. Any item
        // that races into the queue after this drain remains there for the
        // loop's next turn.
        params.session.status.transition(
          streamId,
          STREAM_PHASE.RUNNING,
          STREAM_TRANSITION_CAUSE.RESUME,
          { substate: STREAM_SUBSTATE.RESUMING },
        );
        return await engine().resumeToolUseFromResumeData(resume, {
          session: params.session,
          approvalPromptsUnavailable: params.approvalPromptsUnavailable,
          onApprovalPolicyDenial: params.onApprovalPolicyDenial,
          runtimeUnavailableTools: params.runtimeUnavailableTools,
          parentStreamId: params.parentStreamId,
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

    isTerminal: (turn) => !isWaitingFlowResult(turn),
    isTurnError: () => lastErr !== undefined,
    getTurnError: () => lastErr,
    getTurnResult: () => lastResult,

    resolveDeliveryTarget,

    buildResult,

    formatDelivery: async (turn) => {
      cachedDelivery ??= formatBuiltSubagentDelivery(
        params.executionId,
        params.agentName,
        toDeliveryResult(turn, params.executionId),
        await buildResult(turn),
        params.workingDirectory,
      );
      return cachedDelivery;
    },

    formatError: (turn, err) => {
      const wallTimeMs = Date.now() - params.startedAt;
      const result = turn
        ? toDeliveryResult(turn, params.executionId)
        : lastResult;
      return formatSubagentError(
        params.executionId,
        params.agentName,
        lastErr ?? err,
        {
          wallTimeMs,
          workingDirectory: params.workingDirectory,
          memoryMisses: result?.memoryMisses,
        },
      );
    },

    buildResultMeta: async (turn, isError) => {
      if (isError || turn === null) {
        // Overwrite any interim success manifest from an earlier turn so
        // /executions/{id}/result never claims success for a failed run.
        const result = turn
          ? toDeliveryResult(turn, params.executionId)
          : lastResult;
        return buildSubagentFailureResultMeta(
          params.agentName,
          params.config.agentCategory,
          result,
          Date.now() - params.startedAt,
          { parentExecutionId: params.parentExecutionId },
        );
      }
      return (await buildResult(turn)).resultMeta;
    },
  };
}
