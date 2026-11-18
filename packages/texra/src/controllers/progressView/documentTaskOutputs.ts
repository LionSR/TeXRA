/**
 * Delivering a finished document task's outputs to a place the person
 * chose: a file that takes the final output, or a directory that takes
 * every output under the name it was expected at. The outputs are the ones
 * the run's documents fact reports (`documentsOf`), the same record the
 * progress view's file actions read; nothing here reads run storage.
 */
// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Path, PlatformError, Schema } from 'effect';

// Local imports
import { toPosixPath } from '@texra-ai/harness/host';
import { meansAbsent, isNotADirectoryError } from '@texra-ai/harness/node';
import { stripRevisionDir } from '@texra/shared/constants/revisionLayout';
import {
  finalDocumentOutput,
  type OutputFileSummary,
} from '@texra/shared/plugins/documentOutputs';
import { getSafeDocumentRelativePath } from '@texra/utils/files/outputFileUtils';

const DestinationKindSchema = Schema.Literals(['file', 'directory']);
type DestinationKind = typeof DestinationKindSchema.Type;

/** Where a finished task's outputs go: a file for its final output, or a
 *  directory for all of them, with the relative names it is expected to
 *  hold (none when nothing in particular is expected). */
export type OutputDestination =
  | { readonly kind: 'file'; readonly path: string }
  | {
      readonly kind: 'directory';
      readonly path: string;
      readonly expected: readonly string[];
    };

/** Why the outputs cannot be delivered, with the paths concerned. */
const DeliveryReasonSchema = Schema.TaggedUnion({
  /** The destination, or a file to be written under it, cannot be written:
   *  a parent path component is a file, it is of the other kind, its file
   *  system is read-only, permission is denied, or its directory cannot be
   *  created. `path` is the one the problem is about. */
  Destination: {
    destination: DestinationKindSchema,
    path: Schema.String,
    problem: Schema.Literals([
      'parentIsFile',
      'wrongKind',
      'readOnlyFileSystem',
      'permissionDenied',
      'cannotCreate',
    ]),
  },
  /** The task completed without an output; `path` as the caller named it. */
  NoOutputs: { destination: DestinationKindSchema, path: Schema.String },
  /** Outputs the directory was expected to hold are not among the task's;
   *  every output there was is copied. */
  MissingOutputs: {
    missing: Schema.Array(Schema.String),
    copied: Schema.Int,
    expected: Schema.Int,
    directory: Schema.String,
  },
});
export type DeliveryReason = typeof DeliveryReasonSchema.Type;

/** A document task's outputs cannot be delivered; `reason` says why. */
export class OutputDeliveryRejected extends Schema.TaggedError<OutputDeliveryRejected>()(
  'OutputDeliveryRejected',
  { reason: DeliveryReasonSchema },
) {
  override get message(): string {
    const { reason } = this;
    switch (reason._tag) {
      case 'Destination':
        return `output ${reason.destination} cannot be written (${reason.problem}): ${reason.path}`;
      case 'NoOutputs':
        return `the task wrote no output for ${reason.path}`;
      case 'MissingOutputs':
        return `the task wrote no ${reason.missing.join(', ')}; copied ${reason.copied} of ${reason.expected} expected outputs to ${reason.directory}`;
    }
  }
}

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
 * The rejection a filesystem failure on a chosen destination maps to: the
 * person named a path this process may not create or write, which is not a
 * TeXRA defect. Any other failure stays as it is and reads as a bug.
 */
function destinationError(
  target: string,
  destination: DestinationKind,
  error: PlatformError.PlatformError,
): OutputDeliveryRejected | PlatformError.PlatformError {
  const rejected = (
    problem: Extract<DeliveryReason, { _tag: 'Destination' }>['problem'],
  ) =>
    new OutputDeliveryRejected({
      reason: { _tag: 'Destination', destination, path: target, problem },
    });
  if (notADirectory(error) || error.reason._tag === 'AlreadyExists')
    return rejected('parentIsFile');
  const code = errnoCode(error);
  if (code === 'EROFS') return rejected('readOnlyFileSystem');
  if (error.reason._tag === 'PermissionDenied' || code === 'EPERM')
    return rejected('permissionDenied');
  if (meansAbsent(error)) return rejected('cannotCreate');
  return error;
}

/**
 * Check that `destination` can take a task's outputs before the task runs,
 * so a path the delivery could not write fails before the model is billed:
 * probe it, create the directory the eventual write requires, and check
 * that the write will be allowed. Using the same recursive mkdir as the
 * writer avoids platform-specific ancestor traversal: it handles missing
 * depth, Windows ENOENT-through-file behavior and symlink resolution
 * natively. The Path service serves dirname so tests can supply
 * NodePath.layerWin32; at runtime it is node:path, so it agrees with
 * path.resolve.
 */
export const checkOutputDestination = Effect.fn('checkOutputDestination')(
  function* (
    destination: Pick<OutputDestination, 'kind' | 'path'>,
    /** What a relative destination is relative to. */
    root: string,
  ): Effect.fn.Return<
    void,
    OutputDeliveryRejected | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const target = path.resolve(root, destination.path);
    const directory = destination.kind === 'directory';
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const requiredDirectory = directory ? target : pathService.dirname(target);
    const probe = Effect.gen(function* () {
      const stats = yield* fs
        .stat(target)
        .pipe(Effect.catchIf(meansAbsent, () => Effect.succeed(null)));
      if (stats === null)
        yield* fs.makeDirectory(requiredDirectory, { recursive: true });
      // A target of the wrong kind is reported as that, which names the
      // real problem; a writability answer about it would not.
      if (stats !== null && (stats.type === 'Directory') !== directory)
        return stats;
      // An existing file destination is overwritten in place; anything
      // else is written into the required directory.
      yield* fs.access(
        stats !== null && !directory ? target : requiredDirectory,
        { writable: true },
      );
      return stats;
    });
    const stats = yield* probe.pipe(
      Effect.mapError((error) =>
        destinationError(target, destination.kind, error),
      ),
    );
    if (stats !== null && (stats.type === 'Directory') !== directory)
      return yield* new OutputDeliveryRejected({
        reason: {
          _tag: 'Destination',
          destination: destination.kind,
          path: target,
          problem: 'wrongKind',
        },
      });
  },
);

