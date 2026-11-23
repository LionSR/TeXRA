import * as path from 'node:path';
import { runDirUnder } from '@texra-ai/worldline/plugins';

import { Effect, FileSystem, Path, PlatformError, Schema } from 'effect';

import {
  programOf,
  Rejected,
  RUN_OUTCOME,
  formatResultCount,
  pluralize,
} from '@texra-ai/worldline/schemas';
import type {
  CliRunResult,
  CliDocumentTaskResult,
} from '@cli/schemas/cliOutput';
import { runStatusLabel } from '@ui/copy/runStatus';
import {
  finalDocumentOutput,
  type DocumentsResult,
} from '@texra/shared/plugins/documentOutputs';
import {
  checkOutputDestination,
  deliverDocumentTaskOutputs,
  type DeliveryReason,
  type OutputDeliveryRejected,
  type OutputDestination,
} from '@texra/controllers/progressView/documentTaskOutputs';

import { CliUsageError, type CliContext } from '../platform/cliContext';
import type { AgentConfigPayload } from '@texra-ai/worldline/schemas';

/** A destination the person cannot write, in the words of the flag that
 *  named it. */
function destinationMessage(
  reason: Extract<DeliveryReason, { _tag: 'Destination' }>,
): string {
  const directory = reason.destination === 'directory';
  const flag = directory ? '--output-dir' : '--output';
  const target = reason.path;
  switch (reason.problem) {
    case 'parentIsFile':
      return directory
        ? `--output-dir is not a directory (a parent path component is a file): ${target}`
        : `--output: a parent path component is a file: ${target}`;
    case 'wrongKind':
      return directory
        ? `--output-dir is not a directory: ${target}`
        : `--output is a directory; use --output-dir or pick a file path: ${target}`;
    case 'readOnlyFileSystem':
      return `${flag} is not writable (read-only file system): ${target}`;
    case 'permissionDenied':
      return `${flag} is not writable (permission denied): ${target}`;
    case 'cannotCreate':
      return directory
        ? `--output-dir cannot be created: ${target}`
        : `--output parent directory cannot be created: ${target}`;
  }
}

/** A delivery the CLI cannot make, worded for its output: a destination the
 *  flags named is a usage error; a completed task that wrote too little is
 *  a rejection of its result. */
function deliveryError(reason: DeliveryReason): CliUsageError | Rejected {
  switch (reason._tag) {
    case 'Destination':
      return new CliUsageError({ message: destinationMessage(reason) });
    case 'NoOutputs':
      return new Rejected({
        reason:
          reason.destination === 'directory'
            ? `Program completed without generated outputs; nothing was copied to ${reason.path}.`
            : `Program completed without a generated output; ${reason.path} was not written.`,
      });
    case 'MissingOutputs':
      return new Rejected({
        reason: `Program completed without expected ${pluralize(reason.missing.length, 'output')}: ${reason.missing.join(', ')}; copied ${reason.copied} of ${formatResultCount(reason.expected, 'expected output')} to ${reason.directory}.`,
      });
  }
}

/**
 * Fail fast, before the run starts, on an `--output` file or `--output-dir`
 * directory the final copy would reject; nothing to check when the flag is
 * not set.
 */
export function assertOutputDestinationAvailable(
  kind: OutputDestination['kind'],
  target: string | undefined,
  cwd: string,
): Effect.Effect<
  void,
  CliUsageError | OutputDeliveryRejected | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  if (!target) return Effect.void;
  // A check rejects only for its destination.
  return checkOutputDestination({ kind, path: target }, cwd).pipe(
    Effect.catchTag('OutputDeliveryRejected', (rejected) =>
      Effect.fail(
        rejected.reason._tag === 'Destination'
          ? new CliUsageError({ message: destinationMessage(rejected.reason) })
          : rejected,
      ),
    ),
  );
}

interface DocumentTaskOutputResolutionOptions {
  readonly expectedOutputFiles?: readonly string[];
  /** Storage root of the session that ran the workflow. */
  readonly storageRoot: string;
}

