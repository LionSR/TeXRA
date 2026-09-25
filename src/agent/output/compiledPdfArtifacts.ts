// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, type PlatformError } from 'effect';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import {
  fileLocationDisplayPath,
  type RunId,
  type FileLocation,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { stripWorkflowRoundDir } from '@shared/constants/workflowOutput';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { normalizeFilePath } from '@utils/core';
import { hasExtension } from '@utils/core/pathCore';

interface PublishCompiledPdfOptions {
  runDirectory: string;
  runId: RunId;
  round: number;
  displayName: string;
  source: FileLocation;
  compiledPdfPath: string;
  pdfStemSuffix?: string;
}

function normalizePdfRelativePath(pdfPath: string): string {
  const parts = normalizeFilePath(pdfPath)
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
  const normalized = parts.length > 0 ? parts.join('/') : 'output.pdf';
  return hasExtension(normalized, '.pdf') ? normalized : `${normalized}.pdf`;
}

function toPdfRelativePath(options: PublishCompiledPdfOptions): string {
  const comparablePath =
    options.source.kind === 'external'
      ? path.basename(options.displayName)
      : stripWorkflowRoundDir(
          normalizeFilePath(fileLocationDisplayPath(options.source)),
          options.round,
        );
  const parsed = path.parse(comparablePath || options.displayName);
  const stem = parsed.name || path.basename(options.displayName, parsed.ext);
  const pdfStem = `${stem || 'output'}${options.pdfStemSuffix ?? ''}`;
  return normalizePdfRelativePath(path.join(parsed.dir, `${pdfStem}.pdf`));
}

/**
 * Whether a platform failure means "the path is not there". The standard
 * filesystem service normalizes the host error into a `SystemError` reason,
 * so match that tag first and fall back to the original error's `code` for a
 * backend that only carries the cause.
 */
function isMissingPath(error: PlatformError.PlatformError): boolean {
  return (
    error.reason._tag === 'NotFound' || isFileNotFoundError(error.reason.cause)
  );
}

/**
 * Copy `source` over `destination`, creating the destination's directory and
 * clearing whatever was there first. A destination that is already gone is
 * the one removal failure this step tolerates; everything else (a permission
 * denial, a busy path) is the caller's to report.
 */
const copyArtifactFile = Effect.fn('publishCompiledPdfArtifact.copy')(
  function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs
      .remove(destination, { recursive: true })
      .pipe(Effect.catchIf(isMissingPath, () => Effect.void));
    yield* fs.copy(source, destination, { overwrite: true });
  },
);

/**
 * Publish a compiled PDF under the run's `output/r<round>/` and
 * `output/latest/` directories. A compile that wrote no PDF — or wrote
 * something that is not a file — publishes nothing and reports `null`; every
 * other filesystem failure is the caller's to report.
 */
export const publishCompiledPdfArtifact = Effect.fn(
  'publishCompiledPdfArtifact',
)(function* (options: PublishCompiledPdfOptions) {
  const fs = yield* FileSystem.FileSystem;
  const stats = yield* fs
    .stat(options.compiledPdfPath)
    .pipe(Effect.catchIf(isMissingPath, () => Effect.succeed(undefined)));
  if (stats === undefined || stats.type !== 'File') {
    return null as RunStorageFileLocation | null;
  }

  const pdfRelativePath = toPdfRelativePath(options);
  const roundRelativePath = path.posix.join(
    'output',
    `r${options.round}`,
    pdfRelativePath,
  );
  const latestRelativePath = path.posix.join(
    'output',
    'latest',
    pdfRelativePath,
  );
  const roundAbsolutePath = path.join(options.runDirectory, roundRelativePath);
  const latestAbsolutePath = path.join(
    options.runDirectory,
    latestRelativePath,
  );

  yield* copyArtifactFile(options.compiledPdfPath, roundAbsolutePath);
  yield* copyArtifactFile(roundAbsolutePath, latestAbsolutePath);

  return createRunStorageLocation(
    latestAbsolutePath,
    latestRelativePath,
    options.runId,
  );
});

/**
 * Run a compiled-PDF publish as a best-effort side effect: a failed copy is
 * reported through `reportFailure` and yields `null` instead of failing the
 * caller, so a document that genuinely compiled is never reported as a compile
 * failure because of where its PDF landed. The reporter is the caller's, which
 * is what keeps each site's own warning message and diagnostic payload.
 */
export const publishCompiledPdfArtifactBestEffort = <E, R>(
  publish: Effect.Effect<RunStorageFileLocation | null, E, R>,
  reportFailure: (error: E) => void,
): Effect.Effect<RunStorageFileLocation | null, never, R> =>
  publish.pipe(
    Effect.catch((error) =>
      Effect.sync((): RunStorageFileLocation | null => {
        reportFailure(error);
        return null;
      }),
    ),
  );
