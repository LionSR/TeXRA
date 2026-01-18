// Standard library imports
import { promises as fs } from 'fs';
import * as path from 'path';

// Local imports - agent
import { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';
import { checkToolInstalled } from '@utils/system';
import {
  TaskRunFileService,
  flexibleFS,
  type FileLocation,
} from '@utils/files';

// Internal imports
import {
  getComparablePath,
  getFileDirectory,
} from '@utils/files/taskRunStorage';
import { compileLatex2Pdf } from '@latex/texTools';
import { LaTeXdiffService, LaTeXdiffResult } from '@latex/latexdiff';

// Local imports - types
import type { OutputFileInfo, RoundFileMapping } from './types';

/**
 * Result of a latexdiff operation with file locations.
 */
interface DiffOperationResult {
  baseLabel: string;
  revisedLabel: string;
  status: 'success' | 'error';
  message?: string;
  locations: {
    base: FileLocation | null;
    revised: FileLocation | null;
    diff: FileLocation | null;
  };
}

interface LatexDiffDependencies {
  checkToolInstalled: typeof checkToolInstalled;
  compileLatex2Pdf: typeof compileLatex2Pdf;
  getConfig: typeof getConfig;
}

const defaultLatexDiffDependencies: LatexDiffDependencies = {
  checkToolInstalled,
  compileLatex2Pdf,
  getConfig,
};

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly agentSetting: AgentWorkflowSetting,
    private readonly getOutputFiles: () => { [key: number]: OutputFileInfo[] },
    private readonly baseFiles: FileLocation[],
    private readonly logger: AgentLogger,
    private readonly channel: string,
    private readonly fileService: TaskRunFileService,
    private readonly dependencies: LatexDiffDependencies = defaultLatexDiffDependencies,
  ) {
    this.latexdiffService = new LaTeXdiffService(channel);
  }

  /**
   * Resolve symlinks for latexdiff compatibility.
   * (latexdiff may have issues with symlinks in some configurations)
   */
  private async resolveSymlinks(target: string): Promise<string> {
    try {
      return await fs.realpath(target);
    } catch (_err) {
      return target;
    }
  }

  /**
   * Get working directory for latexdiff - use file's directory so relative includes work.
   */
  private async getWorkingDirectory(location: FileLocation): Promise<string> {
    const resolved = await this.resolveSymlinks(location.absolutePath);
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

    if (result.message && result.message.includes('document environment')) {
      this.logger.debug(`Skipping ${operation}: ${result.message}`, {
        messageType: MESSAGE_TYPES.INTERNAL,
      });
      return;
    }

    this.logger.warn(`Failed to generate ${operation}: ${result.message}`, {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  /**
   * Get display label (basename) from FileLocation for UI/logging.
   */
  private getDisplayLabel(location: FileLocation): string {
    return path.basename(getComparablePath(location));
  }

  private async ensureWorkspaceDependency(
    targetLocation: FileLocation | null | undefined,
  ): Promise<void> {
    if (!targetLocation) {
      return;
    }

    if (!(await flexibleFS.exists(targetLocation))) {
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
  ): Promise<void> {
    const execute = () => this.performLatexdiffOperations(currRound, mapping);

    try {
      await (stage ? stage.within(execute) : execute());
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${toErrorMessage(err)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
    }
  }

  private async performLatexdiffOperations(
    currRound: number,
    mapping: RoundFileMapping,
  ): Promise<void> {
    if (!(await this.dependencies.checkToolInstalled('latexdiff'))) {
      this.logger.warn(
        'Skipping latexdiff operations - latexdiff not installed',
      );
      return;
    }

    const outputFiles = this.getOutputFiles()[currRound] ?? [];
    const outputPaths = outputFiles.map((entry) => entry.location.absolutePath);
    if (outputPaths.length === 0) {
      this.logger.warn(
        `No output files found for round ${currRound}, skipping latexdiff operations`,
      );
      return;
    }

    this.logger.debug(
      `Base files: ${this.baseFiles.map((f) => f.absolutePath).join(', ')}`,
    );
    this.logger.debug(`r${currRound} output files: ${outputPaths}`);

    const basePairs = [...mapping.baseToOutput.entries()];
    if (basePairs.length > 0) {
      this.logger.debug(
        `Matched base files to output files: ${basePairs
          .map(
            ([outputPath, base]) =>
              `${this.getDisplayLabel(base)} -> ${path.basename(outputPath)}`,
          )
          .join(', ')}`,
      );
    } else if (this.baseFiles.length > 0) {
      this.logger.debug(
        'No base file mappings found for current round outputs',
      );
    }

    const aggregated: DiffOperationResult[] = [];

    if (this.agentSetting.isRewrite) {
      this.logger.debug('Running round-based latexdiff operations');
      for (const [outputPath, baseLocation] of basePairs) {
        const revisedLocation = outputFiles.find(
          (o: OutputFileInfo) => getComparablePath(o.location) === outputPath,
        )?.location;
        if (!revisedLocation) {
          this.logger.debug(
            `Skipping diff: output file not found for path ${outputPath}`,
          );
          continue;
        }
        await this.ensureWorkspaceDependency(baseLocation);
        await this.ensureWorkspaceDependency(revisedLocation);

        const cwd = await this.getWorkingDirectory(revisedLocation);
        const result = await this.latexdiffService.runDiffForRound(
          baseLocation,
          revisedLocation,
          currRound,
          undefined,
          { cwd },
        );
        this.logLatexdiffResult(result, 'round-diff');

        const diffLocation = await this.compileDiffIfSuccessful(
          result,
          baseLocation,
        );

        aggregated.push({
          baseLabel: this.getDisplayLabel(baseLocation),
          revisedLabel: this.getDisplayLabel(revisedLocation),
          status: result.success ? 'success' : 'error',
          message: result.success ? undefined : result.message,
          locations: {
            base: baseLocation,
            revised: revisedLocation,
            diff: diffLocation,
          },
        });
      }
    }

    const generateBetweenRoundDiffs = this.dependencies.getConfig<boolean>(
      'texra.latexdiff.generateBetweenRoundDiffs',
      false,
    );

    if (generateBetweenRoundDiffs && currRound > 0) {
      this.logger.debug('Running between-rounds latexdiff operations');
      const prevPairs = [...mapping.prevToOutput.entries()];

      if (prevPairs.length > 0) {
        this.logger.debug(
          `Matched previous round files to current round files: ${prevPairs
            .map(
              ([outputPath, prev]) =>
                `${this.getDisplayLabel(prev)} -> ${path.basename(outputPath)}`,
            )
            .join(', ')}`,
        );
      } else {
        this.logger.debug(
          'No previous round mappings found for current round outputs',
        );
      }

      for (const [outputPath, prevLocation] of prevPairs) {
        const currLocation = outputFiles.find(
          (o: OutputFileInfo) => getComparablePath(o.location) === outputPath,
        )?.location;

        if (!currLocation) {
          this.logger.debug(
            `Skipping diff: current round file not found for path ${outputPath}`,
          );
          continue;
        }
        await this.ensureWorkspaceDependency(prevLocation);
        await this.ensureWorkspaceDependency(currLocation);

        const cwd = await this.getWorkingDirectory(currLocation);
        const result = await this.latexdiffService.runDiffBetweenRounds(
          prevLocation,
          currLocation,
          undefined,
          { cwd },
        );
        this.logLatexdiffResult(result, 'between-rounds-diff');

        const diffLocation = await this.compileDiffIfSuccessful(
          result,
          prevLocation ?? currLocation,
        );

        aggregated.push({
          baseLabel: this.getDisplayLabel(prevLocation),
          revisedLabel: this.getDisplayLabel(currLocation),
          status: result.success ? 'success' : 'error',
          message: result.success ? undefined : result.message,
          locations: {
            base: prevLocation ?? null,
            revised: currLocation ?? null,
            diff: diffLocation,
          },
        });
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
  }

  private async compileDiffIfSuccessful(
    result: LaTeXdiffResult,
    referenceLocation: FileLocation,
  ): Promise<FileLocation | null> {
    if (!result.success || !result.diffFileName) {
      return null;
    }

    const refRelDir = getFileDirectory(referenceLocation);
    const diffRelativePath = path.join(refRelDir, result.diffFileName);
    const diffLocation = this.fileService.createLocation(diffRelativePath);

    const buildDir = path.join(
      path.dirname(diffLocation.absolutePath),
      'build',
    );
    await this.dependencies.compileLatex2Pdf(diffLocation, {
      channel: this.channel,
      outputDirectory: buildDir,
      compiler: 'latexmk',
    });

    return diffLocation;
  }
}
