import * as path from 'node:path';

import { Effect, FileSystem, Predicate } from 'effect';

import { createRunStorageLocation } from '@texra-ai/harness/host';
import { absentReason, entryTypeIn } from '@texra-ai/harness/node';
import {
  toErrorMessage,
  fileLocationDisplayPath,
  type RunId,
  type FileLocation,
  type RunStorageFileLocation,
} from '@texra-ai/harness/schemas';
import { latexdiff } from '@latex/latexdiff';
import {
  latexdiffPairs,
  type LatexdiffPair,
} from '@latex/latexdiff/diffOperations';
import { compileLatex2Pdf } from '@latex/texTools';
import type {
  LatexdiffEntry,
  OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';
import {
  DOCUMENT_OUTPUT_BASENAME,
  revisionLayout,
} from '@texra/shared/constants/revisionLayout';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';

import {
  publishCompiledPdfArtifact,
  publishCompiledPdfArtifactBestEffort,
} from './compiledPdfArtifacts';
import { resolveWorkspaceSourceDir } from './compileCheck';
import type { OutputDependencies } from './outputFileExtraction';
import {
  Settings,
  withLogChannel,
  type WorkspaceFs,
} from '@texra-ai/harness/plugins';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import {
  LATEXDIFF_BETWEEN_ROUNDS_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
  DOCUMENTS_COMPILE_TIMEOUT_SETTING,
} from '@texra/shared/settingsView/documentsSettings';

/** What a diff pass reads of the documents: their run and session roots. */
type DiffRun = {
  readonly run: Pick<OutputDependencies, 'logger' | 'fileService'>;
  readonly roots: OutputDependencies['roots'];
};

/** The services a diff pass checks, runs and records on. */
type DiffServices = FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner;

interface DiffOutputDirectory {
  absolutePath: string;
  relativePath: string;
  runId: RunId;
}

type SingleDiffOutcome = {
  entry: LatexdiffEntry;
  artifact: RunStorageFileLocation | null;
};

/** What a round's latexdiff pass wrote: the PDFs it published, one entry
 *  per diffed pair for the round's documents fact, and why it diffed no pair
 *  at all when it could not run (`null` when it ran, however many pairs it
 *  found). */
interface RoundLatexdiffs {
  readonly artifacts: RunStorageFileLocation[];
  readonly entries: LatexdiffEntry[];
  readonly notRun: string | null;
}

/** A pass that could not run, and why: fresh arrays, since a caller owns
 *  the arrays it is handed. */
const notRun = (reason: string): RoundLatexdiffs => ({
  artifacts: [],
  entries: [],
  notRun: reason,
});

/**
 * Mirror an existing workspace dependency into run storage so latexdiff's
 * relative `\input{}` resolution finds it. A dependency whose existence
 * check or mirror fails (a permission denial, a transient I/O error) is
 * reported with its path and cause and skipped: the other file pairs still
 * diff, and this diff still runs and names whatever it could not resolve.
 */
const mirrorDependency = (
  { run: { logger, fileService } }: DiffRun,
  target: FileLocation,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if ((yield* entryTypeIn(fs, target.absolutePath)) === undefined) return;
    yield* fileService.mirrorWorkspaceFile(target);
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn(
          `Unable to mirror workspace dependency ${target.absolutePath}: ${toErrorMessage(error)}`,
          { data: { path: target.absolutePath, error } },
        );
      }),
    ),
  );

/**
 * The latexdiffs of revision `currRound`: the pairs its recorded
 * `outputFiles` call for (`latexdiffPairs`), against the documents they
 * started from and, when the setting asks, against their own
 * `previousOutputs`. A missing latexdiff is each pair's failure, carrying
 * its install steps; a pass that fails as a whole says why in `notRun`.
 */
