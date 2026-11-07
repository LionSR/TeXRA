import * as path from 'node:path';

import { Effect, FileSystem, Predicate } from 'effect';

import {
  createRunStorageLocation,
  Settings,
  withLogChannel,
} from '@texra-ai/harness/host';
import { RunFileService } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';
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
  WORKFLOW_OUTPUT_BASENAME,
  revisionLayout,
} from '@texra/shared/constants/workflowOutput';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';

import {
  publishCompiledPdfArtifact,
  publishCompiledPdfArtifactBestEffort,
} from './compiledPdfArtifacts';
import {
  getWorkflowAutoCompileTimeoutMs,
  resolveWorkspaceSourceDir,
} from './compileCheck';
import { recoverOutputFailure } from './outputOperations';
import type { AgentTrace } from '@texra-ai/harness/plugins';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { WorkspaceFs } from '@texra-ai/harness/host';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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

export class LatexDiffManager {
  private readonly logger: AgentTrace;
  private readonly runId: RunId;
  private readonly fileService: RunFileService;
  private readonly roots: WorkspaceRoots;
  constructor(
    logger: AgentTrace,
    runId: RunId,
    fileService: RunFileService,
    /** The run's session roots: the workspace and setting stores it reads. */
    roots: WorkspaceRoots,
  ) {
    this.logger = logger;
    this.runId = runId;
    this.fileService = fileService;
    this.roots = roots;
  }

