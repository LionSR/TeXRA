import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentEntry } from '@agent/index';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import {
  finalWorkflowOutput,
  RUN_OUTCOME,
  AgentCategory,
} from '@shared/schemas';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';
import type { OutputFileSummary } from '@shared/schemas/output';
import { parseWorkflowOutputRoundDir } from '@shared/constants/workflowOutput';
import { getSafeDocumentRelativePath } from '@utils/files/outputFileUtils';
import { getRunDir } from '@utils/files/runStorageFs';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since these paths come from getSafeDocumentRelativePath /
// path.relative on the workflow's own generated outputs, never user input.
import { toPosixPath } from '@utils/core/pathCore';
import { formatResultCount, pluralize } from '@utils/text/stringUtils';

import { CliUsageError, type CliContext } from './cliContext';
import { type CliRunResult, type ExecuteAgentResult } from './terminalStatus';
import {
  isMaterializedStdinWorkflowInputPath,
  STDIN_WORKFLOW_INPUT_BASENAME,
} from './workflowInputs';
import type { Stats } from 'node:fs';

/** Resolve a user-supplied path against `cwd` when it isn't already absolute. */
function joinCwdRelative(target: string, cwd: string): string {
  return path.isAbsolute(target) ? target : path.join(cwd, target);
}

type OutputPathStats = Pick<Stats, 'isDirectory'>;

type OutputFlag = '--output' | '--output-dir';

interface OutputPathProbeDependencies {
  readonly stat: (target: string) => Promise<OutputPathStats>;
  readonly mkdir: (
    target: string,
    options: { readonly recursive: true },
  ) => Promise<string | undefined>;
  readonly dirname: (target: string) => string;
}

const outputPathProbeDefaults: OutputPathProbeDependencies = {
  stat: fs.stat,
  mkdir: fs.mkdir,
  dirname: path.dirname,
};

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { readonly code?: string })?.code === 'EEXIST';
}

function parentFileUsageError(
  target: string,
  flagLabel: OutputFlag,
): CliUsageError {
  return new CliUsageError(
    flagLabel === '--output-dir'
      ? `--output-dir is not a directory (a parent path component is a file): ${target}`
      : `--output: a parent path component is a file: ${target}`,
  );
}

/**
 * Probe `target` and materialize the directory that the eventual output write
 * requires. Using the same recursive mkdir operation as the writer avoids
 * platform-specific ancestor traversal: it handles missing depth, Windows
 * ENOENT-through-file behavior, and symlink resolution natively.
 */
async function probeOutputPath(
  target: string,
  flagLabel: OutputFlag,
  dependencies: OutputPathProbeDependencies = outputPathProbeDefaults,
): Promise<OutputPathStats | null> {
  const { stat, mkdir, dirname } = dependencies;
  try {
    return await stat(target);
  } catch (error: unknown) {
    if (isNotADirectoryError(error)) {
      throw parentFileUsageError(target, flagLabel);
    }
    if (!isFileNotFoundError(error)) throw error;
  }

  const requiredDirectory =
    flagLabel === '--output-dir' ? target : dirname(target);
  try {
    await mkdir(requiredDirectory, { recursive: true });
  } catch (error: unknown) {
    if (isNotADirectoryError(error) || isAlreadyExistsError(error)) {
      throw parentFileUsageError(target, flagLabel);
    }
    if (isFileNotFoundError(error)) {
      throw new CliUsageError(
        flagLabel === '--output-dir'
          ? `--output-dir cannot be created: ${target}`
          : `--output parent directory cannot be created: ${target}`,
      );
    }
    throw error;
  }
  return null;
}

export { probeOutputPath as probeOutputPathForTests };

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
  const [first, ...rest] = paths.map((file) =>
    path.resolve(file).split(path.sep),
  );
  let sharedLength = 0;
  while (
    sharedLength < first.length &&
    rest.every((parts) => parts[sharedLength] === first[sharedLength])
  ) {
    sharedLength += 1;
  }
  return (
    first.slice(0, Math.max(1, sharedLength)).join(path.sep) ||
    path.parse(paths[0]!).root
  );
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

export async function resolveWorkflowOutput(
  outputFile: string | undefined,
  outputDir: string | undefined,
  result: WorkflowAgentResult,
  context: CliContext,
  options: WorkflowOutputResolutionOptions,
): Promise<CliWorkflowRunResult> {
  const runDirectory = options.runDirectory ?? getRunDir(result.executionId);
  if (result.outcome === RUN_OUTCOME.CANCELLED && (outputFile || outputDir)) {
    return {
      ...result,
      workingDirectory: context.cwd,
      runDirectory,
    };
  }
  const terminalStatus = runOutcomeToExecutionStatus(result.outcome);
  if (result.outputs.length === 0 && (outputFile || outputDir)) {
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
        `Workflow ${terminalStatus} without expected ${pluralize(missing.length, 'output')}: ${missing.join(', ')}; copied ${copiedOutputs.length} of ${formatResultCount(expectedRelativePaths.length, 'expected output')} to ${targetRoot}.`,
      );
    }

    return {
      ...result,
      workingDirectory: context.cwd,
      runDirectory,
      copiedOutputs,
    };
  }

  const finalOutput = finalWorkflowOutput(result.outputs);
  if (!outputFile || !finalOutput) {
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

  const finalOutput = finalWorkflowOutput(result.outputs);
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

  const resolveOutputFile = (outputFile: string | undefined | null) => {
    if (outputFile == null || outputFile.length === 0) return undefined;
    if (path.isAbsolute(outputFile)) return outputFile;
    const workingDirectory = config.workingDirectory;
    return workingDirectory
      ? path.join(workingDirectory, outputFile)
      : outputFile;
  };

  const cliOutputFile = config.cliOutputFile;
  if (cliOutputFile != null && cliOutputFile.length > 0) {
    if (!path.isAbsolute(cliOutputFile)) {
      throw new CliUsageError(
        `Stored workflow output file is not absolute: ${cliOutputFile}`,
      );
    }
    return cliOutputFile;
  }

  const outputFiles = config.outputFiles ?? [];
  return outputFiles.length === 1
    ? resolveOutputFile(outputFiles[0])
    : undefined;
}

export function resumeWorkflowOutputDirectory(
  config: AgentConfigPayload,
): string | undefined {
  if (config.agentCategory !== AgentCategory.Workflow) return undefined;

  const outputDirectory = config.cliOutputDirectory;
  if (outputDirectory == null || outputDirectory.length === 0) return undefined;
  if (!path.isAbsolute(outputDirectory)) {
    throw new CliUsageError(
      `Stored workflow output directory is not absolute: ${outputDirectory}`,
    );
  }
  return outputDirectory;
}
