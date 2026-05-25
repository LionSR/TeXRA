import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentEntry } from '@agent/index';
import type { AgentConfigPayload } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { OutputFileSummary } from '@agent/runtime/AgentFlowResult';
import { getSafeDocumentRelativePath } from '@agent/utils/outputFileUtils';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';
import { getRunDir } from '@utils/files';

import {
  cliTerminalStatus,
  createCliRunResult,
  type CliRunResult,
  type ExecuteAgentResult,
} from './terminalStatus';

/** Resolve a user-supplied path against `cwd` when it isn't already absolute. */
function joinCwdRelative(target: string, cwd: string): string {
  return path.isAbsolute(target) ? target : path.join(cwd, target);
}

/**
 * Stat `target` for the output-path guards. Returns `null` when the path
 * doesn't exist yet (the workflow will create it). `ENOTDIR` (a parent path
 * component is a file) is surfaced as a Usage error here so callers don't
 * have to repeat it. Other stat errors propagate with their real cause.
 */
async function probeOutputPath(
  target: string,
  flagLabel: '--output' | '--output-dir',
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) return null;
    if (isNotADirectoryError(error)) {
      throw new CliUsageError(
        flagLabel === '--output-dir'
          ? `--output-dir is not a directory (a parent path component is a file): ${target}`
          : `--output: a parent path component is a file: ${target}`,
      );
    }
    throw error;
  }
}

/** `--output-dir <path>` must point at a directory (or not exist yet). */
export async function assertOutputDirAvailable(
  outputDir: string | undefined,
  cwd: string,
): Promise<void> {
  if (!outputDir) return;
  const target = joinCwdRelative(outputDir, cwd);
  const stats = await probeOutputPath(target, '--output-dir');
  if (stats && !stats.isDirectory()) {
    throw new CliUsageError(`--output-dir is not a directory: ${target}`);
  }
}

/** `--output <path>` must end at a writable file path (or not exist yet). */
export async function assertOutputFileAvailable(
  outputFile: string | undefined,
  cwd: string,
): Promise<void> {
  if (!outputFile) return;
  const target = joinCwdRelative(outputFile, cwd);
  const stats = await probeOutputPath(target, '--output');
  if (stats?.isDirectory()) {
    throw new CliUsageError(
      `--output is a directory; use --output-dir or pick a file path: ${target}`,
    );
  }
}

export type CliWorkflowRunResult = Extract<
  CliRunResult,
  { category: 'workflow' }
>;

export interface WorkflowOutputResolutionOptions {
  readonly expectedOutputFiles?: readonly string[];
  readonly runDirectory?: string;
  readonly terminalStatus?: ExecutionStatus;
}

function outputCopyRelativePath(output: OutputFileSummary): string {
  const relativePath =
    output.relativePath || path.basename(output.absolutePath);
  const parts = relativePath.replaceAll('\\', '/').split('/');
  const withoutRoundDir = /^r\d+$/.test(parts[0] ?? '')
    ? parts.slice(1)
    : parts;
  return getSafeDocumentRelativePath(withoutRoundDir.join('/'));
}

function expectedOutputCopyRelativePath(outputFile: string): string {
  return getSafeDocumentRelativePath(outputFile);
}

export function expectedOutputFilesForOutputDir(
  agent: AgentEntry | undefined,
  inputFiles: readonly string[],
): readonly string[] {
  const defaultOutputFiles = (agent?.defaultOutputFiles ?? []).filter(Boolean);
  return defaultOutputFiles.length > 0 ? defaultOutputFiles : inputFiles;
}

function shouldUseOutputForCopy(
  existing: OutputFileSummary | undefined,
  candidate: OutputFileSummary,
): boolean {
  return existing == null || candidate.round > existing.round;
}

function latestWorkflowOutput(
  outputs: readonly OutputFileSummary[],
): OutputFileSummary | undefined {
  let latest: OutputFileSummary | undefined;
  for (const output of outputs) {
    if (latest == null || output.round >= latest.round) {
      latest = output;
    }
  }
  return latest;
}

