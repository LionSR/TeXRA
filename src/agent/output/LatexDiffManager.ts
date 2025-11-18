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
  WorkspaceFS,
  type FileLocation,
  type AgentFileLocation,
} from '@utils/files';

// Internal imports
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
    } catch {
      return target;
    }
  }

  /**
   * Get working directory for latexdiff - use file's directory so relative includes work.
   */
  private async getWorkingDirectory(
    location: FileLocation,
  ): Promise<string> {
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
      this.logger.debug(
        `Skipping ${operation}: ${result.message}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return;
    }

    this.logger.warn(
      `Failed to generate ${operation}: ${result.message}`,
      undefined,
      MESSAGE_TYPES.INTERNAL,
    );
  }

  /**
   * Get display label (basename) from FileLocation for UI/logging.
   */
  private getDisplayLabel(location: FileLocation): string {
    // Agent outputs are always workspace or runStorage, never external
    return path.basename((location as AgentFileLocation).relativePath);
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
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
    }
  }

  async handleLatexdiffofOutput(
    currRound: number,
    mapping: RoundFileMapping,
    stage?: AgentLogStage,
  ): Promise<void> {
    const generateBetweenRoundDiffs = this.dependencies.getConfig<boolean>(
      'texra.latexdiff.generateBetweenRoundDiffs',
      false,
    );
    const aggregated: DiffOperationResult[] = [];

    const execute = async () => {
      if (!(await this.dependencies.checkToolInstalled('latexdiff'))) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
        );
        return;
      }

      const outputFiles = this.getOutputFiles()[currRound] || [];
      const outputPaths = outputFiles.map(
        (entry) => entry.location.absolutePath,
      );
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

      const basePairs = Array.from(mapping.baseToOutput.entries());
      if (basePairs.length > 0) {
        this.logger.debug(
          `Matched base files to output files: ${basePairs
            .map(
              ([base, output]) =>
                `${this.getDisplayLabel(base)} -> ${this.getDisplayLabel(output)}`,
            )
            .join(', ')}`,
        );
      } else if (this.baseFiles.length > 0) {
        this.logger.debug(
          'No base file mappings found for current round outputs',
        );
      }

      if (this.agentSetting.isRewrite) {
        this.logger.debug('Running round-based latexdiff operations');
        for (const [baseLocation, revisedLocation] of basePairs) {
          await this.ensureWorkspaceDependency(baseLocation);
          await this.ensureWorkspaceDependency(revisedLocation);

          // Use revised file's directory as cwd so latexdiff can resolve relative includes
          const cwd = await this.getWorkingDirectory(revisedLocation);

          const result = await this.latexdiffService.runDiffForRound(
            baseLocation,
            revisedLocation,
            currRound,
            undefined,
            { cwd },
          );
          this.logLatexdiffResult(result, 'round-diff');
          let diffLocation: FileLocation | undefined;

          if (result.success && result.diffFileName) {
            // Create diff location using fileService - it knows whether to use workspace or run storage
            // Agent outputs are always workspace or runStorage, never external
            const baseRelDir = path.dirname(
              (baseLocation as AgentFileLocation).relativePath,
            );
            const diffRelativePath = path.join(baseRelDir, result.diffFileName);

            // This automatically uses run storage if enabled, workspace otherwise
            diffLocation = this.fileService.createLocation(diffRelativePath);

            const buildDir = path.join(
              path.dirname(diffLocation.absolutePath),
              'build',
            );
            await this.dependencies.compileLatex2Pdf(
              diffLocation,
              this.channel,
              buildDir,
              true,
            );
          }

          aggregated.push({
            baseLabel: this.getDisplayLabel(baseLocation),
            revisedLabel: this.getDisplayLabel(revisedLocation),
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
            locations: {
              base: baseLocation,
              revised: revisedLocation,
              diff: diffLocation ?? null,
            },
          });
        }
      }

      if (generateBetweenRoundDiffs && currRound > 0) {
        this.logger.debug('Running between-rounds latexdiff operations');
        const prevPairs = Array.from(mapping.prevToOutput.entries());

        if (prevPairs.length > 0) {
          this.logger.debug(
            `Matched previous round files to current round files: ${prevPairs
              .map(
                ([prev, curr]) =>
                  `${this.getDisplayLabel(prev)} -> ${this.getDisplayLabel(curr)}`,
              )
              .join(', ')}`,
          );
        } else {
          this.logger.debug(
            'No previous round mappings found for current round outputs',
          );
        }

        for (const [prevLocation, currLocation] of prevPairs) {
          await this.ensureWorkspaceDependency(prevLocation);
          await this.ensureWorkspaceDependency(currLocation);

          // Use current file's directory as cwd so latexdiff can resolve relative includes
          const cwd = await this.getWorkingDirectory(currLocation);
          const result = await this.latexdiffService.runDiffBetweenRounds(
            prevLocation,
            currLocation,
            undefined,
            { cwd },
          );
          this.logLatexdiffResult(result, 'between-rounds-diff');
          let diffLocation: FileLocation | undefined;

          if (result.success && result.diffFileName) {
            // Create diff location using fileService - it knows whether to use workspace or run storage
            // Agent outputs are always workspace or runStorage, never external
            const refLocation = prevLocation ?? currLocation!;
            const refRelDir = path.dirname(
              (refLocation as AgentFileLocation).relativePath,
            );
            const diffRelativePath = path.join(refRelDir, result.diffFileName);

            // This automatically uses run storage if enabled, workspace otherwise
            diffLocation = this.fileService.createLocation(diffRelativePath);

            const buildDir = path.join(
              path.dirname(diffLocation.absolutePath),
              'build',
            );
            await this.dependencies.compileLatex2Pdf(
              diffLocation,
              this.channel,
              buildDir,
              true,
            );
          }

          aggregated.push({
            baseLabel: this.getDisplayLabel(prevLocation),
            revisedLabel: this.getDisplayLabel(currLocation),
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
            locations: {
              base: prevLocation ?? null,
              revised: currLocation ?? null,
              diff: diffLocation ?? null,
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
    };

    try {
      if (stage) {
        await stage.within(execute);
      } else {
        await execute();
      }
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${toErrorMessage(err)}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
    }
  }
}
