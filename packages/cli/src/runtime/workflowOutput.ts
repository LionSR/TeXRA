import * as path from 'node:path';

import { Effect, FileSystem, Path, PlatformError } from 'effect';

import { isNotADirectoryError } from '@common/errors';
import type { RunEndOutput } from '@shared/schemas';
import { isRecipeConfig, RUN_OUTCOME } from '@shared/schemas';
import { runOutcomeToCliRunStatus } from '@shared/runs/runStatus';
import { stripWorkflowRoundDir } from '@texra/shared/constants/workflowOutput';
import { getSafeDocumentRelativePath } from '@texra/utils/files/outputFileUtils';
import {
  documentsResultOf,
  finalWorkflowOutput,
  type DocumentsResult,
  type OutputFileSummary,
} from '@texra/shared/plugins/documentOutputs';
import { runDirUnder } from '@utils/files/runStorageFs';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since these paths come from getSafeDocumentRelativePath /
// path.relative on the workflow's own generated outputs, never user input.
import { toPosixPath } from '@utils/core/pathCore';
import {
  formatResultCount,
  isNonEmptyString,
  pluralize,
} from '@utils/text/stringUtils';

import { CliUsageError, type CliContext } from './cliContext';
import { type CliRunResult } from './terminalStatus';
import { STDIN_WORKFLOW_INPUT_BASENAME } from './workflowInputs';
import type { RunEndResult } from '@texra-ai/harness';
import type { AgentConfigPayload } from '@texra-ai/harness/schemas';

/** The documents of a task that ended before it proposed any. */
const NO_DOCUMENTS: DocumentsResult = {
  outputs: [],
  compileFailures: [],
  diffs: [],
};

type OutputFlag = '--output' | '--output-dir';

const notADirectory = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === 'BadResource' &&
  isNotADirectoryError(error.reason.cause);

/** The errno a platform error carries, when the host reported one. */
function errnoCode(error: PlatformError.PlatformError): string | undefined {
  const { cause } = error.reason;
  return cause instanceof Error &&
    'code' in cause &&
    typeof cause.code === 'string'
    ? cause.code
    : undefined;
}

/**
 * The usage error a filesystem failure on a user-supplied output path maps
 * to: the user named a path this process may not create or write, which is
 * not a TeXRA defect. Any other failure stays as it is and reads as a bug.
 */
function outputPathError(
  target: string,
  flagLabel: OutputFlag,
  error: PlatformError.PlatformError,
): CliUsageError | PlatformError.PlatformError {
  if (notADirectory(error) || error.reason._tag === 'AlreadyExists') {
    return new CliUsageError(
      flagLabel === '--output-dir'
        ? `--output-dir is not a directory (a parent path component is a file): ${target}`
        : `--output: a parent path component is a file: ${target}`,
    );
  }
  const code = errnoCode(error);
  if (code === 'EROFS') {
    return new CliUsageError(
      `${flagLabel} is not writable (read-only file system): ${target}`,
    );
  }
  if (error.reason._tag === 'PermissionDenied' || code === 'EPERM') {
    return new CliUsageError(
      `${flagLabel} is not writable (permission denied): ${target}`,
    );
  }
  if (error.reason._tag === 'NotFound') {
    return new CliUsageError(
      flagLabel === '--output-dir'
        ? `--output-dir cannot be created: ${target}`
        : `--output parent directory cannot be created: ${target}`,
    );
  }
  return error;
}

/**
 * Probe `target`, materialize the directory that the eventual output write
 * requires, and check that the write will be allowed, so a path the run
 * cannot write fails before the model is billed. Using the same recursive
 * mkdir operation as the writer avoids platform-specific ancestor traversal:
 * it handles missing depth, Windows ENOENT-through-file behavior, and symlink
 * resolution natively. The Path service serves dirname so tests can supply
 * NodePath.layerWin32; at runtime NodePath.layer is node:path, so it agrees
 * with path.resolve.
 */
const probeOutputPath = Effect.fn('probeOutputPath')(
  function* (
    target: string,
    flagLabel: OutputFlag,
  ): Effect.fn.Return<
    FileSystem.File.Info | null,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const requiredDirectory =
      flagLabel === '--output-dir' ? target : pathService.dirname(target);
    const stats = yield* fs
      .stat(target)
      .pipe(
        Effect.catchReason('PlatformError', 'NotFound', () =>
          Effect.succeed(null),
        ),
      );
    if (stats === null) {
      yield* fs.makeDirectory(requiredDirectory, { recursive: true });
    }
    // A target of the wrong kind (a file for --output-dir, a directory for
    // --output) is the caller's report, which names the real problem; a
    // writability answer about it would not.
    if (
      stats !== null &&
      (stats.type === 'Directory') !== (flagLabel === '--output-dir')
    ) {
      return stats;
    }
    // An existing --output file is overwritten in place; anything else is
    // written into the required directory.
    yield* fs.access(
      stats !== null && flagLabel === '--output' ? target : requiredDirectory,
      { writable: true },
    );
    return stats;
  },
  (effect, target, flagLabel) =>
    Effect.mapError(effect, (error) =>
      outputPathError(target, flagLabel, error),
    ),
);

