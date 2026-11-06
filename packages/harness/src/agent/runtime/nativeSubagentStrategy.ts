/**
 * Native children keep one engine scope and report each completed turn to the
 * shared child-run driver. The driver owns admission, accounting and delivery;
 * this strategy owns native launch options and result formatting.
 */

import { Effect } from 'effect';

import { type RunReport } from '@agent/runtime/runReport';
import type { ExecuteAgentOptions } from '@agent/runtime/executeAgent';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  registryOf,
  type AgentRunServices,
  Runs,
} from '@agent/runtime/runRegistry';
import type { NativeChildStrategy } from '@agent/runtime/childRunLoop';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { SessionRoots } from '@platform/rootedFs';
import type { RegisterRunOptions } from '@shared/session/runFacts';
import type { SessionLog } from '@shared/session/runHistory';
import { emptyRunEndOutput, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { readRecipeResult } from './recipeResult';
import { formatSubagentDelivery, formatSubagentError } from './subagentResults';

/**
 * The launch fields every native child run needs, shared between the two
 * native subagent callers — durable in-band (`InBandSubagentRunBaseOptions`)
 * and detached (`NativeSubagentStrategyParams`) — so a new launch option has a
 * single home and can't drift between the two interfaces or the executeInBand
 * field mapping. The child's parent is not one: a fresh child's is its
 * registration's, a resumed one's its rows'.
 */
export interface ChildRunLaunchOptions {
  /** The history a fresh child is born on: a fork's (`forkSeed`). */
  readonly seed?: RegisterRunOptions['seed'];
}

interface NativeSubagentStrategyBase extends ChildRunLaunchOptions {
  readonly runId: RunId;
  readonly startedAt: number;
  readonly workingDirectory?: string;
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
        /** A persisted child, resumed under its stored config with the
         *  parent its rows hold (`parent`), read as its run starts, under
         *  the claim its loop holds. */
        readonly resume: Pick<ExecuteAgentOptions, 'tools'> & {
          readonly config: AgentConfig;
          readonly parent: Effect.Effect<RunId | undefined, Error, SessionLog>;
          readonly stopAfterCycle?: boolean;
        };
      }
  );

export function createNativeSubagentStrategy(
  params: NativeSubagentStrategyParams,
): NativeChildStrategy<RunReport, AgentRunServices> {
  const config = params.definition
    ? params.definition.config
    : params.resume.config;
  // A child's provider/runtime failure rides its report's `failure`
  // (`endRun` returns a terminal failed result rather than rejecting); a
  // thrown call reaches `formatError` as its `err`.
  let lastResult: RunReport | undefined;

  const runNative = Effect.fn('nativeSubagent.runTurn')(function* (
    call: Effect.Effect<RunReport, Error, AgentRunServices>,
  ) {
    lastResult = undefined;
    return yield* call.pipe(
      Effect.tap((result) => Effect.sync(() => (lastResult = result))),
    );
  });

  return {
    // Not used as a trace stage for native delegation (the loop gates
    // `logger.openStage` on `childRun`, which native delegation never
    // passes) — its only reader is the loop's message for a failed turn
    // that carries no message of its own (`turnErrorMessage`).
    stageLabel: config.script == null ? 'Native subagent' : 'Native recipe run',

    prepare: (notify, turns) =>
      Effect.gen(function* () {
        const { programs } = registryOf(yield* Runs);
        const options = {
          onProgress: notify,
          turns: {
            turnPermit: turns.turnPermit,
            finishTurn: (turn: RunReport) =>
              Effect.suspend(() => {
                lastResult = turn;
                return turns.finishTurn(turn);
              }),
            finishLastTurn: (turn: RunReport) =>
              Effect.suspend(() => {
                lastResult = turn;
                return turns.finishLastTurn(turn);
              }),
          },
        };
        const prepared = params.resume
          ? yield* Effect.gen(function* () {
              const { config, parent, stopAfterCycle, ...launch } =
                params.resume;
              const definition = yield* prepareAgentDefinition({
                config,
                stopAfterCycle,
              });
              return yield* programs.executeAgent(definition, params.runId, {
                ...launch,
                ...options,
                parentRunId: yield* parent,
              });
            })
          : yield* programs.executeAgent(params.definition, params.runId, {
              ...options,
              registration: { ...params.registration, seed: params.seed },
            });
        return {
          activation: prepared.activation,
          run: runNative(prepared.run),
        };
      }),

    isTurnInterrupted: (turn) => turn.outcome === RUN_OUTCOME.CANCELLED,
    isTurnError: (turn) => turn.failure !== undefined,
    turnErrorMessage: (turn) => turn.failure?.message,

    formatDelivery: Effect.fn('nativeSubagent.formatDelivery')(function* (
      turn: RunReport,
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
              yield* SessionRoots,
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
        turn?.failure ?? normalizeProviderError(err),
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
