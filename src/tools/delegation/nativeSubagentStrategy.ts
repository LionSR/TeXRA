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
 * failure capture, and cost observation cannot drift between those callers.
 * Cancellation is not one of them, and no longer reaches a turn from here:
 * the child loop owns the child's one stop and delivers it into the turn in
 * flight through the run's own handle.
 *
 * `runTurn` is every following interactive turn: name the run
 * and the config it runs under, and let `resumeToolUseTurn` read the
 * persisted cursor once under the run lease and drive it to the next
 * WAITING/terminal boundary, with the batch already
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

import { Effect } from 'effect';

import { getRunRecords } from '@agent/storage';
import {
  isWaitingFlowResult,
  type AgentFlowResult,
  type AgentRuntimeFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type {
  ResumeToolUseFromResumeDataOptions,
  ResumeTurnIdentity,
} from '@agent/runtime/executeAgent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunServices } from '@agent/runtime/toolInjection';
import type { AgentRunHandle } from '@agent/runtime/RunHandle';
import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { PreparedAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import {
  AgentCategory,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import {
  buildSubagentResult,
  buildSubagentResultMeta,
  formatSubagentDelivery,
  formatSubagentError,
  type SubagentResultMeta,
} from './subagentResults';

/**
 * The two engine entry points a native child run needs. Provided by
 * `@agent/runtime/executeAgent` at its module load rather than imported: a
 * static import here would close the
 * registry -> DelegationTools -> proposalFlow -> subagentRun ->
 * nativeSubagentStrategy -> executeAgent -> AgentRun -> registry cycle,
 * because the run layer statically imports the tool registry (a kept edge). Agents launching agents is inherently recursive; this slot is
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
    identity: ResumeTurnIdentity,
    options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
  ) => Effect.Effect<AgentRuntimeFlowResult, Error, AgentRunServices>;
}

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

export function createNativeSubagentStrategy(
  params: NativeSubagentStrategyParams,
): ChildRunStrategy<AgentRuntimeFlowResult, AgentRunServices> {
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
  let cachedBuilt: SubagentResultMeta | undefined;
  let cachedDelivery: string | undefined;

  const resolveDeliveryTarget = (): RunId | undefined =>
    runHandle ? runHandle.deliveryTarget : params.parentRunId;

  // The turn's handle is retained for delivery routing and for the resume
  // below, not as a cancellation target: a stop of this child reaches the
  // turn through that same handle, from the child loop that owns the stop
  // (`ChildRunInterruptible`), so this strategy binds no signals of its own.
  const runNative = Effect.fn('nativeSubagent.runTurn')(function* (
    ports: ChildRunPorts,
    call: (
      onRun: (handle: AgentRunHandle) => Effect.Effect<void>,
    ) => Effect.Effect<AgentRuntimeFlowResult, Error, AgentRunServices>,
  ) {
    lastErr = undefined;
    lastResult = undefined;
    cachedBuilt = undefined;
    cachedDelivery = undefined;
    return yield* call((handle) =>
      Effect.sync(() => {
        runHandle = handle;
      }),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          lastResult = toDeliveryResult(result, params.runId);
          ports.recordCost(result.usage?.totalCost);
        }),
      ),
    );
  });

  const buildResult = Effect.fn('nativeSubagent.buildResult')(function* (
    turn: AgentRuntimeFlowResult,
  ) {
    if (!cachedBuilt) {
      const result = toDeliveryResult(turn, params.runId);
      cachedBuilt = yield* buildSubagentResult(
        params.runId,
        params.agentName,
        result,
        {
          startedAt: params.startedAt,
          storageRoot: params.session.roots.storage,
        },
      );
    }
    return cachedBuilt;
  });

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

    launch: (ports) =>
      runNative(ports, (onRun) =>
        Effect.gen(function* () {
          const executeOptions = {
            session: params.session,
            approvalPromptsUnavailable: params.approvalPromptsUnavailable,
            onApprovalPolicyDenial: params.onApprovalPolicyDenial,
            runtimeUnavailableTools: params.runtimeUnavailableTools,
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

    // The resumed flow takes and consumes the queued batch itself, from the
    // queue this child's loop owns; the loop hands a native child none.
    runTurn: (_followUps, ports) =>
      runNative(ports, (onRun) =>
        Effect.gen(function* () {
          const runId = runHandle?.runId;
          if (!runId) {
            return yield* Effect.fail(
              new Error(
                `Native subagent ${params.runId} has no live stream to resume.`,
              ),
            );
          }
          const agentConfig = yield* getRunRecords(
            params.session,
            params.runId,
          ).readConfig();
          if (!agentConfig)
            return yield* Effect.fail(
              new Error(
                `Native subagent ${params.runId} has no persisted config to resume.`,
              ),
            );
          // The snapshot is read once, inside the turn and under its run
          // lease: a run whose snapshot is gone by then refuses there, with
          // `ResumeSessionUnavailableError`.
          return yield* engine().resumeToolUseTurn(
            { runId: params.runId, agentConfig },
            {
              session: params.session,
              approvalPromptsUnavailable: params.approvalPromptsUnavailable,
              onApprovalPolicyDenial: params.onApprovalPolicyDenial,
              runtimeUnavailableTools: params.runtimeUnavailableTools,
              onProgress: (update) => ports.notify(update),
              onRunError: (err) => {
                lastErr = err;
              },
              onRun,
            },
          );
        }),
      ),

    isTerminal: (turn) => !isWaitingFlowResult(turn),
    isTurnError: () => lastErr !== undefined,

    resolveDeliveryTarget,

    formatDelivery: Effect.fn('nativeSubagent.formatDelivery')(function* (
      turn: AgentRuntimeFlowResult,
    ) {
      if (cachedDelivery === undefined) {
        const built = yield* buildResult(turn);
        if (params.resultOnly) return '';
        const delivered = toDeliveryResult(turn, params.runId);
        // The formatter is the one fallible step left here, and its throw is
        // this turn's failure — not a defect — exactly as it was when the
        // loop adopted this method's rejected promise.
        cachedDelivery = yield* Effect.try({
          try: () =>
            formatSubagentDelivery(
              params.agentName,
              { outcome: delivered.outcome, output: built.output },
              {
                runId: params.runId,
                memoryMisses: delivered.memoryMisses,
                wallTimeMs: built.wallTimeMs,
                workingDirectory: params.workingDirectory,
              },
            ),
          catch: ensureError,
        });
      }
      return cachedDelivery;
    }),

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

    buildResultMeta: (turn, isError) =>
      Effect.gen(function* () {
        if (isError || turn === null) {
          // Overwrite any interim success manifest from an earlier turn: the
          // failed run's own output, or its category's empty one when the
          // turn produced none.
          const result = turn
            ? toDeliveryResult(turn, params.runId)
            : lastResult;
          return buildSubagentResultMeta(
            params.agentName,
            result?.output ??
              emptyRunEndOutput(params.definition.config.agentCategory),
            Date.now() - params.startedAt,
          );
        }
        return yield* buildResult(turn);
      }),
  };
}
