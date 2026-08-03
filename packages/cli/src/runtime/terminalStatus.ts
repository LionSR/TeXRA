import { getExecutionStore } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';
import { RUN_OUTCOME, type RunOutcome, STREAM_PHASE } from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { hasCliApprovalDenied } from './approval/approvalPolicy';
import { CliExitCode } from './exitCodes';
import type { CliContext } from './cliContext';

export type ExecuteAgentResult = Awaited<ReturnType<typeof runAgent>>;

interface CliRunResultMetadata {
  readonly workingDirectory?: string;
  readonly runDirectory?: string;
  readonly copiedOutput?: string;
  readonly copiedOutputs?: string[];
}

type CliRunResultFor<T extends ExecuteAgentResult> = T & CliRunResultMetadata;

export type CliRunResult = ExecuteAgentResult extends infer T
  ? T extends ExecuteAgentResult
    ? CliRunResultFor<T>
    : never
  : never;

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

/** Map a run outcome to the CLI process exit code, treating an
 *  approval-denied error distinctly from a generic agent error. A resumed
 *  subagent that parks back to WAITING is a successfully completed turn. */
export function runOutcomeExitCode(
  outcome: RunOutcome | typeof STREAM_PHASE.WAITING,
  context: CliContext,
): CliExitCode {
  if (outcome === RUN_OUTCOME.CANCELLED) {
    return CliExitCode.Interrupted;
  }
  if (hasCliApprovalDenied(context)) return CliExitCode.ApprovalDenied;
  if (outcome === RUN_OUTCOME.FAILED) {
    return CliExitCode.AgentError;
  }
  return CliExitCode.Success;
}

export async function readCliRunOutcome(
  result: ExecuteAgentResult,
  reportReadFailure?: (error: Error) => void,
): Promise<RunOutcome> {
  try {
    const meta = await getExecutionStore(result.executionId).readMeta();
    return meta?.outcome ?? result.outcome;
  } catch (error) {
    reportReadFailure?.(
      new Error(
        `Could not verify the persisted outcome for execution ${result.executionId}; using the current run outcome: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return result.outcome;
  }
}
