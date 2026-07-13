import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentEntry } from '@agent/index';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { getSafeDocumentRelativePath } from '@agent/utils/outputFileUtils';
import { runOutcomeToExecutionStatus } from '@common/constants/streamStatus';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { RUN_OUTCOME } from '@shared/schemas';
import type { OutputFileSummary } from '@shared/schemas/output';
import { parseWorkflowOutputRoundDir } from '@shared/constants/workflowOutput';
import { getRunDir } from '@utils/files';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since these paths come from getSafeDocumentRelativePath /
// path.relative on the workflow's own generated outputs, never user input.
import { toPosixPath } from '@utils/core/pathCore';

import { CliUsageError, type CliContext } from './cliContext';
import { type CliRunResult, type ExecuteAgentResult } from './terminalStatus';
import {
  isMaterializedStdinWorkflowInputPath,
  STDIN_WORKFLOW_INPUT_BASENAME,
} from './workflowInputs';

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
type WorkflowAgentResult = Extract<
  ExecuteAgentResult,
  { category: 'workflow' }
>;

interface WorkflowOutputResolutionOptions {
  readonly expectedOutputFiles?: readonly string[];
  readonly runDirectory?: string;
}

function outputCopyRelativePath(output: OutputFileSummary): string {
  const relativePath =
    output.relativePath || path.basename(output.absolutePath);
  const parts = toPosixPath(relativePath).split('/');
  const withoutRoundDir =
    parts[0] !== undefined && parseWorkflowOutputRoundDir(parts[0]) !== null
      ? parts.slice(1)
      : parts;
  return getSafeDocumentRelativePath(withoutRoundDir.join('/'));
}

function outputCopyRelativePathForExpectedOutput(
  output: OutputFileSummary,
  expectedRelativePaths: readonly string[],
): string {
  const generatedRelativePath = outputCopyRelativePath(output);
  if (expectedRelativePaths.length === 0) return generatedRelativePath;

  const generatedName = path.posix.basename(toPosixPath(generatedRelativePath));
  const normalizedOriginalPath =
    output.originalPath == null ? undefined : toPosixPath(output.originalPath);
  const matchingExpectedPaths =
    normalizedOriginalPath == null
      ? []
      : expectedRelativePaths.filter((expected) => {
          const normalizedExpected = toPosixPath(expected);
          if (path.posix.basename(normalizedExpected) !== generatedName) {
            return false;
          }
          return (
            normalizedOriginalPath === normalizedExpected ||
            normalizedOriginalPath.endsWith(`/${normalizedExpected}`)
          );
        });
  return matchingExpectedPaths.length === 1
    ? matchingExpectedPaths[0]
    : generatedRelativePath;
}

function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const root = path.parse(paths[0]!).root;
  const [first, ...rest] = paths.map((file) =>
    path.resolve(file).split(path.sep),
  );
  let sharedLength = first.length;
  for (const parts of rest) {
    sharedLength = Math.min(sharedLength, parts.length);
    while (
      sharedLength > 0 &&
      first.slice(0, sharedLength).join(path.sep) !==
        parts.slice(0, sharedLength).join(path.sep)
    ) {
      sharedLength -= 1;
    }
  }
  return first.slice(0, Math.max(1, sharedLength)).join(path.sep) || root;
}

function expectedInputOutputFiles(
  inputFiles: readonly string[],
): readonly string[] {
  const absoluteInputs = inputFiles
    .filter((input) => path.isAbsolute(input))
    .map((input) => path.resolve(input));
  const absoluteRoot = commonDirectory(absoluteInputs.map(path.dirname));

  return inputFiles.map((input) => {
    if (isMaterializedStdinWorkflowInputPath(input)) {
      return STDIN_WORKFLOW_INPUT_BASENAME;
    }
    if (!path.isAbsolute(input)) return getSafeDocumentRelativePath(input);
    return getSafeDocumentRelativePath(path.relative(absoluteRoot, input));
  });
}

export function expectedOutputFilesForOutputDir(
  agent: AgentEntry | undefined,
  inputFiles: readonly string[],
): readonly string[] {
  const defaultOutputFiles = (agent?.defaultOutputFiles ?? []).filter(Boolean);
  return defaultOutputFiles.length > 0
    ? defaultOutputFiles
    : expectedInputOutputFiles(inputFiles);
}

function latestWorkflowOutput(
  outputs: readonly OutputFileSummary[],
): OutputFileSummary | undefined {
  // `>=` keeps the later element on a round tie, matching the prior loop.
  return outputs.reduce<OutputFileSummary | undefined>(
    (latest, output) =>
      latest == null || output.round >= latest.round ? output : latest,
    undefined,
  );
}

export async function resolveWorkflowOutput(
  outputFile: string | undefined,
  outputDir: string | undefined,
  result: WorkflowAgentResult,
  context: CliContext,
  options: WorkflowOutputResolutionOptions,
): Promise<CliWorkflowRunResult> {
  const terminalStatus = runOutcomeToExecutionStatus(result.outcome);
  if (result.outputs.length === 0 && (outputFile || outputDir)) {
    if (result.outcome === RUN_OUTCOME.CANCELLED) {
      return {
        ...result,
        workingDirectory: context.cwd,
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

  const runDirectory = options.runDirectory ?? getRunDir(result.executionId);
  if (outputDir) {
    const targetRoot = joinCwdRelative(outputDir, context.cwd);
    const expectedRelativePaths = (options.expectedOutputFiles ?? []).map(
      (file) => getSafeDocumentRelativePath(file),
    );
    const outputsByRelativePath = new Map<string, OutputFileSummary>();
    for (const output of result.outputs) {
      const relativePath = outputCopyRelativePathForExpectedOutput(
        output,
        expectedRelativePaths,
      );
      const existing = outputsByRelativePath.get(relativePath);
      if (existing == null || output.round > existing.round) {
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

    const missing = expectedRelativePaths.filter(
      (expected) => !outputsByRelativePath.has(expected),
    );
    if (missing.length > 0) {
      throw new Error(
        `Workflow ${terminalStatus} without expected output${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}; copied ${copiedOutputs.length} of ${expectedRelativePaths.length} expected output${expectedRelativePaths.length === 1 ? '' : 's'} to ${targetRoot}.`,
      );
    }

    return {
      ...result,
      workingDirectory: context.cwd,
      runDirectory,
      copiedOutputs,
    };
  }

  if (!outputFile) {
    return {
      ...result,
      workingDirectory: context.cwd,
      runDirectory,
    };
  }

  const finalOutput = latestWorkflowOutput(result.outputs);
  if (!finalOutput) {
    return {
      ...result,
      workingDirectory: context.cwd,
      runDirectory,
    };
  }

  const targetPath = joinCwdRelative(outputFile, context.cwd);
  if (path.resolve(finalOutput.absolutePath) !== path.resolve(targetPath)) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(finalOutput.absolutePath, targetPath);
  }

  return {
    ...result,
    workingDirectory: context.cwd,
    runDirectory,
    copiedOutput: targetPath,
  };
}

export function formatWorkflowTextResult(result: CliWorkflowRunResult): string {
  if (result.copiedOutputs?.length) {
    return result.copiedOutputs.join('\n');
  }
  if (result.copiedOutput) {
    return result.copiedOutput;
  }

  const finalOutput = result.outputs.at(-1);
  return (
    finalOutput?.absolutePath ??
    result.runDirectory ??
    runOutcomeToExecutionStatus(result.outcome)
  );
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
