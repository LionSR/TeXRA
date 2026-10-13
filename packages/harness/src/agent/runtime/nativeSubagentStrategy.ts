/**
 * Native children keep one engine scope and report each completed turn to the
 * shared child-run driver. The driver owns admission, accounting and delivery;
 * this strategy owns native launch options and result formatting.
 */

import { Effect } from 'effect';

import { type RunEndResult } from '@agent/runtime/RunEndResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ExecuteAgentOptions } from '@agent/runtime/executeAgent';
import type { RegisterRunOptions } from '@agent/storage/runLifecycle';
import {
  registryOf,
  type AgentRunServices,
  Runs,
} from '@agent/runtime/runRegistry';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type { PreparedAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import {
  emptyRunEndOutput,
  type OfferedTool,
  RUN_OUTCOME,
  type RunId,
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
 * The launch fields every native child run needs, shared between the two
 * native subagent callers — durable in-band (`InBandSubagentRunBaseOptions`)
 * and detached (`NativeSubagentStrategyParams`) — so a new launch option has a
 * single home and can't drift between the two interfaces or the executeInBand
 * field mapping.
 */
export interface ChildRunLaunchOptions {
  /** The launching run: the child's parent edge. */
  readonly parentRunId: RunId;
  readonly session: SessionHandle;
  /**
   * What the parent's step offered, which a fresh child can only narrow; a
   * resumed child is held to its own record.
   */
  readonly parentOffered?: readonly OfferedTool[];
  /** The child's admission (`ExecuteAgentOptions.onAdmitted`). */
  readonly onAdmitted?: ExecuteAgentOptions['onAdmitted'];
}

interface NativeSubagentStrategyBase extends ChildRunLaunchOptions {
  readonly runId: RunId;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  /** An awaited call's child: it ends after one cycle, fresh or resumed,
   *  and its report is persisted, not delivered: its caller reads it. */
  readonly inBand?: true;
}

type NativeSubagentStrategyParams = NativeSubagentStrategyBase &
  (
    | {
        readonly definition: PreparedAgentDefinition;
        /** The child's registration, which its opening commits. */
        readonly registration: RegisterRunOptions;
        readonly resume?: never;
        readonly parentOffered: readonly OfferedTool[];
      }
    | {
        readonly definition?: never;
        readonly resume: {
          readonly identity: import('@agent/runtime/executeAgent').ResumeTurnIdentity;
          readonly options: import('@agent/runtime/executeAgent').ResumeToolUseFromResumeDataOptions;
        };
      }
  );

export function createNativeSubagentStrategy(
  params: NativeSubagentStrategyParams,
): ChildRunStrategy<RunEndResult, AgentRunServices> {
  const config = params.definition
    ? params.definition.config
    : params.resume.identity.agentConfig;
  // A child's provider/runtime failure rides its turn's `error`
  // (`runWithLifecycle` returns a terminal failed result rather than
  // rejecting); a thrown call reaches `formatError` as its `err`.
  let lastResult: RunEndResult | undefined;
  // Result construction computes and persists diffs, so every consumer of a
  // turn shares one result. Formatting remains separate: if it throws, the
  // already-built result manifest is still available for persistence.
  let cachedBuilt: SubagentResultMeta | undefined;
  let cachedDelivery: string | undefined;

  // Adopt `turn` as the latest result and drop the caches derived from the
  // prior one: the next build/delivery recomputes from this turn. Every point
  // that advances the turn must clear both caches together, so they live here
  // once rather than at each site.
  const recordTurn = (turn: RunEndResult | undefined): void => {
    lastResult = turn;
    cachedBuilt = undefined;
    cachedDelivery = undefined;
  };

  const runNative = Effect.fn('nativeSubagent.runTurn')(function* (
    call: Effect.Effect<RunEndResult, Error, AgentRunServices>,
  ) {
    recordTurn(undefined);
    return yield* call.pipe(
      Effect.tap((result) => Effect.sync(() => recordTurn(result))),
    );
  });

  const buildResult = Effect.fn('nativeSubagent.buildResult')(function* (
    turn: RunEndResult,
  ) {
    if (!cachedBuilt) {
      cachedBuilt = yield* buildSubagentResult(
        params.runId,
        turn.output,
        params.session.roots.storage,
      );
    }
    return cachedBuilt;
  });

  return {
    // Not used as a trace stage for native delegation (the loop gates
    // `logger.openStage` on `childRun`, which native delegation never
    // passes) — its only reader is the loop's non-throwing-failure message,
    // which becomes the persisted terminal `error.message` for the run
    // record.
    stageLabel: config.script == null ? 'Native subagent' : 'Native recipe run',

    // An awaited child has no later turn to consume a follow-up delivery;
    // its awaiting caller reads the persisted report/result instead.
    ...(params.inBand === true && {
      deliveryMode: 'persistOnly' as const,
    }),

    continuous: true,
    launch: (ports, _signal, turns) =>
      runNative(
        Effect.gen(function* () {
          const { programs } = registryOf(yield* Runs);
          const executeOptions: Omit<ExecuteAgentOptions, 'registration'> = {
            ...params.resume?.options,
            session: params.session,
            parentOffered: params.parentOffered,
            onAdmitted: params.onAdmitted,
            onProgress: (update) => ports.notify(update),
            ...(params.inBand === true && { stopAfterCycle: true }),
            turns: {
              turnPermit: turns.turnPermit,
              settleBoundary: (turn: RunEndResult) =>
                Effect.suspend(() => {
                  recordTurn(turn);
                  return turns.settleBoundary(turn);
                }),
              settleEnd: (turn: RunEndResult) =>
                Effect.suspend(() => {
                  recordTurn(turn);
                  return turns.settleEnd(turn);
                }),
            },
          };
          if (params.resume)
            return yield* programs.resumeTurn(
              params.resume.identity,
              executeOptions,
            );
          const turn = yield* programs.executeAgent(
            params.definition,
            params.runId,
            {
              ...executeOptions,
              registration: params.registration,
              // The live handle owns this edge, including a later detach.
              parentRunId: params.parentRunId,
            },
          );
          return turn;
        }),
      ),

    isTerminal: () => true,
    isTurnInterrupted: (turn) =>
      params.inBand !== true && turn.outcome === RUN_OUTCOME.CANCELLED,
    isTurnError: (turn) => turn.error !== undefined,

    formatDelivery: Effect.fn('nativeSubagent.formatDelivery')(function* (
      turn: RunEndResult,
      /** The turn's wall time, measured by the loop before this result
       *  computes its diffs. */
      wallTimeMs: number,
    ) {
      if (cachedDelivery === undefined) {
        const built = yield* buildResult(turn);
        // The formatter is the one fallible step left here, and its throw is
        // this turn's failure — not a defect — exactly as it was when the
        // loop adopted this method's rejected promise.
        cachedDelivery = yield* Effect.try({
          try: () =>
            formatSubagentDelivery(
              config.agent,
              { outcome: turn.outcome, output: built.output },
              {
                runId: params.runId,
                memoryMisses: turn.memoryMisses,
                wallTimeMs,
                workingDirectory: params.workingDirectory,
              },
            ),
          catch: ensureError,
        });
      }
      return cachedDelivery;
    }),

    formatError: (turn, err) => {
      const wallTimeMs = Date.now() - params.startedAt;
      const result = turn ?? lastResult;
      return formatSubagentError(
        params.runId,
        config.agent,
        turn?.error ?? normalizeProviderError(err),
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
          // failed run's own output, or an empty one when the turn produced
          // none.
          const result = turn ?? lastResult;
          return buildSubagentResultMeta(result?.output ?? emptyRunEndOutput());
        }
        return yield* buildResult(turn);
      }),
  };
}
