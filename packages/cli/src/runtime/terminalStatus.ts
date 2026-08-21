import { getExecutionStore } from '@agent/storage';
import { runAgent } from '@agent/runtime';
import { RUN_OUTCOME, type RunOutcome, STREAM_PHASE } from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { CliExitCode } from './exitCodes';

export type ExecuteAgentResult = Awaited<ReturnType<typeof runAgent>>;

interface CliRunResultMetadata {
  readonly workingDirectory?: string;
  readonly runDirectory?: string;
  readonly copiedOutput?: string;
  readonly copiedOutputs?: string[];
}

// Intersecting distributes over the runAgent result union, attaching the
// CLI-only metadata fields to every member.
export type CliRunResult = ExecuteAgentResult & CliRunResultMetadata;

export type CliToolUseRunResult = Extract<
  CliRunResult,
  { category: 'toolUse' }
>;

/** Display text for a finished tool-use run: the last response if present,
 *  otherwise a terse status/execution-id summary. */
export function toolUseResultText(result: CliToolUseRunResult): string {
  return (
    result.response?.trim() ||
    `${runOutcomeToExecutionStatus(result.outcome)}\nExecution: ${result.executionId}`
  );
}

/** Terminal state of a CLI turn: a run outcome, or a resumed subagent parked
 *  back to WAITING (a successfully completed turn, not a finished agent). */
export type TurnOutcome = RunOutcome | typeof STREAM_PHASE.WAITING;

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
 *  advertising persisted-execution recovery. */
export async function readCliRunOutcomeState(
  result: ExecuteAgentResult,
  reportReadFailure?: (error: Error) => void,
): Promise<{ outcome: RunOutcome; outcomePersisted: boolean }> {
  try {
    const meta = await getExecutionStore(result.executionId).readMeta();
    const persistedOutcome = meta?.outcome;
    return {
      outcome:
        persistedOutcome === undefined ? result.outcome : persistedOutcome,
      outcomePersisted: persistedOutcome !== undefined,
    };
  } catch (error) {
    reportReadFailure?.(
      new Error(
        `Could not verify the persisted outcome for execution ${result.executionId}; using the current run outcome: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return { outcome: result.outcome, outcomePersisted: false };
  }
}
