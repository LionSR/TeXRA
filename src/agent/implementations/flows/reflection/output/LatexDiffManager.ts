import * as path from 'node:path';

import type { AgentTrace, StageHandle } from '@agent/trace';
import { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import { LaTeXdiffResult, LaTeXdiffService } from '@latex/latexdiff';
import { compileLatex2Pdf } from '@latex/texTools';
import { platform } from '@platform/platform';
import {
  type DiffResult,
  type ExecutionId,
  type FileLocation,
  MESSAGE_TYPES,
  type OutputFileInfo,
  type RoundIndexed,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import {
  createRunStorageLocation,
  getComparablePath,
} from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  publishCompiledPdfArtifact,
  type CompiledPdfArtifact,
} from './compiledPdfArtifacts';
import {
  getWorkflowAutoCompileTimeoutMs,
  resolveWorkspaceSourceDir,
} from './compileCheck';
import { tryOperation } from './outputOperations';
import type { RoundFileEntry, RoundFileMapping } from './types';

interface DiffOutputDirectory {
  absolutePath: string;
  relativePath: string;
  executionId: ExecutionId;
}

type SingleDiffOutcome = {
  diffResult: DiffResult;
  artifact: CompiledPdfArtifact | null;
};

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly agentSetting: AgentWorkflowSetting,
    private readonly getOutputFiles: () => RoundIndexed<OutputFileInfo>,
    private readonly baseFiles: FileLocation[],
    private readonly logger: AgentTrace,
    private readonly streamId: string,
    private readonly fileService: TaskRunFileService,
  ) {
    this.latexdiffService = new LaTeXdiffService(streamId);
  }

  private async getWorkingDirectory(location: FileLocation): Promise<string> {
    const resolved = await platform()
      .fs.realPath(location.absolutePath)
      .catch(() => location.absolutePath);
    return path.dirname(resolved);
  }

  private logLatexdiffResult(
    result: LaTeXdiffResult,
    operation = 'latexdiff',
  ): void {
    if (result.success) {
      this.logger.debug('Successfully generated diff file', {
        data: { operation, diffFileName: result.diffFileName },
      });
      return;
    }

    if (result.message?.includes('document environment')) {
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

  private async ensureWorkspaceDependency(
    targetLocation: FileLocation | null | undefined,
  ): Promise<void> {
    if (
      !targetLocation ||
      !(await AbsoluteFS.exists(targetLocation.absolutePath))
    ) {
      return;
    }

    try {
      await this.fileService.mirrorWorkspaceFile(targetLocation);
    } catch (error) {
      this.logger.warn('Unable to mirror workspace dependency', {
        data: { path: targetLocation.absolutePath, error },
        messageType: MESSAGE_TYPES.INTERNAL,
      });
    }
  }

  async handleLatexdiffOfOutput(
    currRound: number,
    mapping: RoundFileMapping,
    stage?: StageHandle,
  ): Promise<CompiledPdfArtifact[]> {
    const execute = async (): Promise<CompiledPdfArtifact[]> => {
      if (!(await checkToolInstalled('latexdiff'))) {
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
      await this.fileService.ensureMirroredInRoundDir(currRound);
      await this.fileService.ensureMirroredInDiffRoundDir(currRound);
      const relativePath = path.join('diff', `r${currRound}`);
      const diffDirectory: DiffOutputDirectory = {
        absolutePath: path.join(this.fileService.runDirectory, relativePath),
        relativePath,
        executionId: this.fileService.executionId,
      };

      const outputByPath = new Map(
        outputFiles.map((f) => [getComparablePath(f.location), f]),
      );

      this.logger.debug('Base files', {
        data: this.baseFiles.map((f) => f.absolutePath),
      });
      this.logger.debug(`r${currRound} output files`, {
        data: outputFiles.map((f) => f.location.absolutePath),
      });

      const aggregated: DiffResult[] = [];
      const artifacts: CompiledPdfArtifact[] = [];
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

      if (this.agentSetting.isRewrite) {
        const basePairs = collectPairs((entry) => entry.base);
        this.logPairMatches(basePairs, 'base files to output files');

        for (const [outputPath, baseLocation] of basePairs) {
          collect(
            await this.runSingleDiff({
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

      const generateBetweenRoundDiffs = readPlatformSetting<boolean>(
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
            await this.runSingleDiff({
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
                  {
                    cwd,
                    outputDirectory: diffDirectory.absolutePath,
                  },
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
    };
    return tryOperation(() => (stage ? stage.within(execute) : execute()), {
      logger: this.logger,
      level: 'error',
      label: 'Error during latexdiff processing',
      recover: () => [],
    });
  }

  private logPairMatches(
    pairs: [string, FileLocation][],
    description: string,
  ): void {
    if (pairs.length === 0) {
      if (this.baseFiles.length > 0) {
        this.logger.debug(`No ${description.split(' to ')[0]} mappings found`);
      }
      return;
    }

    this.logger.debug(`Matched ${description}`, {
      data: pairs.map(
        ([outputPath, loc]) =>
          `${path.basename(getComparablePath(loc))} -> ${path.basename(outputPath)}`,
      ),
    });
  }

  private async runSingleDiff({
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
    ) => Promise<LaTeXdiffResult>;
    label: string;
    pdfStemSuffix: string;
    diffDirectory: DiffOutputDirectory;
  }): Promise<SingleDiffOutcome | null> {
    const revisedFile = outputByPath.get(outputPath);
    if (!revisedFile) {
      this.logger.debug(
        `Skipping diff: output file not found for path ${outputPath}`,
      );
      return null;
    }

    await this.ensureWorkspaceDependency(baseLocation);
    await this.ensureWorkspaceDependency(revisedFile.location);

    const cwd = await this.getWorkingDirectory(revisedFile.location);
    const result = await runDiff(baseLocation, revisedFile.location, cwd);
    this.logLatexdiffResult(result, label);

    const compiled = await this.compileDiffIfSuccessful(
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
        diffFile: diffLocation,
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
  }

  private async compileDiffIfSuccessful(
    result: LaTeXdiffResult,
    referenceLocation: FileLocation,
    diffDirectory: DiffOutputDirectory,
    round: number,
    sourceLocation: FileLocation,
    pdfStemSuffix: string,
  ): Promise<{
    diffLocation: FileLocation;
    artifact: CompiledPdfArtifact | null;
  } | null> {
    if (!result.success || !result.diffFileName) {
      return null;
    }

    const diffLocation = createRunStorageLocation(
      path.join(diffDirectory.absolutePath, result.diffFileName),
      path.join(diffDirectory.relativePath, result.diffFileName),
      diffDirectory.executionId,
    );

    const buildDir = path.join(
      path.dirname(diffLocation.absolutePath),
      'build',
    );
    // Reuse the workflow compile-check timeout so a hanging diff build
    // gets killed by execa instead of orphaning latexmk/pdflatex.
    const timeoutMs = getWorkflowAutoCompileTimeoutMs();
    // The diff `.tex` is written to `diff/r{round}/`, away from both the
    // revised round output and the live workspace source. Search the revised
    // round directory first so same-round sibling edits win, then fall back to
    // the original source tree for unchanged inputs and bibliographies.
    const extraInputDirs = [
      sourceLocation.kind === 'runStorage'
        ? path.dirname(sourceLocation.absolutePath)
        : null,
      // Snapshot bases live under `original/`, while between-round bases live
      // under `r<N>/`; map either back without confusing a real `r<N>` folder.
      resolveWorkspaceSourceDir(referenceLocation) ??
        path.dirname(referenceLocation.absolutePath),
    ].filter((dir): dir is string => dir !== null);
    const compiled = await compileLatex2Pdf(diffLocation, {
      channel: this.streamId,
      outputDirectory: buildDir,
      timeout: timeoutMs,
      extraInputDirs,
    });

    if (!compiled.ok) {
      // Keep the missing auxiliary PDF visible, but leave the compiler tail in
      // structured diagnostic data. Dumping that tail into the message makes a
      // recoverable latexdiff failure dominate the workflow transcript.
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

    const { executionId, runDirectory } = this.fileService;
    const compiledPdfPath = path.join(
      buildDir,
      `${path.basename(diffLocation.absolutePath).replace(/\.tex$/i, '')}.pdf`,
    );
    try {
      const artifact = await publishCompiledPdfArtifact({
        runDirectory,
        executionId,
        round,
        displayName: path.basename(diffLocation.absolutePath),
        source: sourceLocation,
        compiledPdfPath,
        pdfStemSuffix,
      });
      return { diffLocation, artifact };
    } catch (error) {
      this.logger.warn(
        `Failed to publish latexdiff PDF: ${toErrorMessage(error)}`,
        {
          data: {
            diffFile: diffLocation.absolutePath,
            compiledPdfPath,
            error,
          },
        },
      );
      return { diffLocation, artifact: null };
    }
  }
}
