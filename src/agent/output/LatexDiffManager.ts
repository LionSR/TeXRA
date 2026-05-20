import * as path from 'path';

import { platform } from '@platform/platform';
import { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { getWorkspaceState } from '@agent/core/stateStore';
import { toErrorMessage } from '@common/errors';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { compileLatex2Pdf } from '@latex/texTools';
import { LaTeXdiffResult, LaTeXdiffService } from '@latex/latexdiff';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import {
  type DiffResult,
  type ExecutionId,
  MESSAGE_TYPES,
  type OutputFileInfo,
} from '@shared/schemas';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
} from '@shared/constants/latex';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
  flexibleFS,
  TaskRunFileService,
  type FileLocation,
} from '@utils/files';
import { checkToolInstalled } from '@utils/system';
import { getComparablePath } from '@utils/files/taskRunStorage';

import {
  publishCompiledPdfArtifact,
  type CompiledPdfArtifact,
} from './compiledPdfArtifacts';
import type { RoundFileMapping } from './types';

interface DiffOutputDirectory {
  absolutePath: string;
  relativePath: string;
  executionId: ExecutionId;
}

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly agentSetting: AgentWorkflowSetting,
    private readonly getOutputFiles: () => { [key: number]: OutputFileInfo[] },
    private readonly baseFiles: FileLocation[],
    private readonly logger: AgentLogger,
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
    operation: string = 'latexdiff',
  ): void {
    if (result.success) {
      this.logger.debug(
        `Successfully generated ${operation} file: ${result.diffFileName}`,
      );
      return;
    }

    if (result.message?.includes('document environment')) {
      this.logger.debug(`Skipping ${operation}: ${result.message}`, {
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      return;
    }

    this.logger.warn(`Failed to generate ${operation}: ${result.message}`, {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  private getDisplayLabel(location: FileLocation): string {
    return path.basename(getComparablePath(location));
  }

  private async ensureWorkspaceDependency(
    targetLocation: FileLocation | null | undefined,
  ): Promise<void> {
    if (!targetLocation || !(await flexibleFS.exists(targetLocation))) {
      return;
    }

    try {
      await this.fileService.mirrorWorkspaceFile(targetLocation);
    } catch (error) {
      this.logger.warn(
        `Unable to mirror workspace dependency ${targetLocation.absolutePath}: ${toErrorMessage(error)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
    }
  }

  async handleLatexdiffofOutput(
    currRound: number,
    mapping: RoundFileMapping,
    stage?: AgentLogStage,
  ): Promise<CompiledPdfArtifact[]> {
    const execute = () => this.performLatexdiffOperations(currRound, mapping);
    try {
      return await (stage ? stage.within(execute) : execute());
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${toErrorMessage(err)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
      return [];
    }
  }

  private async performLatexdiffOperations(
    currRound: number,
    mapping: RoundFileMapping,
  ): Promise<CompiledPdfArtifact[]> {
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
    const diffDirectory = this.getDiffOutputDirectory(currRound);

    const outputByPath = new Map(
      outputFiles.map((f) => [getComparablePath(f.location), f]),
    );

    this.logger.debug(
      `Base files: ${this.baseFiles.map((f) => f.absolutePath).join(', ')}`,
    );
    this.logger.debug(
      `r${currRound} output files: ${outputFiles.map((f) => f.location.absolutePath)}`,
    );

    const aggregated: DiffResult[] = [];
    const artifacts: CompiledPdfArtifact[] = [];

    if (this.agentSetting.isRewrite) {
      const basePairs = [...mapping.baseToOutput.entries()];
      this.logPairMatches(basePairs, 'base files to output files');

      for (const [outputPath, baseLocation] of basePairs) {
        const result = await this.runSingleDiff({
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
              { cwd, outputDirectory: diffDirectory?.absolutePath },
            ),
          label: 'round-diff',
          pdfStemSuffix: '-diff',
          diffDirectory,
        });
        if (result) {
          aggregated.push(result.diffResult);
          if (result.artifact) artifacts.push(result.artifact);
        }
      }
    }

    const generateBetweenRoundDiffs = getWorkspaceState().get<boolean>(
      WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
      LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds,
    );

    if (generateBetweenRoundDiffs && currRound > 0) {
      const prevPairs = [...mapping.prevToOutput.entries()];
      this.logPairMatches(
        prevPairs,
        'previous round files to current round files',
      );

      for (const [outputPath, prevLocation] of prevPairs) {
        const originalLocation = mapping.originByOutput.get(outputPath) ?? null;
        const result = await this.runSingleDiff({
          outputPath,
          baseLocation: prevLocation,
          outputByPath,
          originalLocation,
          baseRound: currRound - 1,
          runDiff: (base, revised, cwd) =>
            this.latexdiffService.runDiffBetweenRounds(
              base,
              revised,
              undefined,
              {
                cwd,
                outputDirectory: diffDirectory?.absolutePath,
              },
            ),
          label: 'between-rounds-diff',
          pdfStemSuffix: '-round-diff',
          diffDirectory,
        });
        if (result) {
          aggregated.push(result.diffResult);
          if (result.artifact) artifacts.push(result.artifact);
        }
      }
    } else if (!generateBetweenRoundDiffs) {
      this.logger.debug(
        'Skipping between-round latexdiff operations: disabled in settings',
      );
    }

    if (aggregated.length > 0) {
      this.logger.latexDiff(aggregated);
    } else {
      this.logger.debug('No latexdiff results to report');
    }

    return artifacts;
  }

  private logPairMatches(
    pairs: [string, FileLocation][],
    description: string,
  ): void {
    if (pairs.length > 0) {
      this.logger.debug(
        `Matched ${description}: ${pairs
          .map(
            ([outputPath, loc]) =>
              `${this.getDisplayLabel(loc)} -> ${path.basename(outputPath)}`,
          )
          .join(', ')}`,
      );
    } else if (this.baseFiles.length > 0) {
      this.logger.debug(`No ${description.split(' to ')[0]} mappings found`);
    }
  }

  private async runSingleDiff(params: {
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
    diffDirectory: DiffOutputDirectory | null;
  }): Promise<{
    diffResult: DiffResult;
    artifact: CompiledPdfArtifact | null;
  } | null> {
    const {
      outputPath,
      baseLocation,
      outputByPath,
      originalLocation,
      baseRound,
      runDiff,
      label,
      pdfStemSuffix,
      diffDirectory,
    } = params;

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
    diffDirectory: DiffOutputDirectory | null,
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

    const diffLocation = this.buildDiffLocation(
      referenceLocation,
      result.diffFileName,
      diffDirectory,
    );

    const buildDir = path.join(
      path.dirname(diffLocation.absolutePath),
      'build',
    );
    // Reuse the workflow compile-check timeout so a hanging diff build
    // gets killed by execa instead of orphaning latexmk/pdflatex.
    const timeoutMs = Math.max(
      LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min,
      getWorkspaceState().get<number>(
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
        LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs,
      ),
    );
    const ok = await compileLatex2Pdf(diffLocation, {
      channel: this.streamId,
      outputDirectory: buildDir,
      timeout: timeoutMs,
    });

    if (!ok) {
      return { diffLocation, artifact: null };
    }

    const { executionId, runDirectory } = this.fileService.metadata;
    const compiledPdfPath = path.join(
      buildDir,
      `${path.basename(diffLocation.absolutePath).replace(/\.tex$/i, '')}.pdf`,
    );
    const artifact =
      executionId && runDirectory
        ? await publishCompiledPdfArtifact({
            runDirectory,
            executionId,
            round,
            displayName: path.basename(diffLocation.absolutePath),
            source: sourceLocation,
            compiledPdfPath,
            pdfStemSuffix,
          })
        : null;

    return { diffLocation, artifact };
  }

  /**
   * Describe the diff file that LaTeXdiffService wrote. Workflow runs pass a
   * run-storage output directory so the generated `.tex` and build artifacts
   * stay out of the user's workspace. Older callers that do not have run
   * storage keep the historical sibling placement.
   */
  private buildDiffLocation(
    reference: FileLocation,
    diffFileName: string,
    diffDirectory: DiffOutputDirectory | null,
  ): FileLocation {
    if (diffDirectory) {
      const absolutePath = path.join(diffDirectory.absolutePath, diffFileName);
      return createRunStorageLocation(
        absolutePath,
        path.join(diffDirectory.relativePath, diffFileName),
        diffDirectory.executionId,
      );
    }

    const siblingAbsolute = path.join(
      path.dirname(reference.absolutePath),
      diffFileName,
    );
    if (reference.kind === 'workspace') {
      const relativeDir = path.dirname(reference.relativePath);
      return createWorkspaceLocation(
        siblingAbsolute,
        path.join(relativeDir, diffFileName),
      );
    }
    if (reference.kind === 'runStorage') {
      const relativeDir = path.dirname(reference.relativePath);
      return createRunStorageLocation(
        siblingAbsolute,
        path.join(relativeDir, diffFileName),
        reference.executionId,
      );
    }
    return createExternalLocation(siblingAbsolute);
  }

  private getDiffOutputDirectory(round: number): DiffOutputDirectory | null {
    const { executionId, runDirectory } = this.fileService.metadata;
    if (!executionId || !runDirectory) {
      return null;
    }

    const relativePath = path.join('diff', `r${round}`);
    return {
      absolutePath: path.join(runDirectory, relativePath),
      relativePath,
      executionId,
    };
  }
}