/** The name an output is copied under in a directory: the expected name its
 *  lineage matches, when exactly one does, else its own generated name. */
function copyRelativePath(
  output: OutputFileSummary,
  expectedRelativePaths: readonly string[],
): string {
  // toPosixPath also trims and resolves `.`/`..` segments; these paths come
  // from the task's own generated outputs, never from user input.
  const generatedRelativePath = getSafeDocumentRelativePath(
    stripRevisionDir(
      toPosixPath(output.relativePath || path.basename(output.absolutePath)),
    ),
  );
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
  const [firstPath, ...restPaths] = paths;
  if (firstPath === undefined) return '';
  const first = path.resolve(firstPath).split(path.sep);
  const rest = restPaths.map((file) => path.resolve(file).split(path.sep));
  let sharedLength = 0;
  while (
    sharedLength < first.length &&
    rest.every((parts) => parts[sharedLength] === first[sharedLength])
  ) {
    sharedLength += 1;
  }
  return (
    first.slice(0, Math.max(1, sharedLength)).join(path.sep) ||
    path.parse(firstPath).root
  );
}

/**
 * The names a directory destination expects when the program declares no
 * outputs of its own (`Program.outputs`): one per input, relative to the
 * inputs' common directory, and a file written from captured text under its
 * own name. Computed at launch, while the written files are known, and
 * kept with the run so a resume expects the same names.
 */
export function inputDerivedOutputFiles(
  inputFiles: readonly string[],
  /** The inputs the launch wrote from captured text. */
  writtenFiles: readonly string[],
): readonly string[] {
  const absoluteInputs = inputFiles
    .filter((input) => path.isAbsolute(input))
    .map((input) => path.resolve(input));
  const absoluteRoot = commonDirectory(absoluteInputs.map(path.dirname));

  return inputFiles.map((input) => {
    if (writtenFiles.includes(input)) return path.basename(input);
    if (!path.isAbsolute(input)) return getSafeDocumentRelativePath(input);
    return getSafeDocumentRelativePath(path.relative(absoluteRoot, input));
  });
}

/** Copy one output to its destination, creating the parent path. */
function copyOutput(
  source: string,
  targetPath: string,
  destination: DestinationKind,
) {
  return FileSystem.FileSystem.use((fs) =>
    fs
      .makeDirectory(path.dirname(targetPath), { recursive: true })
      .pipe(Effect.andThen(fs.copyFile(source, targetPath))),
  ).pipe(
    Effect.mapError((error) =>
      destinationError(targetPath, destination, error),
    ),
  );
}

/**
 * Copy a completed task's `outputs` to `destination` and answer the paths
 * written. A directory takes each output's newest round under the name it
 * was expected at, all at once, and the delivery is rejected afterwards
 * when an expected name was not among them; a file takes the final output
 * (`finalDocumentOutput`), unless it already is that output.
 */
export const deliverDocumentTaskOutputs = Effect.fn(
  'deliverDocumentTaskOutputs',
)(function* (
  outputs: readonly OutputFileSummary[],
  destination: OutputDestination,
  /** What a relative destination is relative to. */
  root: string,
): Effect.fn.Return<
  readonly string[],
  OutputDeliveryRejected | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const finalOutput = finalDocumentOutput(outputs);
  if (finalOutput === undefined)
    return yield* new OutputDeliveryRejected({
      reason: {
        _tag: 'NoOutputs',
        destination: destination.kind,
        path: destination.path,
      },
    });

  if (destination.kind === 'file') {
    const targetPath = path.resolve(root, destination.path);
    if (path.resolve(finalOutput.absolutePath) !== targetPath)
      yield* copyOutput(finalOutput.absolutePath, targetPath, 'file');
    return [targetPath];
  }

  const targetRoot = path.resolve(root, destination.path);
  const expected = destination.expected.map((file) =>
    getSafeDocumentRelativePath(file),
  );
  const byRelativePath = new Map<string, OutputFileSummary>();
  for (const output of outputs) {
    const relativePath = copyRelativePath(output, expected);
    const existing = byRelativePath.get(relativePath);
    if (existing == null || output.round > existing.round)
      byRelativePath.set(relativePath, output);
  }
  // Each output has its own target, so the copies run at once.
  const copied = yield* Effect.forEach(
    byRelativePath,
    ([relativePath, output]) => {
      const targetPath = path.join(targetRoot, relativePath);
      return copyOutput(output.absolutePath, targetPath, 'directory').pipe(
        Effect.as(targetPath),
      );
    },
    { concurrency: 8 },
  );
  const missing = expected.filter((file) => !byRelativePath.has(file));
  if (missing.length > 0)
    return yield* new OutputDeliveryRejected({
      reason: {
        _tag: 'MissingOutputs',
        missing,
        copied: copied.length,
        expected: expected.length,
        directory: targetRoot,
      },
    });
  return copied;
});