export { probeOutputPath as probeOutputPathForTests };

/** `--output-dir <path>` must point at a directory (or not exist yet). */
export function assertOutputDirAvailable(
  outputDir: string | undefined,
  cwd: string,
): Effect.Effect<
  void,
  CliUsageError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  if (!outputDir) return Effect.void;
  const target = path.resolve(cwd, outputDir);
  return probeOutputPath(target, '--output-dir').pipe(
    Effect.flatMap((stats) =>
      stats && stats.type !== 'Directory'
        ? Effect.fail(
            new CliUsageError(`--output-dir is not a directory: ${target}`),
          )
        : Effect.void,
    ),
  );
}

/** `--output <path>` must end at a writable file path (or not exist yet). */
export function assertOutputFileAvailable(
  outputFile: string | undefined,
  cwd: string,
): Effect.Effect<
  void,
  CliUsageError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  if (!outputFile) return Effect.void;
  const target = path.resolve(cwd, outputFile);
  return probeOutputPath(target, '--output').pipe(
    Effect.flatMap((stats) =>
      stats?.type === 'Directory'
        ? Effect.fail(
            new CliUsageError(
              `--output is a directory; use --output-dir or pick a file path: ${target}`,
            ),
          )
        : Effect.void,
    ),
  );
}

/** A document task's run result: its output always carries its documents. */
export type CliWorkflowRunResult = CliRunResult & {
  /** The run's output with its documents projected as `documents` (the
   *  CLI's JSON contract), not as the run's `structured` value. */
  readonly output: Omit<RunEndOutput, 'structured'> & {
    readonly documents: DocumentsResult;
  };
};

interface WorkflowOutputResolutionOptions {
  readonly expectedOutputFiles?: readonly string[];
  /** Storage root of the session that ran the workflow. */
  readonly storageRoot: string;
}

function outputCopyRelativePath(output: OutputFileSummary): string {
  const relativePath =
    output.relativePath || path.basename(output.absolutePath);
  return getSafeDocumentRelativePath(
    stripWorkflowRoundDir(toPosixPath(relativePath)),
  );
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

/**
 * The output names an `--output-dir` run expects when its agent declares no
 * `task.outputs`: one per input, with a stdin-materialized input
 * reported under its stable basename.
 *
 * Computed at launch, while the stdin materialization path is still known, and
 * persisted with the run so a resume reports the same names. The agent's own
 * declared defaults — which only its loaded definition carries — take
 * precedence over these at output finalization.
 */
export function inputDerivedOutputFiles(
  inputFiles: readonly string[],
  /** The path this run materialized stdin to, when it read stdin. */
  stdinInputPath?: string,
): readonly string[] {
  const absoluteInputs = inputFiles
    .filter((input) => path.isAbsolute(input))
    .map((input) => path.resolve(input));
  const absoluteRoot = commonDirectory(absoluteInputs.map(path.dirname));

  return inputFiles.map((input) => {
    if (stdinInputPath !== undefined && input === stdinInputPath) {
      return STDIN_WORKFLOW_INPUT_BASENAME;
    }
    if (!path.isAbsolute(input)) return getSafeDocumentRelativePath(input);
    return getSafeDocumentRelativePath(path.relative(absoluteRoot, input));
  });
}

/** Copy one generated output to its destination, creating the parent path. */
function copyOutputFile(
  source: string,
  targetPath: string,
  flagLabel: OutputFlag,
): Effect.Effect<
  void,
  CliUsageError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return FileSystem.FileSystem.use((fs) =>
    fs
      .makeDirectory(path.dirname(targetPath), { recursive: true })
      .pipe(Effect.andThen(fs.copyFile(source, targetPath))),
  ).pipe(
    Effect.mapError((error) => outputPathError(targetPath, flagLabel, error)),
  );
}

