/**
 * Native children keep one engine scope and report each completed turn to the
 * shared child-run driver. The driver owns admission, accounting and delivery;
 * this strategy owns native launch options and result formatting.
 */

import { Effect } from 'effect';

import { type RunEndResult } from '@agent/runtime/RunEndResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  ExecuteAgentOptions,
  ResumeToolUseFromResumeDataOptions,
  ResumeTurnIdentity,
} from '@agent/runtime/executeAgent';
import type { RegisterRunOptions } from '@agent/storage/runLifecycle';
import {
  registryOf,
  type AgentRunServices,
  Runs,
} from '@agent/runtime/runRegistry';
import type { NativeChildStrategy } from '@agent/runtime/childRunLoop';
import type { PreparedAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { emptyRunEndOutput, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { readRecipeResult } from './recipeResult';
import { formatSubagentDelivery, formatSubagentError } from './subagentResults';

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
  /** The child's admission (`ExecuteAgentOptions.onAdmitted`). */
  readonly onAdmitted?: ExecuteAgentOptions['onAdmitted'];
  /** The history a fresh child is born on: a fork's (`forkSeed`). */
  readonly seed?: RegisterRunOptions['seed'];
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
      }
    | {
        readonly definition?: never;
        readonly resume: {
          readonly identity: ResumeTurnIdentity;
          readonly options: ResumeToolUseFromResumeDataOptions;
        };
      }
  );

export function createNativeSubagentStrategy(
  params: NativeSubagentStrategyParams,
): NativeChildStrategy<RunEndResult, AgentRunServices> {
  const config = params.definition
    ? params.definition.config
    : params.resume.identity.agentConfig;
  // A child's provider/runtime failure rides its turn's `error`
  // (`runWithLifecycle` returns a terminal failed result rather than
  // rejecting); a thrown call reaches `formatError` as its `err`.
  let lastResult: RunEndResult | undefined;

  const runNative = Effect.fn('nativeSubagent.runTurn')(function* (
    call: Effect.Effect<RunEndResult, Error, AgentRunServices>,
  ) {
    lastResult = undefined;
    return yield* call.pipe(
      Effect.tap((result) => Effect.sync(() => (lastResult = result))),
    );
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

    launch: (notify, turns) =>
      runNative(
        Effect.gen(function* () {
          const { programs } = registryOf(yield* Runs);
          const executeOptions: Omit<ExecuteAgentOptions, 'registration'> = {
            ...params.resume?.options,
            session: params.session,
            onAdmitted: params.onAdmitted,
            onProgress: notify,
            ...(params.inBand === true && { stopAfterCycle: true }),
            turns: {
              turnPermit: turns.turnPermit,
              finishTurn: (turn: RunEndResult) =>
                Effect.suspend(() => {
                  lastResult = turn;
                  return turns.finishTurn(turn);
                }),
              finishLastTurn: (turn: RunEndResult) =>
                Effect.suspend(() => {
                  lastResult = turn;
                  return turns.finishLastTurn(turn);
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
              registration: { ...params.registration, seed: params.seed },
              // The live handle owns this edge, including a later detach.
              parentRunId: params.parentRunId,
            },
          );
          return turn;
        }),
      ),

    isTurnInterrupted: (turn) =>
      params.inBand !== true && turn.outcome === RUN_OUTCOME.CANCELLED,
    isTurnError: (turn) => turn.error !== undefined,

    formatDelivery: Effect.fn('nativeSubagent.formatDelivery')(function* (
      turn: RunEndResult,
      /** The turn's wall time, measured by the loop. */
      wallTimeMs: number,
    ) {
      // A completed recipe's value reads as its block says
      // (`AgentBlock.result`); a failed one is delivered as its failure.
      const recipe =
        turn.outcome === RUN_OUTCOME.COMPLETED
          ? yield* readRecipeResult(
              config,
              turn.output,
              params.runId,
              params.session.roots,
            )
          : undefined;
      // A formatter throw is this turn's failure, not a defect.
      return yield* Effect.try({
        try: () =>
          formatSubagentDelivery(
            config.agent,
            { outcome: turn.outcome, output: turn.output },
            {
              runId: params.runId,
              recipe,
              memoryMisses: turn.memoryMisses,
              wallTimeMs,
              workingDirectory: params.workingDirectory,
            },
          ),
        catch: ensureError,
      });
    }),

    formatError: (turn, err, wallTimeMs) => {
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
      Effect.sync(() => {
        // A failed turn overwrites any interim success manifest from an
        // earlier turn: the failed run's own output, or an empty one when
        // the turn produced none.
        const result = isError || turn === null ? (turn ?? lastResult) : turn;
        // The machine-readable counterpart of the XML delivery, persisted
        // beside the run's `run.end` row so later stages chain on its output
        // as data; how the run ended is the terminal fact's to say.
        return {
          producer: 'subagent' as const,
          output: result?.output ?? emptyRunEndOutput(),
        };
      }),
  };
}