export const revisionLatexdiffs = Effect.fn('documents.revisionLatexdiffs')(
  function* (
    docs: DiffRun,
    currRound: number,
    outputFiles: readonly OutputFileInfo[],
    previousOutputs: readonly OutputFileInfo[],
  ): Effect.fn.Return<RoundLatexdiffs, Error, DiffServices> {
    const { logger, fileService } = docs.run;
    const { roots } = docs;
    if (outputFiles.length === 0) {
      logger.warn(
        `No output files found for round ${currRound}, skipping latexdiff operations`,
      );
      return notRun(`round ${currRound} has no output files`);
    }

    // Ensure round-dir has symlinks to all mirrored deps so latexdiff's
    // relative \input{} resolution works when its cwd is the revision
    // folder. The round's sources resolve beside its output, never over it;
    // the latexdiff directory holds no output of that name.
    const layout = revisionLayout(currRound);
    yield* fileService.ensureMirroredInRunSubdir(layout.dir, {
      protectedStem: DOCUMENT_OUTPUT_BASENAME,
    });
    yield* fileService.ensureMirroredInRunSubdir(layout.diffDir);

    logger.debug(`Revision ${currRound + 1} output files`, {
      data: outputFiles.map((f) => f.location.absolutePath),
    });

    const generateBetweenRoundDiffs = yield* Settings.get(
      roots,
      LATEXDIFF_BETWEEN_ROUNDS_SETTING,
    );
    if (!generateBetweenRoundDiffs) {
      logger.debug(
        'Skipping between-round latexdiff operations: disabled in settings',
      );
    }
    // One markup for the whole pass, recorded with each diff.
    const mathMarkup = yield* Settings.get(
      roots,
      LATEXDIFF_MATH_MARKUP_SETTING,
    );
    const candidatePairs = latexdiffPairs(
      outputFiles,
      generateBetweenRoundDiffs ? previousOutputs : [],
    );
    // A base file the lineage named but the workspace never held (an
    // agent whose declared output files are created by the run) has
    // nothing to diff against: that pair is skipped, the rest still run.
    const fs = yield* FileSystem.FileSystem;
    const baseExists = yield* Effect.forEach(
      candidatePairs,
      (pair) =>
        pair.baseRound !== null
          ? Effect.succeed(true)
          : Effect.map(
              entryTypeIn(fs, pair.base.absolutePath),
              (type) => type !== undefined,
            ),
      { concurrency: 'unbounded' },
    );
    const pairs = candidatePairs.filter((_, i) => baseExists[i]);
    if (pairs.length < candidatePairs.length) {
      logger.debug(
        `Skipping ${candidatePairs.length - pairs.length} latexdiff base pair(s): base file not present`,
      );
    }
    logger.debug(
      pairs.length === 0
        ? 'No latexdiff pairs found'
        : 'Matched latexdiff pairs',
      {
        data: pairs.map(
          ({ revised, base }) =>
            `${path.basename(fileLocationDisplayPath(base))} -> ${path.basename(fileLocationDisplayPath(revised.location))}`,
        ),
      },
    );

    const entries: LatexdiffEntry[] = [];
    const artifacts: RunStorageFileLocation[] = [];
    for (const pair of pairs) {
      const outcome = yield* diffPair(docs, pair, layout.diffDir, mathMarkup);
      entries.push(outcome.entry);
      if (outcome.artifact) artifacts.push(outcome.artifact);
    }
    return { artifacts, entries, notRun: null };
  },
  (effect, { run: { logger } }) =>
    // A failed pass is an error on the transcript, and the round records
    // that its diffs did not run.
    Effect.catch(effect, (error) => {
      const message = toErrorMessage(error);
      logger.error(`Error during latexdiff processing: ${message}`);
      return Effect.succeed(notRun(`the latexdiff pass failed: ${message}`));
    }),
);

/**
 * One pair's latexdiff and its compiled PDF, published with a `-diff` stem
 * suffix against the starting document and `-round-diff` against the
 * previous round. The diff is written under `roundDiffDirectory` at its
 * document's own folder, as the round's output is under its revision
 * folder: the diff file is named by the document's file name, so
 * `a/main.tex` and `b/main.tex` would otherwise write the same
 * `main_diff.tex`. One pair's failure is that pair's entry, never the
 * round's: the other pairs keep their diffs.
 */
const diffPair = (
  docs: DiffRun,
  { revised, document, base, baseRound, suffix }: LatexdiffPair,
  roundDiffDirectory: string,
  mathMarkup: LatexdiffMathMarkupValue,
): Effect.Effect<SingleDiffOutcome, never, DiffServices> => {
  const { logger, fileService } = docs.run;
  const { roots } = docs;
  const relativePath = path.join(roundDiffDirectory, path.dirname(document));
  const diffDirectory: DiffOutputDirectory = {
    absolutePath: path.join(fileService.runDirectory, relativePath),
    relativePath,
    runId: fileService.runId,
  };
  const pair = {
    revised: revised.location,
    document: revised.lineage?.document ?? null,
    base,
    baseRound,
    mathMarkup,
  };
  const label = baseRound === null ? 'round-diff' : 'between-rounds-diff';
  return Effect.gen(function* () {
    yield* mirrorDependency(docs, base);
    yield* mirrorDependency(docs, revised.location);

    // latexdiff runs in the revised file's own folder, with symlinks
    // resolved so a mirrored dependency's relative `\input{}` still points
    // at real siblings. A path that cannot be canonicalized is used as
    // given: silently when it is gone (latexdiff then reports it), with a
    // warning for any other failure (a link cycle, a denied component), since
    // relative inputs may then miss their siblings.
    const fs = yield* FileSystem.FileSystem;
    const asGiven = revised.location.absolutePath;
    const cwd = path.dirname(
      yield* fs.realPath(asGiven).pipe(
        Effect.catchIf(absentReason, () => Effect.succeed(asGiven)),
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.warn(
              `Could not resolve links in ${asGiven}; latexdiff runs beside the path as given, so relative inputs may not resolve: ${error.message}`,
            );
            return asGiven;
          }),
        ),
      ),
    );
    const diffPath = yield* latexdiff(base, revised.location, {
      roots,
      cwd,
      suffix,
      outputDirectory: diffDirectory.absolutePath,
      mathMarkup,
    }).pipe(withLogChannel(fileService.runId));
    logger.debug('Successfully generated diff file', {
      data: { operation: label, diffPath },
    });

    const compiled = yield* compileDiff(
      docs,
      diffPath,
      base,
      diffDirectory,
      revised.round,
      revised.location,
      baseRound === null ? '-diff' : '-round-diff',
    );
    return {
      entry: { ...pair, status: 'ok', diff: compiled.diffLocation },
      artifact: compiled.artifact,
    } satisfies SingleDiffOutcome;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync((): SingleDiffOutcome => {
        const message = toErrorMessage(error);
        const line = `${label} failed for ${fileLocationDisplayPath(revised.location)}: ${message}`;
        // An input that is no whole document has nothing to mark up.
        if (Predicate.isTagged(error, 'NoDocumentEnvironment')) {
          logger.debug(line, { data: error });
        } else {
          logger.warn(line, { data: error });
        }
        return {
          entry: { ...pair, status: 'failed', error: message },
          artifact: null,
        };
      }),
    ),
  );
};