export function resolveWorkflowOutput(
  outputFile: string | undefined,
  outputDir: string | undefined,
  result: RunEndResult,
  context: CliContext,
  options: WorkflowOutputResolutionOptions,
): Effect.Effect<CliWorkflowRunResult, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    // A document task's recipe returns its documents, diffs included: its
    // run's `structured` value, which the CLI's result names `documents`.
    const { structured, ...output } = result.output;
    // A task that failed or stopped before it proposed returned none: it
    // reports its own outcome with no documents. A completed one without
    // them is a defect.
    const documents =
      documentsResultOf(structured) ??
      (result.outcome === RUN_OUTCOME.COMPLETED
        ? yield* Effect.die(
            new Error(
              `Document task ${result.runId} ended without its documents.`,
            ),
          )
        : NO_DOCUMENTS);
    const runDirectory = runDirUnder(options.storageRoot, result.runId);
    const baseResult = {
      ...result,
      output: { ...output, documents },
      workingDirectory: context.cwd,
      runDirectory,
    };
    // Only completed runs may publish to user-requested destinations. Partial or
    // rejected artifacts remain inspectable in run storage through baseResult.
    if (result.outcome !== RUN_OUTCOME.COMPLETED) return baseResult;
    const terminalStatus = runOutcomeToCliRunStatus(result.outcome);
    if (documents.outputs.length === 0 && (outputFile || outputDir)) {
      return yield* Effect.fail(
        new Error(
          outputDir
            ? `Document task ${terminalStatus} without generated outputs; nothing was copied to ${outputDir}.`
            : `Document task ${terminalStatus} without a generated output; ${outputFile} was not written.`,
        ),
      );
    }

    if (outputDir) {
      const targetRoot = path.resolve(context.cwd, outputDir);
      const expectedRelativePaths = (options.expectedOutputFiles ?? []).map(
        (file) => getSafeDocumentRelativePath(file),
      );
      const outputsByRelativePath = new Map<string, OutputFileSummary>();
      for (const output of documents.outputs) {
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
        yield* copyOutputFile(output.absolutePath, targetPath, '--output-dir');
        copiedOutputs.push(targetPath);
      }

      const missing = expectedRelativePaths.filter(
        (expected) => !outputsByRelativePath.has(expected),
      );
      if (missing.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Document task ${terminalStatus} without expected ${pluralize(missing.length, 'output')}: ${missing.join(', ')}; copied ${copiedOutputs.length} of ${formatResultCount(expectedRelativePaths.length, 'expected output')} to ${targetRoot}.`,
          ),
        );
      }

      return { ...baseResult, copiedOutputs };
    }

    const finalOutput = finalWorkflowOutput(documents.outputs);
    if (!outputFile || !finalOutput) {
      return baseResult;
    }

    const targetPath = path.resolve(context.cwd, outputFile);
    if (path.resolve(finalOutput.absolutePath) !== targetPath) {
      yield* copyOutputFile(finalOutput.absolutePath, targetPath, '--output');
    }

    return { ...baseResult, copiedOutput: targetPath };
  });
}

export function formatWorkflowTextResult(result: CliWorkflowRunResult): string {
  if (result.outcome === RUN_OUTCOME.FAILED) {
    const diagnosticPath =
      result.runDirectory ??
      finalWorkflowOutput(result.output.documents.outputs)?.absolutePath;
    return diagnosticPath
      ? `FAILED\nRun artifacts: ${diagnosticPath}`
      : 'FAILED';
  }
  if (
    result.outcome === RUN_OUTCOME.CANCELLED &&
    result.runDirectory &&
    !result.copiedOutput &&
    !result.copiedOutputs?.length
  ) {
    return result.runDirectory;
  }
  if (result.copiedOutputs?.length) {
    return result.copiedOutputs.join('\n');
  }
  if (result.copiedOutput) {
    return result.copiedOutput;
  }

  const finalOutput = finalWorkflowOutput(result.output.documents.outputs);
  return (
    finalOutput?.absolutePath ??
    result.runDirectory ??
    runOutcomeToCliRunStatus(result.outcome)
  );
}

export function resumeWorkflowOutputFile(
  config: AgentConfigPayload,
): string | undefined {
  if (!isRecipeConfig(config)) return undefined;

  const cliOutputFile = config.cli?.outputFile;
  if (isNonEmptyString(cliOutputFile)) {
    if (!path.isAbsolute(cliOutputFile)) {
      throw new CliUsageError(
        `Stored document task output file is not absolute: ${cliOutputFile}`,
      );
    }
    return cliOutputFile;
  }

  const outputFiles = config.outputFiles ?? [];
  if (outputFiles.length !== 1) return undefined;

  const outputFile = outputFiles[0];
  if (!isNonEmptyString(outputFile)) return undefined;
  if (path.isAbsolute(outputFile)) return outputFile;
  const workingDirectory = config.workingDirectory;
  return workingDirectory
    ? path.join(workingDirectory, outputFile)
    : outputFile;
}

export function resumeWorkflowOutputDirectory(
  config: AgentConfigPayload,
): string | undefined {
  if (!isRecipeConfig(config)) return undefined;

  const outputDirectory = config.cli?.outputDirectory;
  if (!isNonEmptyString(outputDirectory)) return undefined;
  if (!path.isAbsolute(outputDirectory)) {
    throw new CliUsageError(
      `Stored document task output directory is not absolute: ${outputDirectory}`,
    );
  }
  return outputDirectory;
}
