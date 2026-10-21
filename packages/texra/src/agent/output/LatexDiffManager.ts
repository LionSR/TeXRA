import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { createRunStorageLocation } from '@texra-ai/harness';
import { RunFileService } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';
import { Settings } from '@texra-ai/harness';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { LaTeXdiffResult, LaTeXdiffService } from '@latex/latexdiff';
import { buildBetweenRoundDiffSuffix } from '@latex/latexdiff/diffFileNameManager';
import { compileLatex2Pdf } from '@latex/texTools';
import {
  fileLocationDisplayPath,
  type RunId,
  type FileLocation,
  type RunStorageFileLocation,
} from '@shared/schemas';
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
import type { WorkspaceFs, WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { RoundFileEntry, RoundFileMapping } from './types';

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

/** What a round's latexdiff pass wrote: the PDFs it published, and one entry
 *  per diffed pair for the round's documents fact. */
export interface RoundLatexdiffs {
  readonly artifacts: RunStorageFileLocation[];
  readonly entries: LatexdiffEntry[];
}

/** A pass that diffed nothing: a fresh value, since a caller owns the
 *  arrays it is handed. */
const noLatexdiffs = (): RoundLatexdiffs => ({ artifacts: [], entries: [] });

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly isRewrite: boolean,
    private readonly logger: AgentTrace,
    private readonly runId: RunId,
    private readonly fileService: RunFileService,
    /** The run's session roots: the workspace and setting stores it reads. */
    private readonly roots: WorkspaceRoots,
  ) {
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

  handleLatexdiffOfOutput(
    currRound: number,
    outputFiles: readonly OutputFileInfo[],
    mapping: RoundFileMapping,
  ): Effect.Effect<RoundLatexdiffs, never, DiffServices> {
    const execute = Effect.gen({ self: this }, function* () {
      if (!(yield* checkToolInstalled('latexdiff'))) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
        );
        return noLatexdiffs();
      }

      if (outputFiles.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
        );
        return noLatexdiffs();
      }

      // Ensure round-dir has symlinks to all mirrored deps so latexdiff's
      // relative \input{} resolution works when its cwd is runDir/r{round}.
      // The round's sources resolve beside its output, never over it; the
      // latexdiff directory holds no output of that name.
      yield* this.fileService.ensureMirroredInRunSubdir(
        workflowOutputRoundDir(currRound),
        { protectedStem: WORKFLOW_OUTPUT_BASENAME },
      );
      yield* this.fileService.ensureMirroredInRunSubdir(
        `diff/${workflowOutputRoundDir(currRound)}`,
      );
      const relativePath = path.join('diff', `r${currRound}`);
      const diffDirectory: DiffOutputDirectory = {
        absolutePath: path.join(this.fileService.runDirectory, relativePath),
        relativePath,
        runId: this.fileService.runId,
      };

      const outputByPath = new Map(
        outputFiles.map((f) => [fileLocationDisplayPath(f.location), f]),
      );

      this.logger.debug(`r${currRound} output files`, {
        data: outputFiles.map((f) => f.location.absolutePath),
      });

      const entries: LatexdiffEntry[] = [];
      const artifacts: RunStorageFileLocation[] = [];
      const collect = (outcome: SingleDiffOutcome | null): void => {
        if (!outcome) return;
        entries.push(outcome.entry);
        if (outcome.artifact) artifacts.push(outcome.artifact);
      };
      const collectPairs = (
        pick: (entry: RoundFileEntry) => FileLocation | undefined,
      ): [string, FileLocation][] => {
        const pairs: [string, FileLocation][] = [];
        for (const [outputPath, entry] of mapping) {
          const location = pick(entry);
          if (location) pairs.push([outputPath, location]);
        }
        return pairs;
      };

      if (this.isRewrite) {
        // A base file the mapping named but the workspace never held (an
        // agent whose declared output files are created by the run) has
        // nothing to diff against. Skip those pairs rather than gating the
        // whole call, so the between-round branch below still runs.
        const candidatePairs = collectPairs((entry) => entry.base);
        const fs = yield* FileSystem.FileSystem;
        const baseExists = yield* Effect.forEach(
          candidatePairs,
          ([, base]) =>
            Effect.map(
              entryTypeIn(fs, base.absolutePath),
              (type) => type !== undefined,
            ),
          { concurrency: 'unbounded' },
        );
        const basePairs = candidatePairs.filter((_, i) => baseExists[i]);
        if (basePairs.length < candidatePairs.length) {
          this.logger.debug(
            `Skipping ${candidatePairs.length - basePairs.length} latexdiff base pair(s): base file not present`,
          );
        }
        this.logPairMatches(basePairs, 'base files to output files');

        for (const [outputPath, baseLocation] of basePairs) {
          collect(
            yield* this.runSingleDiff({
              outputPath,
              baseLocation,
              outputByPath,
              originalLocation: baseLocation,
              baseRound: null,
              runDiff: (base, revised, cwd) =>
                this.latexdiffService.runDiff(
                  base,
                  revised,
                  '_diff',
                  undefined,
                  { cwd, outputDirectory: diffDirectory.absolutePath },
                ),
              label: 'round-diff',
              pdfStemSuffix: '-diff',
              diffDirectory,
            }),
          );
        }
      }

      const generateBetweenRoundDiffs = yield* Settings.get<boolean>(
        this.roots,
        DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS,
      );

      if (generateBetweenRoundDiffs && currRound > 0) {
        const prevPairs = collectPairs((entry) => entry.prev);
        this.logPairMatches(
          prevPairs,
          'previous round files to current round files',
        );

        for (const [outputPath, prevLocation] of prevPairs) {
          const originalLocation = mapping.get(outputPath)?.origin ?? null;
          collect(
            yield* this.runSingleDiff({
              outputPath,
              baseLocation: prevLocation,
              outputByPath,
              originalLocation,
              baseRound: currRound - 1,
              runDiff: (base, revised, cwd) =>
                this.latexdiffService.runDiff(
                  base,
                  revised,
                  buildBetweenRoundDiffSuffix(currRound, currRound - 1),
                  undefined,
                  { cwd, outputDirectory: diffDirectory.absolutePath },
                ),
              label: 'between-rounds-diff',
              pdfStemSuffix: '-round-diff',
              diffDirectory,
            }),
          );
        }
      } else if (!generateBetweenRoundDiffs) {
        this.logger.debug(
          'Skipping between-round latexdiff operations: disabled in settings',
        );
      }

      return { artifacts, entries };
    });
    return execute.pipe(
      recoverOutputFailure({
        logger: this.logger,
        level: 'error',
        label: 'Error during latexdiff processing',
        recover: () => Effect.sync(noLatexdiffs),
      }),
    );
  }

  private logPairMatches(
    pairs: [string, FileLocation][],
    description: string,
  ): void {
    if (pairs.length === 0) {
      this.logger.debug(`No ${description.split(' to ')[0]} mappings found`);
      return;
    }

    this.logger.debug(`Matched ${description}`, {
      data: pairs.map(
        ([outputPath, loc]) =>
          `${path.basename(fileLocationDisplayPath(loc))} -> ${path.basename(outputPath)}`,
      ),
    });
  }

  private runSingleDiff({
    outputPath,
    baseLocation,
    outputByPath,
    originalLocation,
    baseRound,
    runDiff,
    label,
    pdfStemSuffix,
    diffDirectory,
  }: {
    outputPath: string;
    baseLocation: FileLocation;
    outputByPath: Map<string, OutputFileInfo>;
    originalLocation: FileLocation | null;
    baseRound: number | null;
    runDiff: (
      base: FileLocation,
      revised: FileLocation,
      cwd: string,
    ) => Effect.Effect<
      LaTeXdiffResult,
      never,
      FileSystem.FileSystem | ChildProcessSpawner
    >;
    label: string;
    pdfStemSuffix: string;
    diffDirectory: DiffOutputDirectory;
  }): Effect.Effect<SingleDiffOutcome | null, never, DiffServices> {
    return Effect.gen({ self: this }, function* () {
      const revisedFile = outputByPath.get(outputPath);
      if (!revisedFile) {
        this.logger.debug(
          `Skipping diff: output file not found for path ${outputPath}`,
        );
        return null;
      }

      const pair = {
        revised: revisedFile.location,
        original: originalLocation,
        base: baseLocation,
        baseRound,
      };
      const failed = (error: string): SingleDiffOutcome => ({
        entry: { ...pair, status: 'failed', error },
        artifact: null,
      });
      // One pair's failure is that pair's entry, never the round's: the
      // other pairs keep their diffs.
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.ensureWorkspaceDependency(baseLocation);
        yield* this.ensureWorkspaceDependency(revisedFile.location);

        const cwd = yield* this.getWorkingDirectory(revisedFile.location);
        const result = yield* runDiff(baseLocation, revisedFile.location, cwd);
        this.logLatexdiffResult(result, label);
        if (!result.success) return failed(result.message);

        const compiled = yield* this.compileDiff(
          result.diffPath,
          baseLocation,
          diffDirectory,
          revisedFile.round,
          revisedFile.location,
          pdfStemSuffix,
        );
        return {
          entry: { ...pair, status: 'ok', diff: compiled.diffLocation },
          artifact: compiled.artifact,
        } satisfies SingleDiffOutcome;
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            const message = toErrorMessage(error);
            this.logger.warn(`${label} failed for ${outputPath}: ${message}`, {
              data: error,
            });
            return failed(message);
          }),
        ),
      );
    });
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
      // The diff `.tex` is written to `diff/r{round}/`, away from both the
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
