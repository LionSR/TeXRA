import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { createRunStorageLocation, Settings } from '@texra-ai/harness/host';
import { RunFileService } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';
import {
  toErrorMessage,
  fileLocationDisplayPath,
  type RunId,
  type FileLocation,
  type RunStorageFileLocation,
} from '@texra-ai/harness/schemas';
import { LaTeXdiffResult, LaTeXdiffService } from '@latex/latexdiff';
import { buildBetweenRoundDiffSuffix } from '@latex/latexdiff/diffFileNameManager';
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
  workflowOutputRoundDir,
} from '@texra/shared/constants/workflowOutput';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { checkToolInstalled } from '@texra/utils/system/toolChecks';

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
export interface RoundLatexdiffs {
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
  private readonly latexdiffService: LaTeXdiffService;

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
    this.latexdiffService = new LaTeXdiffService(runId, roots);
  }

  /**
   * The directory latexdiff runs in: the revised file's own folder, with
   * symlinks resolved so a mirrored dependency's relative `\input{}` still
   * points at real siblings. A path the filesystem cannot canonicalize (it
   * was removed under us, or a link cycle) falls back to the path as given —
   * the same directory latexdiff would have used without resolution.
   */
  private getWorkingDirectory(
    location: FileLocation,
  ): Effect.Effect<string, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const resolved = yield* fs
        .realPath(location.absolutePath)
        .pipe(Effect.orElseSucceed(() => location.absolutePath));
      return path.dirname(resolved);
    });
  }

  private logLatexdiffResult(result: LaTeXdiffResult, operation: string): void {
    if (result.success) {
      this.logger.debug('Successfully generated diff file', {
        data: { operation, diffPath: result.diffPath },
      });
      return;
    }

    if (result.reason === 'missing-document-environment') {
      this.logger.debug(`Skipping ${operation}`, {
        data: result.message,
      });
      return;
    }

    this.logger.warn(`Failed to generate ${operation}`, {
      data: result.message,
    });
  }

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
    const execute = Effect.gen({ self: this }, function* () {
      if (!(yield* checkToolInstalled('latexdiff'))) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
        );
        return notRun('latexdiff is not installed');
      }

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
      yield* this.fileService.ensureMirroredInRunSubdir(
        workflowOutputRoundDir(currRound),
        { protectedStem: WORKFLOW_OUTPUT_BASENAME },
      );
      const roundDiffDirectory = `diff/${workflowOutputRoundDir(currRound)}`;
      yield* this.fileService.ensureMirroredInRunSubdir(roundDiffDirectory);

      this.logger.debug(`r${currRound} output files`, {
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
          pair.baseRound === null
            ? { suffix: '_diff', label: 'round-diff', pdfStemSuffix: '-diff' }
            : {
                suffix: buildBetweenRoundDiffSuffix(currRound, pair.baseRound),
                label: 'between-rounds-diff',
                pdfStemSuffix: '-round-diff',
              },
          roundDiffDirectory,
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
   * One pair's latexdiff and its compiled PDF: `suffix` names the diff file,
   * `label` the log lines, `pdfStemSuffix` the published PDF. The diff is
   * written under `roundDiffDirectory` at its document's own folder, as the
   * round's output is under `r{round}/`: the diff file is named by the
   * document's file name, so `a/main.tex` and `b/main.tex` would otherwise
   * write the same `main_diff.tex`.
   */
  private runSingleDiff(
    { revised, document, base, baseRound }: LatexdiffPair,
    kind: { suffix: string; label: string; pdfStemSuffix: string },
    roundDiffDirectory: string,
  ): Effect.Effect<SingleDiffOutcome, never, DiffServices> {
    const relativePath = path.join(roundDiffDirectory, path.dirname(document));
    const diffDirectory: DiffOutputDirectory = {
      absolutePath: path.join(this.fileService.runDirectory, relativePath),
      relativePath,
      runId: this.fileService.runId,
    };
    const pair = {
      revised: revised.location,
      original: revised.lineage?.original ?? null,
      base,
      baseRound,
    };
    const failed = (error: string): SingleDiffOutcome => ({
      entry: { ...pair, status: 'failed', error },
      artifact: null,
    });
    // One pair's failure is that pair's entry, never the round's: the
    // other pairs keep their diffs.
    return Effect.gen({ self: this }, function* () {
      yield* this.ensureWorkspaceDependency(base);
      yield* this.ensureWorkspaceDependency(revised.location);

      const cwd = yield* this.getWorkingDirectory(revised.location);
      const result = yield* this.latexdiffService.runDiff(
        base,
        revised.location,
        kind.suffix,
        undefined,
        { cwd, outputDirectory: diffDirectory.absolutePath },
      );
      this.logLatexdiffResult(result, kind.label);
      if (!result.success) return failed(result.message);

      const compiled = yield* this.compileDiff(
        result.diffPath,
        base,
        diffDirectory,
        revised.round,
        revised.location,
        kind.pdfStemSuffix,
      );
      return {
        entry: { ...pair, status: 'ok', diff: compiled.diffLocation },
        artifact: compiled.artifact,
      } satisfies SingleDiffOutcome;
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const message = toErrorMessage(error);
          this.logger.warn(
            `${kind.label} failed for ${fileLocationDisplayPath(revised.location)}: ${message}`,
            { data: error },
          );
          return failed(message);
        }),
      ),
    );
  }

  private compileDiff(
    diffPath: string,
    referenceLocation: FileLocation,
    diffDirectory: DiffOutputDirectory,
    round: number,
    sourceLocation: FileLocation,
    pdfStemSuffix: string,
  ): Effect.Effect<
    {
      diffLocation: FileLocation;
      artifact: RunStorageFileLocation | null;
    },
    Error,
    DiffServices
  > {
    return Effect.gen({ self: this }, function* () {
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
      ].filter((dir): dir is string => dir !== null);
      const compiled = yield* compileLatex2Pdf(diffLocation, this.roots, {
        channel: this.runId,
        outputDirectory: buildDir,
        timeout: timeoutMs,
        extraInputDirs,
      });

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
    });
  }
}