const compileDiff = Effect.fn('documents.compileDiff')(function* (
  { run: { logger, fileService }, roots }: DiffRun,
  diffPath: string,
  referenceLocation: FileLocation,
  diffDirectory: DiffOutputDirectory,
  round: number,
  sourceLocation: FileLocation,
  pdfStemSuffix: string,
): Effect.fn.Return<
  {
    diffLocation: FileLocation;
    artifact: RunStorageFileLocation | null;
  },
  Error,
  DiffServices
> {
  const diffFileName = path.basename(diffPath);
  const diffLocation = createRunStorageLocation(
    path.join(diffDirectory.absolutePath, diffFileName),
    path.join(diffDirectory.relativePath, diffFileName),
    diffDirectory.runId,
  );

  const buildDir = path.join(path.dirname(diffLocation.absolutePath), 'build');
  // Reuse the compile check's timeout so a hanging diff build
  // is torn down by its scope instead of orphaning latexmk/pdflatex.
  const timeoutMs = yield* Settings.get(
    roots,
    DOCUMENTS_COMPILE_TIMEOUT_SETTING,
  );
  // The diff `.tex` is written under `diff/r{round}/`, away from both the
  // revised round output and the live workspace source. Search the revised
  // round directory first so same-round sibling edits win, then fall back
  // to the original source tree for unchanged inputs and bibliographies.
  const extraInputDirs = [
    sourceLocation.kind === 'runStorage'
      ? path.dirname(sourceLocation.absolutePath)
      : null,
    // Snapshot bases live under `original/`, while between-round bases
    // live under `r<N>/`; map either back without confusing a real `r<N>`
    // folder.
    resolveWorkspaceSourceDir(roots, referenceLocation) ??
      path.dirname(referenceLocation.absolutePath),
  ].filter(Predicate.isNotNull);
  const compiled = yield* compileLatex2Pdf(diffLocation, roots, {
    outputDirectory: buildDir,
    timeout: timeoutMs,
    extraInputDirs,
  }).pipe(
    withLogChannel(fileService.runId),
    // No compiler costs this diff its PDF, not the diff itself.
    Effect.catchTag('ToolMissing', (missing) =>
      Effect.succeed({ ok: false, logTail: missing.message } as const),
    ),
  );

  if (!compiled.ok) {
    // Keep the missing auxiliary PDF visible, but leave the compiler tail
    // in structured diagnostic data. Dumping that tail into the message
    // makes a recoverable latexdiff failure dominate the transcript.
    logger.warn(
      `Failed to compile latexdiff PDF: ${path.basename(diffLocation.absolutePath)}`,
      {
        data: {
          diffFile: diffLocation.absolutePath,
          logTail: compiled.logTail,
        },
      },
    );
    return { diffLocation, artifact: null };
  }

  const { runId, runDirectory } = fileService;
  const artifact = yield* publishCompiledPdfArtifactBestEffort(
    publishCompiledPdfArtifact({
      runDirectory,
      runId,
      round,
      displayName: path.basename(diffLocation.absolutePath),
      source: sourceLocation,
      compiledPdfPath: compiled.pdfPath,
      pdfStemSuffix,
    }),
    // Publishing the auxiliary PDF is best effort: a copy that failed is
    // reported here and leaves the diff `.tex` itself intact.
    (error) =>
      logger.warn(`Failed to publish latexdiff PDF: ${toErrorMessage(error)}`, {
        data: {
          diffFile: diffLocation.absolutePath,
          compiledPdfPath: compiled.pdfPath,
          error,
        },
      }),
  );
  return { diffLocation, artifact };
});