export const resolveDocumentTaskOutput = Effect.fn('resolveDocumentTaskOutput')(
  function* (
    outputFile: string | undefined,
    outputDir: string | undefined,
    result: CliRunResult,
    /** What the run's documents row reports; none for a task that ended
     *  before it extracted any. */
    reported: DocumentsResult | undefined,
    context: CliContext,
    options: DocumentTaskOutputResolutionOptions,
  ): Effect.fn.Return<CliDocumentTaskResult, Error, FileSystem.FileSystem> {
    // A program returns no value: its documents are its documents row.
    const { structured: _none, ...output } = result.output;
    const documents = reported ?? {
      outputs: [],
      compileFailures: [],
      diffs: [],
    };
    const runDirectory = runDirUnder(options.storageRoot, result.runId);
    const baseResult = {
      ...result,
      output: { ...output, documents },
      runDirectory,
    };
    // Only completed runs may publish to user-requested destinations. Partial or
    // rejected artifacts remain inspectable in run storage through baseResult.
    if (result.outcome !== RUN_OUTCOME.COMPLETED) return baseResult;
    const destination: OutputDestination | undefined = outputDir
      ? {
          kind: 'directory',
          path: outputDir,
          expected: options.expectedOutputFiles ?? [],
        }
      : outputFile
        ? { kind: 'file', path: outputFile }
        : undefined;
    if (destination === undefined) return baseResult;
    const copied = yield* deliverDocumentTaskOutputs(
      documents.outputs,
      destination,
      context.cwd,
    ).pipe(
      Effect.catchTag('OutputDeliveryRejected', ({ reason }) =>
        Effect.fail(deliveryError(reason)),
      ),
    );
    return destination.kind === 'directory'
      ? { ...baseResult, copiedOutputs: [...copied] }
      : { ...baseResult, copiedOutput: copied[0] };
  },
);

export function formatDocumentTaskTextResult(
  result: CliDocumentTaskResult,
): string {
  if (result.outcome === RUN_OUTCOME.FAILED) {
    // The reply of a failed run is its error (the uncompiled documents and
    // their logs), so the text result says it beside where the artifacts are.
    return [
      runStatusLabel(result.outcome),
      result.output.response.trim(),
      `Run artifacts: ${result.runDirectory}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (
    result.outcome === RUN_OUTCOME.CANCELLED &&
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

  // A program that writes no documents (a Lean program edits the
  // workspace) answers in text.
  const finalOutput = finalDocumentOutput(result.output.documents.outputs);
  return (
    finalOutput?.absolutePath ??
    (result.output.response.trim() || result.runDirectory)
  );
}

/**
 * Where a command line copies a run's output (`--output`, `--output-dir`),
 * kept in the run's `launch` record so a resume copies it to the same place.
 */
const CliLaunchOutputSchema = Schema.Struct({
  /** Workspace file the run's output is copied to. */
  outputFile: Schema.optional(Schema.String),
  /** Workspace directory the run's output files are copied to. */
  outputDirectory: Schema.optional(Schema.String),
  /** Relative artifacts expected under `outputDirectory`. */
  expectedOutputFiles: Schema.optional(Schema.Array(Schema.String)),
});

/** The output targets a command-line launch recorded, `{}` for any other. */
export function cliLaunchOutput(
  config: Pick<AgentConfigPayload, 'launch'>,
): typeof CliLaunchOutputSchema.Type {
  return Schema.decodeUnknownSync(CliLaunchOutputSchema)(config.launch ?? {});
}

export function resumeDocumentTaskOutputFile(
  config: AgentConfigPayload,
): string | undefined {
  if (programOf(config) === null) return undefined;

  const cliOutputFile = cliLaunchOutput(config).outputFile;
  if (cliOutputFile !== undefined && cliOutputFile.trim() !== '') {
    if (!path.isAbsolute(cliOutputFile)) {
      throw new CliUsageError({
        message: `Stored program output file is not absolute: ${cliOutputFile}`,
      });
    }
    return cliOutputFile;
  }

  const outputFiles = config.outputFiles ?? [];
  if (outputFiles.length !== 1) return undefined;

  const outputFile = outputFiles[0];
  if (typeof outputFile !== 'string' || outputFile.trim() === '')
    return undefined;
  if (path.isAbsolute(outputFile)) return outputFile;
  const workingDirectory = config.workingDirectory;
  return workingDirectory
    ? path.join(workingDirectory, outputFile)
    : outputFile;
}

export function resumeDocumentTaskOutputDirectory(
  config: AgentConfigPayload,
): string | undefined {
  if (programOf(config) === null) return undefined;

  const outputDirectory = cliLaunchOutput(config).outputDirectory;
  if (outputDirectory === undefined || outputDirectory.trim() === '')
    return undefined;
  if (!path.isAbsolute(outputDirectory)) {
    throw new CliUsageError({
      message: `Stored program output directory is not absolute: ${outputDirectory}`,
    });
  }
  return outputDirectory;
}
