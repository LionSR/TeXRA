import { getExecutionStore } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';
import {
  type ExecutionStatus,
  RUN_OUTCOME,
  type RunOutcome,
} from '@shared/schemas';
import {
  legacyEndGroupStatusForOutcome,
  runOutcomeToExecutionStatus,
} from '@shared/streams/streamStatus';

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

export type PublishedCliRunResult = ExecuteAgentResult extends infer T
  ? T extends ExecuteAgentResult
    ? PublishedCliRunResultFor<T>
    : never
  : never;

/** Display text for a finished tool-use run: the last response if present,
 *  otherwise a terse status/execution-id summary. */
export function toolUseResultText(result: CliToolUseRunResult): string {
  return (
    result.lastResponse?.trim() ||
    `${runOutcomeToExecutionStatus(result.outcome)}\nExecution: ${result.executionId}`
  );
}

/** Add the frozen v0.40 status fields at the CLI serialization boundary. */
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
 *  approval-denied error distinctly from a generic agent error. */
export function runOutcomeExitCode(
  outcome: RunOutcome,
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
): Promise<RunOutcome> {
  const meta = await getExecutionStore(result.executionId).readMeta();
  return meta?.outcome ?? result.outcome;
}