  /**
   * The directory latexdiff runs in: the revised file's own folder, with
   * symlinks resolved so a mirrored dependency's relative `\input{}` still
   * points at real siblings. A path the filesystem cannot canonicalize (it
   * was removed under us, or a link cycle) falls back to the path as given —
   * the same directory latexdiff would have used without resolution.
   */
  private readonly getWorkingDirectory = Effect.fn(
    'LatexDiffManager.getWorkingDirectory',
  )(function* (
    location: FileLocation,
  ): Effect.fn.Return<string, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* fs
      .realPath(location.absolutePath)
      .pipe(Effect.orElseSucceed(() => location.absolutePath));
    return path.dirname(resolved);
  });

  /**
   * Mirror an existing workspace dependency into run storage so latexdiff's
   * relative `\input{}` resolution finds it. A dependency whose existence
   * check or mirror fails (a permission denial, a transient I/O error) is
   * reported with its path and cause and skipped: the other file pairs still
   * diff, and this diff still runs and names whatever it could not resolve.
   */
  private ensureWorkspaceDependency(
    targetLocation: FileLocation | null | undefined,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    if (!targetLocation) return Effect.void;
    const dependencyPath = targetLocation.absolutePath;
    return Effect.gen({ self: this }, function* () {
      const fs = yield* FileSystem.FileSystem;
      if ((yield* entryTypeIn(fs, dependencyPath)) === undefined) return;
      yield* this.fileService.mirrorWorkspaceFile(targetLocation);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          this.logger.warn(
            `Unable to mirror workspace dependency ${dependencyPath}: ${toErrorMessage(error)}`,
            {
              data: { path: dependencyPath, error },
            },
          );
        }),
      ),
    );
  }

  /**
   * The round's latexdiffs: the pairs its recorded `outputFiles` call for
   * (`latexdiffPairs`), against the documents they started from and, when
   * the setting asks, against their own `previousOutputs`.
   */
  handleLatexdiffOfOutput(
    currRound: number,
    outputFiles: readonly OutputFileInfo[],
    previousOutputs: readonly OutputFileInfo[],
  ): Effect.Effect<RoundLatexdiffs, never, DiffServices> {
    // A missing latexdiff is each pair's failure, carrying its install steps.
    const execute = Effect.gen({ self: this }, function* () {
      if (outputFiles.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
        );
        return notRun(`round ${currRound} has no output files`);
      }

      // Ensure round-dir has symlinks to all mirrored deps so latexdiff's
      // relative \input{} resolution works when its cwd is runDir/r{round}.
      // The round's sources resolve beside its output, never over it; the
      // latexdiff directory holds no output of that name.
      const layout = revisionLayout(currRound);
      yield* this.fileService.ensureMirroredInRunSubdir(layout.dir, {
        protectedStem: WORKFLOW_OUTPUT_BASENAME,
      });
      const roundDiffDirectory = layout.diffDir;
      yield* this.fileService.ensureMirroredInRunSubdir(roundDiffDirectory);

      this.logger.debug(`Revision ${currRound + 1} output files`, {
        data: outputFiles.map((f) => f.location.absolutePath),
      });

      const generateBetweenRoundDiffs = yield* Settings.get<boolean>(
        this.roots,
        DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS,
      );
      if (!generateBetweenRoundDiffs) {
        this.logger.debug(
          'Skipping between-round latexdiff operations: disabled in settings',
        );
      }
      // One markup for the whole pass, recorded with each diff.
      const mathMarkup = yield* Settings.get<LatexdiffMathMarkupValue>(
        this.roots,
        DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
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
        this.logger.debug(
          `Skipping ${candidatePairs.length - pairs.length} latexdiff base pair(s): base file not present`,
        );
      }
      this.logger.debug(
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
        const outcome = yield* this.runSingleDiff(
          pair,
          roundDiffDirectory,
          mathMarkup,
        );
        entries.push(outcome.entry);
        if (outcome.artifact) artifacts.push(outcome.artifact);
      }
      return { artifacts, entries, notRun: null };
    });
    return execute.pipe(
      recoverOutputFailure({
        logger: this.logger,
        level: 'error',
        label: 'Error during latexdiff processing',
        recover: (error) =>
          Effect.succeed(
            notRun(`the latexdiff pass failed: ${toErrorMessage(error)}`),
          ),
      }),
    );
  }

  /**
   * One pair's latexdiff and its compiled PDF, published with a `-diff` stem
   * suffix against the starting document and `-round-diff` against the
   * previous round. The diff is
   * written under `roundDiffDirectory` at its document's own folder, as the
   * round's output is under `r{round}/`: the diff file is named by the
   * document's file name, so `a/main.tex` and `b/main.tex` would otherwise
   * write the same `main_diff.tex`.
   */
  private runSingleDiff(
    { revised, document, base, baseRound, suffix }: LatexdiffPair,
    roundDiffDirectory: string,
    mathMarkup: LatexdiffMathMarkupValue,
  ): Effect.Effect<SingleDiffOutcome, never, DiffServices> {
    const relativePath = path.join(roundDiffDirectory, path.dirname(document));
    const diffDirectory: DiffOutputDirectory = {
      absolutePath: path.join(this.fileService.runDirectory, relativePath),
      relativePath,
      runId: this.fileService.runId,
    };
    const pair = {
      revised: revised.location,
      document: revised.lineage?.document ?? null,
      base,
      baseRound,
      mathMarkup,
    };
    const label = baseRound === null ? 'round-diff' : 'between-rounds-diff';
    // One pair's failure is that pair's entry, never the round's: the
    // other pairs keep their diffs.
    return Effect.gen({ self: this }, function* () {
      yield* this.ensureWorkspaceDependency(base);
      yield* this.ensureWorkspaceDependency(revised.location);

      const cwd = yield* this.getWorkingDirectory(revised.location);
      const diffPath = yield* latexdiff(base, revised.location, {
        roots: this.roots,
        cwd,
        suffix,
        outputDirectory: diffDirectory.absolutePath,
        mathMarkup,
      }).pipe(withLogChannel(this.runId));
      this.logger.debug('Successfully generated diff file', {
        data: { operation: label, diffPath },
      });

      const compiled = yield* this.compileDiff(
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
            this.logger.debug(line, { data: error });
          } else {
            this.logger.warn(line, { data: error });
          }
          return {
            entry: { ...pair, status: 'failed', error: message },
            artifact: null,
          };
        }),
      ),
    );
  }

  private readonly compileDiff = Effect.fn('LatexDiffManager.compileDiff')(
    { self: this },
    function* (
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

      const buildDir = path.join(
        path.dirname(diffLocation.absolutePath),
        'build',
      );
      // Reuse the workflow compile-check timeout so a hanging diff build
      // is torn down by its scope instead of orphaning latexmk/pdflatex.
      const timeoutMs = yield* getWorkflowAutoCompileTimeoutMs(this.roots);
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
        resolveWorkspaceSourceDir(this.roots, referenceLocation) ??
          path.dirname(referenceLocation.absolutePath),
      ].filter(Predicate.isNotNull);
      const compiled = yield* compileLatex2Pdf(diffLocation, this.roots, {
        channel: this.runId,
        outputDirectory: buildDir,
        timeout: timeoutMs,
        extraInputDirs,
      }).pipe(
        // No compiler costs this diff its PDF, not the diff itself.
        Effect.catchTag('ToolMissing', (missing) =>
          Effect.succeed({ ok: false, logTail: missing.message } as const),
        ),
      );

      if (!compiled.ok) {
        // Keep the missing auxiliary PDF visible, but leave the compiler tail
        // in structured diagnostic data. Dumping that tail into the message
        // makes a recoverable latexdiff failure dominate the transcript.
        this.logger.warn(
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

      const { runId, runDirectory } = this.fileService;
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
          this.logger.warn(
            `Failed to publish latexdiff PDF: ${toErrorMessage(error)}`,
            {
              data: {
                diffFile: diffLocation.absolutePath,
                compiledPdfPath: compiled.pdfPath,
                error,
              },
            },
          ),
      );
      return { diffLocation, artifact };
    },
  );
}