export async function resolveWorkflowOutput(
  outputFile: string | undefined,
  outputDir: string | undefined,
  result: ExecuteAgentResult,
  context: CliContext,
  options: WorkflowOutputResolutionOptions = {},
): Promise<{
  copiedOutput: string | undefined;
  displayResult: CliRunResult;
}> {
  const terminalStatus = options.terminalStatus ?? cliTerminalStatus(result);
  if (
    result.category === AgentCategory.Workflow &&
    result.outputs.length === 0 &&
    (outputFile || outputDir)
  ) {
    if (terminalStatus === EXECUTION_STATUS.INTERRUPTED) {
      return {
        copiedOutput: undefined,
        displayResult: createCliRunResult(result, terminalStatus),
      };
    }
    if (outputDir) {
      throw new Error(
        `Workflow ${terminalStatus} without generated outputs; nothing was copied to ${outputDir}.`,
      );
    }
    if (outputFile) {
      throw new Error(
        `Workflow ${terminalStatus} without a generated output; ${outputFile} was not written.`,
      );
    }
  }

  const runDirectory =
    result.category === AgentCategory.Workflow
      ? (options.runDirectory ?? getRunDir(result.executionId))
      : undefined;
  if (outputDir && result.category === AgentCategory.Workflow) {
    const targetRoot = joinCwdRelative(outputDir, context.cwd);
    const outputsByRelativePath = new Map<string, OutputFileSummary>();
    for (const output of result.outputs) {
      const relativePath = outputCopyRelativePath(output);
      if (
        shouldUseOutputForCopy(outputsByRelativePath.get(relativePath), output)
      ) {
        outputsByRelativePath.set(relativePath, output);
      }
    }

    const copiedOutputs: string[] = [];
    for (const [relativePath, output] of outputsByRelativePath) {
      const targetPath = path.join(targetRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(output.absolutePath, targetPath);
      copiedOutputs.push(targetPath);
    }

    const expectedOutputFiles = options.expectedOutputFiles ?? [];
    const missing = expectedOutputFiles
      .map(expectedOutputCopyRelativePath)
      .filter((expected) => !outputsByRelativePath.has(expected));
    if (missing.length > 0) {
      throw new Error(
        `Workflow ${terminalStatus} without expected output${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}; copied ${copiedOutputs.length} of ${expectedOutputFiles.length} expected output${expectedOutputFiles.length === 1 ? '' : 's'} to ${targetRoot}.`,
      );
    }

    const displayResult = createCliRunResult(result, terminalStatus, {
      runDirectory,
      copiedOutputs,
    });
    return { copiedOutput: undefined, displayResult };
  }

  if (!outputFile || result.category !== AgentCategory.Workflow) {
    return {
      copiedOutput: undefined,
      displayResult: createCliRunResult(result, terminalStatus, {
        runDirectory,
      }),
    };
  }

  const finalOutput = latestWorkflowOutput(result.outputs);
  if (!finalOutput) {
    return {
      copiedOutput: undefined,
      displayResult: createCliRunResult(result, terminalStatus, {
        runDirectory,
      }),
    };
  }

  const targetPath = joinCwdRelative(outputFile, context.cwd);
  if (path.resolve(finalOutput.absolutePath) !== path.resolve(targetPath)) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(finalOutput.absolutePath, targetPath);
  }

  const displayResult = createCliRunResult(result, terminalStatus, {
    runDirectory,
    copiedOutput: targetPath,
  });
  return { copiedOutput: targetPath, displayResult };
}

export function formatWorkflowTextResult(result: CliWorkflowRunResult): string {
  if (result.copiedOutputs?.length) {
    return result.copiedOutputs.join('\n');
  }
  if (result.copiedOutput) {
    return result.copiedOutput;
  }

  const finalOutput = result.outputs.at(-1);
  return finalOutput?.absolutePath ?? result.runDirectory ?? result.status;
}

export function resumeWorkflowOutputFile(
  config: AgentConfigPayload,
): string | undefined {
  if (config.agentCategory !== AgentCategory.Workflow) return undefined;

  const resolveStoredOutputFile = (outputFile: string | undefined | null) => {
    const trimmed = outputFile?.trim();
    if (!trimmed) return undefined;
    if (path.isAbsolute(trimmed)) return trimmed;

    const workingDirectory = config.workingDirectory?.trim();
    return workingDirectory ? path.join(workingDirectory, trimmed) : trimmed;
  };

  const cliOutputFile = resolveStoredOutputFile(config.cliOutputFile);
  if (cliOutputFile) return cliOutputFile;

  const outputFiles = config.outputFiles ?? [];
  return outputFiles.length === 1
    ? resolveStoredOutputFile(outputFiles[0])
    : undefined;
}
