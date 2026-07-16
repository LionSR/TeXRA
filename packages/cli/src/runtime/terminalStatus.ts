import { getExecutionStore } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';
import type { AgentRuntimeFlowResult } from '@agent/runtime/AgentFlowResult';
import {
  type ExecutionStatus,
  RUN_OUTCOME,
  type RunOutcome,
} from '@shared/schemas';
import {
  legacyEndGroupStatusForOutcome,
  runOutcomeToExecutionStatus,
} from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { hasCliApprovalDenied } from './approvalAdapter';
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

// Announced during v0.39; keep through v0.40 and remove in v0.41.
type PublishedCliRunResultFor<T extends ExecuteAgentResult> = T & {
  /** @deprecated Use `outcome`; this is a frozen projection for JSON-output compatibility. */
  status: ExecutionStatus;
  /** @deprecated Use `outcome`; this is a frozen 2-value projection for JSON-output compatibility. */
  endGroupStatus: 'error' | 'stopped';
  /** @deprecated Use `outcome`; this is a frozen projection for JSON-output compatibility. */
  terminalStatus: ExecutionStatus;
} & CliRunResultMetadata;

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
    result.lastResponse?.trim() ||
    `${runOutcomeToExecutionStatus(result.outcome)}\nExecution: ${result.executionId}`
  );
}

/** Add legacy status fields through the v0.40 compatibility window. */
export function serializeCliRunResult<T extends ExecuteAgentResult>(
  result: CliRunResultFor<T>,
): T extends ExecuteAgentResult ? PublishedCliRunResultFor<T> : never {
  const {
    workingDirectory,
    runDirectory,
    copiedOutput,
    copiedOutputs,
    ...executionResult
  } = result;
  const terminalStatus = runOutcomeToExecutionStatus(result.outcome);
  return {
    ...executionResult,
    status: terminalStatus,
    endGroupStatus: legacyEndGroupStatusForOutcome(result.outcome),
    terminalStatus,
    ...(Object.hasOwn(result, 'workingDirectory') ? { workingDirectory } : {}),
    ...(Object.hasOwn(result, 'runDirectory') ? { runDirectory } : {}),
    ...(Object.hasOwn(result, 'copiedOutput') ? { copiedOutput } : {}),
    ...(Object.hasOwn(result, 'copiedOutputs') ? { copiedOutputs } : {}),
  } as T extends ExecuteAgentResult ? PublishedCliRunResultFor<T> : never;
}

/** Map a run outcome to the CLI process exit code, treating an
 *  approval-denied error distinctly from a generic agent error. A resumed
 *  subagent that parks back to WAITING is a successfully completed turn. */
export function runOutcomeExitCode(
  outcome: AgentRuntimeFlowResult['outcome'],
  context: CliContext,
): CliExitCode {
  if (outcome === RUN_OUTCOME.FAILED) {
    return hasCliApprovalDenied(context)
      ? CliExitCode.ApprovalDenied
      : CliExitCode.AgentError;
  }
  if (outcome === RUN_OUTCOME.CANCELLED) {
    return CliExitCode.Interrupted;
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
