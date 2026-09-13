import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { LaTeXdiffResult, LaTeXdiffService } from '@latex/latexdiff';
import { compileLatex2Pdf } from '@latex/texTools';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  fileLocationDisplayPath,
  type DiffResult,
  type RunId,
  type FileLocation,
  MESSAGE_TYPES,
  type OutputFileInfo,
  type RoundIndexed,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { publishCompiledPdfArtifact } from './compiledPdfArtifacts';
import {
  getWorkflowAutoCompileTimeoutMs,
  resolveWorkspaceSourceDir,
} from './compileCheck';
import { fsCall, recoverOutputFailure } from './outputOperations';
import type { RoundFileEntry, RoundFileMapping } from './types';

interface DiffOutputDirectory {
  absolutePath: string;
  relativePath: string;
  runId: RunId;
}

type SingleDiffOutcome = {
  diffResult: DiffResult;
  artifact: RunStorageFileLocation | null;
};

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly isRewrite: boolean,
    private readonly getOutputFiles: () => RoundIndexed<OutputFileInfo>,
    private readonly logger: AgentTrace,
    private readonly runId: RunId,
    private readonly fileService: TaskRunFileService,
    /** The run's session roots: the workspace and setting stores it reads. */
    private readonly roots: WorkspaceRoots,
    /** The run's `inScope`: binds a call to the session's roots scope. */
    private readonly inScope: <A>(operation: () => A) => A,
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

  private logLatexdiffResult(
    result: LaTeXdiffResult,
    operation = 'latexdiff',
  ): void {
    if (result.success) {
      this.logger.debug('Successfully generated diff file', {
        data: { operation, diffPath: result.diffPath },
      });
      return;
    }

    if (result.message.includes('document environment')) {
      this.logger.debug(`Skipping ${operation}`, {
        data: result.message,
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      return;
    }

    this.logger.warn(`Failed to generate ${operation}`, {
      data: result.message,
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  /**
   * Mirror an existing workspace dependency into run storage so latexdiff's
   * relative `\input{}` resolution finds it. A mirror that fails is reported
   * and skipped — the diff below still runs and names whatever it could not
   * resolve.
   */
  private ensureWorkspaceDependency(
    targetLocation: FileLocation | null | undefined,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (!targetLocation) return;
      const exists = yield* fsCall(() =>
        AbsoluteFS.exists(targetLocation.absolutePath),
      );
      if (!exists) return;
      yield* fsCall(() =>
        this.fileService.mirrorWorkspaceFile(targetLocation),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            this.logger.warn('Unable to mirror workspace dependency', {
              data: { path: targetLocation.absolutePath, error },
              messageType: MESSAGE_TYPES.INTERNAL,
            });
          }),
        ),
      );
    });
  }

  handleLatexdiffOfOutput(
    currRound: number,
    mapping: RoundFileMapping,
  ): Effect.Effect<RunStorageFileLocation[], never, FileSystem.FileSystem> {
    const execute = Effect.gen({ self: this }, function* () {
      if (!(yield* fsCall(() => checkToolInstalled('latexdiff')))) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
        );
        return [];
      }

      const outputFiles = this.getOutputFiles()[currRound] ?? [];
      if (outputFiles.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
        );
        return [];
      }

      // Ensure round-dir has symlinks to all mirrored deps so latexdiff's
      // relative \input{} resolution works when its cwd is runDir/r{round}.
      yield* fsCall(() => this.fileService.ensureMirroredInRoundDir(currRound));
      yield* fsCall(() =>
        this.fileService.ensureMirroredInDiffRoundDir(currRound),
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

      const aggregated: DiffResult[] = [];
      const artifacts: RunStorageFileLocation[] = [];
      const collect = (outcome: SingleDiffOutcome | null): void => {
        if (!outcome) return;
        aggregated.push(outcome.diffResult);
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
        const baseExists = yield* Effect.forEach(
          candidatePairs,
          ([, base]) => fsCall(() => AbsoluteFS.exists(base.absolutePath)),
          { concurrency: 'unbounded' },
        );
        const basePairs = candidatePairs.filter(
          (_, index) => baseExists[index],
        );
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
                this.latexdiffService.runDiffForRound(
                  base,
                  revised,
                  currRound,
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

      const generateBetweenRoundDiffs = readSettingFrom<boolean>(
        this.roots,
        WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
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
                this.latexdiffService.runDiffBetweenRounds(
                  base,
                  revised,
                  currRound - 1,
                  currRound,
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

      if (aggregated.length > 0) {
        this.logger.domain({
          key: 'latexdiff',
          text: `Latexdiff results: ${aggregated.length}`,
          data: aggregated,
        });
      } else {
        this.logger.debug('No latexdiff results to report');
      }

      return artifacts;
    });
    return execute.pipe(
      recoverOutputFailure({
        logger: this.logger,
        level: 'error',
        label: 'Error during latexdiff processing',
        recover: () => Effect.succeed<RunStorageFileLocation[]>([]),
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
    ) => Effect.Effect<LaTeXdiffResult>;
    label: string;
    pdfStemSuffix: string;
    diffDirectory: DiffOutputDirectory;
  }): Effect.Effect<SingleDiffOutcome | null, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const revisedFile = outputByPath.get(outputPath);
      if (!revisedFile) {
        this.logger.debug(
          `Skipping diff: output file not found for path ${outputPath}`,
        );
        return null;
      }

      yield* this.ensureWorkspaceDependency(baseLocation);
      yield* this.ensureWorkspaceDependency(revisedFile.location);

      const cwd = yield* this.getWorkingDirectory(revisedFile.location);
      const result = yield* runDiff(baseLocation, revisedFile.location, cwd);
      this.logLatexdiffResult(result, label);

      const compiled = yield* this.compileDiffIfSuccessful(
        result,
        baseLocation,
        diffDirectory,
        revisedFile.round,
        revisedFile.location,
        pdfStemSuffix,
      );
      const diffLocation = compiled?.diffLocation ?? null;

      const revisedWithLineage: OutputFileInfo = {
        ...revisedFile,
        lineage: {
          original: originalLocation,
          diffBase: baseLocation,
        },
      };

      return {
        diffResult: {
          baseLocation,
          baseRound,
          revised: revisedWithLineage,
          diffLocation,
          status: result.success ? 'success' : 'error',
          message: result.success ? undefined : result.message,
        },
        artifact: compiled?.artifact ?? null,
      };
    });
  }

  private compileDiffIfSuccessful(
    result: LaTeXdiffResult,
    referenceLocation: FileLocation,
    diffDirectory: DiffOutputDirectory,
    round: number,
    sourceLocation: FileLocation,
    pdfStemSuffix: string,
  ): Effect.Effect<
    {
      diffLocation: FileLocation;
      artifact: RunStorageFileLocation | null;
    } | null,
    Error,
    FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      if (!result.success) {
        return null;
      }

      const diffFileName = path.basename(result.diffPath);
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
      // gets killed by execa instead of orphaning latexmk/pdflatex.
      const timeoutMs = getWorkflowAutoCompileTimeoutMs(this.roots);
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
      const compiled = yield* fsCall(() =>
        // Session-scoped until #12421 roots src/latex; see #12433.
        this.inScope(() =>
          compileLatex2Pdf(diffLocation, {
            channel: this.runId,
            outputDirectory: buildDir,
            timeout: timeoutMs,
            extraInputDirs,
          }),
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
      const artifact = yield* publishCompiledPdfArtifact({
        runDirectory,
        runId,
        round,
        displayName: path.basename(diffLocation.absolutePath),
        source: sourceLocation,
        compiledPdfPath: compiled.pdfPath,
        pdfStemSuffix,
      }).pipe(
        // Publishing the auxiliary PDF is best effort: a copy that failed is
        // reported here and leaves the diff `.tex` itself intact.
        Effect.catch((error) =>
          Effect.sync((): RunStorageFileLocation | null => {
            this.logger.warn(
              `Failed to publish latexdiff PDF: ${toErrorMessage(error)}`,
              {
                data: {
                  diffFile: diffLocation.absolutePath,
                  compiledPdfPath: compiled.pdfPath,
                  error,
                },
              },
            );
            return null;
          }),
        ),
      );
      return { diffLocation, artifact };
    });
  }
}
