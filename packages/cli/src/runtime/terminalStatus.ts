import { Effect } from 'effect';

import { getRunRecords } from '@agent/storage';
import type { SessionHandle, runAgent } from '@agent/runtime';
import {
  RUN_OUTCOME,
  type RunOutcome,
  RUN_PHASE,
  type ToolUseRunEndOutputSchema,
} from '@shared/schemas';
import { runOutcomeToCliRunStatus } from '@shared/runs/runStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { CliExitCode } from './exitCodes';
import type { z } from 'zod';

export type ExecuteAgentResult = Effect.Success<ReturnType<typeof runAgent>>;

interface CliRunResultMetadata {
  readonly workingDirectory?: string;
  readonly runDirectory?: string;
  readonly copiedOutput?: string;
  readonly copiedOutputs?: string[];
}

// Intersecting distributes over the runAgent result union, attaching the
// CLI-only metadata fields to every member.
export type CliRunResult = ExecuteAgentResult & CliRunResultMetadata;

export type CliToolUseRunResult = CliRunResult & {
  readonly output: z.infer<typeof ToolUseRunEndOutputSchema>;
};

/**
 * The 0.40 wire's result payload: the run's result with its id under the key
 * the frozen `agent-result` / `result` records promised (`executionId`). The
 * internal result carries `runId`; this projection is the only place the old
 * key is spelled, until S5 versions the CLI contract.
 */
export function cliRunResultPayload<R extends { readonly runId: string }>(
  result: R,
): Omit<R, 'runId'> & { readonly executionId: string } {
  const { runId, ...rest } = result;
  return { ...rest, executionId: runId };
}

/** Display text for a finished tool-use run: the last response if present,
 *  otherwise a terse status/run-id summary. */
export function toolUseResultText(result: CliToolUseRunResult): string {
  return (
    result.output.response.trim() ||
    `${runOutcomeToCliRunStatus(result.outcome)}\nExecution: ${result.runId}`
  );
}

/** Terminal state of a CLI turn: a run outcome, or a resumed subagent parked
 *  back to WAITING (a successfully completed turn, not a finished agent). */
export type TurnOutcome = RunOutcome | typeof RUN_PHASE.WAITING;

/** Map a run outcome to the CLI process exit code. A resumed subagent that
 *  parks back to WAITING is a successfully completed turn.
 *
 *  A denied approval gate never reaches this mapping. The gate returns feedback
 *  to the model, which routes around it, so a denial is not a run outcome at
 *  all — it has no dedicated exit code. An earlier design gave it one, which
 *  made callers that treat a nonzero exit as "did not produce a result" discard
 *  perfectly good runs; TeXRA's own PR review workflow was among them. */
export function runOutcomeExitCode(outcome: TurnOutcome): CliExitCode {
  if (outcome === RUN_OUTCOME.CANCELLED) {
    return CliExitCode.Interrupted;
  }
  if (outcome === RUN_OUTCOME.FAILED) {
    return CliExitCode.AgentError;
  }
  return CliExitCode.Success;
}

/** Read the terminal outcome together with the durability fact needed before
 *  advertising persisted-run recovery. */
export const readCliRunOutcomeState = Effect.fn('readCliRunOutcomeState')(
  function* (
    session: SessionHandle,
    result: ExecuteAgentResult,
    reportReadFailure?: (error: Error) => void,
  ): Effect.fn.Return<{ outcome: RunOutcome; outcomePersisted: boolean }> {
    return yield* getRunRecords(session, result.runId)
      .readMeta()
      .pipe(
        Effect.map((meta) => ({
          outcome: meta?.outcome ?? result.outcome,
          outcomePersisted: meta?.outcome !== undefined,
        })),
        Effect.catch((error) =>
          Effect.sync(() => {
            reportReadFailure?.(
              new Error(
                `Could not verify the persisted outcome for run ${result.runId}; using the current run outcome: ${toErrorMessage(error)}`,
                { cause: error },
              ),
            );
            return { outcome: result.outcome, outcomePersisted: false };
          }),
        ),
      );
  },
);
