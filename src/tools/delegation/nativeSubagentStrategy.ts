/**
 * Native children keep one engine scope and report each completed turn to the
 * shared child-run driver. The driver owns admission, accounting and delivery;
 * this strategy owns native launch options and result formatting.
 */

import { Effect } from 'effect';

import { type AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import { AgentEngine } from '@agent/runtime/AgentEngine';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ExecuteAgentOptions } from '@agent/runtime/executeAgent';
import type { AgentRunServices } from '@agent/runtime/runRegistry';
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
import { onAbort, unique } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import {
  buildSubagentResult,
  buildSubagentResultMeta,
  formatSubagentDelivery,
  formatSubagentError,
  type SubagentResultMeta,
} from './subagentResults';

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
  /** Caller cancellation for a durable in-band launch. */
  readonly signal?: AbortSignal;
  /** Fires with the resolved child run id — the caller inherits approvals onto it. */
  readonly onRunResolved?: (runId: RunId) => void;
}

interface NativeSubagentStrategyBase extends ChildRunLaunchOptions {
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

type NativeSubagentStrategyParams = NativeSubagentStrategyBase &
  (
    | { readonly definition: PreparedAgentDefinition; readonly resume?: never }
    | {
        readonly definition?: never;
        readonly resume: {
          readonly identity: import('@agent/runtime/executeAgent').ResumeTurnIdentity;
          readonly options: import('@agent/runtime/executeAgent').ResumeToolUseFromResumeDataOptions;
        };
      }
  );

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
): ChildRunStrategy<AgentFlowResult, AgentRunServices> {
  const config = params.definition
    ? params.definition.config
    : params.resume.identity.agentConfig;
  // Captured for the turn currently in flight; read once the call resolves.
  // `executeAgent` never rejects for a
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

  const runNative = Effect.fn('nativeSubagent.runTurn')(function* (
    ports: ChildRunPorts,
    signal: AbortSignal,
    call: (
      onRun: (handle: AgentRunHandle) => Effect.Effect<void>,
    ) => Effect.Effect<AgentFlowResult, Error, AgentRunServices>,
  ) {
    lastErr = undefined;
    lastResult = undefined;
    cachedBuilt = undefined;
    cachedDelivery = undefined;
    let detachAbort = (): void => {};
    return yield* call((handle) =>
      Effect.sync(() => {
        detachAbort();
        detachAbort = bindAbortSignals([params.signal, signal], handle);
      }),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          lastResult = result;
          cachedBuilt = undefined;
          cachedDelivery = undefined;
          ports.recordCost(result.usage?.totalCost);
        }),
      ),
      Effect.ensuring(Effect.sync(() => detachAbort())),
    );
  });

  const buildResult = Effect.fn('nativeSubagent.buildResult')(function* (
    turn: AgentFlowResult,
  ) {
    if (!cachedBuilt) {
      cachedBuilt = yield* buildSubagentResult(
        params.runId,
        params.agentName,
        turn.output,
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
      config.agentCategory === AgentCategory.ToolUse
        ? 'Native tool-use subagent'
        : 'Native workflow subagent',

    // A single-cycle child has no later turn to consume a follow-up delivery;
    // its awaiting caller reads the persisted report/result instead.
    ...(params.runMode === 'single-cycle' && {
      deliveryMode: 'persistOnly' as const,
    }),

    continuous: true,
    launch: (ports, signal, turns) =>
      runNative(ports, signal, (onRun) =>
        Effect.gen(function* () {
          const engine = yield* AgentEngine;
          const executeOptions: ExecuteAgentOptions & {
            session: SessionHandle;
          } = {
            ...params.resume?.options,
            session: params.session,
            approvalPromptsUnavailable: params.approvalPromptsUnavailable,
            onApprovalPolicyDenial: params.onApprovalPolicyDenial,
            onRunResolved: params.onRunResolved,
            onProgress: (update: Parameters<ChildRunPorts['notify']>[0]) =>
              ports.notify(update),
            onRunError: (err: unknown) => {
              lastErr = err;
            },
            onRun,
            turns: {
              run: (operation) =>
                Effect.suspend(() => {
                  lastErr = undefined;
                  return turns.run(operation);
                }),
              complete: (turn: AgentFlowResult) =>
                Effect.gen(function* () {
                  lastResult = turn;
                  cachedBuilt = undefined;
                  cachedDelivery = undefined;
                  ports.recordCost(turn.usage?.totalCost);
                  yield* turns.complete(turn);
                }),
            },
          };
          if (params.resume)
            return yield* engine.resumeToolUseFromResumeData(
              params.resume.identity,
              executeOptions,
            );
          const turn = yield* engine.executeAgent(
            params.definition,
            params.runId,
            {
              ...executeOptions,
              // The live handle owns this edge, including a later detach.
              parentRunId: params.parentRunId,
              ...(params.runMode === 'single-cycle'
                ? { stopAfterCycle: true }
                : {}),
            },
          );
          return turn;
        }),
      ),

    isTerminal: () => true,
    isTurnInterrupted: (turn) =>
      params.runMode !== 'single-cycle' &&
      turn.outcome === RUN_OUTCOME.CANCELLED,
    isTurnError: () => lastErr !== undefined,

    formatDelivery: Effect.fn('nativeSubagent.formatDelivery')(function* (
      turn: AgentFlowResult,
    ) {
      if (cachedDelivery === undefined) {
        const built = yield* buildResult(turn);
        if (params.resultOnly) return '';
        // The formatter is the one fallible step left here, and its throw is
        // this turn's failure — not a defect — exactly as it was when the
        // loop adopted this method's rejected promise.
        cachedDelivery = yield* Effect.try({
          try: () =>
            formatSubagentDelivery(
              params.agentName,
              { outcome: turn.outcome, output: built.output },
              {
                runId: params.runId,
                memoryMisses: turn.memoryMisses,
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
      const result = turn ?? lastResult;
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
          const result = turn ?? lastResult;
          return buildSubagentResultMeta(
            params.agentName,
            result?.output ?? emptyRunEndOutput(config.agentCategory),
            Date.now() - params.startedAt,
          );
        }
        return yield* buildResult(turn);
      }),
  };
}
