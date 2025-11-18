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
  getComparablePath,
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
    private readonly outputFiles: { [key: number]: OutputFileInfo[] },
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
   * Get paths for diff operation - trust FileLocation.
   * Returns the file's directory as cwd so latexdiff can resolve relative includes.
   */
  private async getDiffPaths(location: FileLocation | undefined): Promise<{
    actual: string | null;
    workspaceDir: string | null;
  }> {
    if (!location) {
      return { actual: null, workspaceDir: null };
    }

    // Trust FileLocation - no defensive existence checks or fallbacks
    const actual = await this.resolveSymlinks(location.absolutePath);
    // Use the file's directory as cwd, not workspace root, so relative includes work
    const workspaceDir = path.dirname(actual);

    return { actual, workspaceDir };
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

      const outputFiles = this.outputFiles[currRound] || [];
      const outputPaths = outputFiles.map(
        (entry) => entry.location.absolutePath,
      );
      if (outputPaths.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
        );
        return;
      }

      this.logger.debug(`Base files: ${this.baseFiles}`);
      this.logger.debug(`r${currRound} output files: ${outputPaths}`);

      const basePairs = Array.from(mapping.baseToOutput.entries());
      if (basePairs.length > 0) {
        this.logger.debug(
          `Matched base files to output files: ${basePairs
            .map(
              ([base, output]) =>
                `${path.basename(base)} -> ${path.basename(output)}`,
            )
            .join(', ')}`,
        );
      } else if (this.baseFiles.length > 0) {
        this.logger.debug(
          'No base file mappings found for current round outputs',
        );
      }

      // Create map from comparable path to FileLocation for base files
      const baseLocationByPath = new Map(
        this.baseFiles.map((loc) => [getComparablePath(loc), loc]),
      );

      if (this.agentSetting.isRewrite) {
        this.logger.debug('Running round-based latexdiff operations');
        for (const [baseFile, outputFile] of basePairs) {
          const location = mapping.locationByOutput.get(outputFile);
          const { actual, workspaceDir } = await this.getDiffPaths(location);

          // Look up base FileLocation from baseFiles array
          const baseLocation = baseLocationByPath.get(baseFile);
          if (!baseLocation) {
            this.logger.warn(
              `Base file location not found for ${baseFile}, skipping`,
            );
            continue;
          }

          if (!actual) {
            this.logger.warn(
              `Skipping latexdiff for ${outputFile} - no location info`,
            );
            aggregated.push({
              baseLabel: this.getDisplayLabel(baseLocation),
              revisedLabel: this.getDisplayLabel(baseLocation),
              status: 'error',
              message: 'Revised file location missing',
              locations: {
                base: baseLocation,
                revised: location ?? null,
                diff: null,
              },
            });
            continue;
          }

          await this.ensureWorkspaceDependency(baseLocation);
          if (location) {
            await this.ensureWorkspaceDependency(location);
          }
          const cwd = workspaceDir ?? path.dirname(baseLocation.absolutePath);

          // Use location if available, otherwise create run-storage aware location
          const revisedLocation =
            location ?? this.fileService.createLocation(actual);

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
            revisedLabel: location
              ? this.getDisplayLabel(location)
              : path.basename(outputFile),
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
            locations: {
              base: baseLocation,
              revised: revisedLocation ?? null,
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
                  `${path.basename(prev)} -> ${path.basename(curr)}`,
              )
              .join(', ')}`,
          );
        } else {
          this.logger.debug(
            'No previous round mappings found for current round outputs',
          );
        }

        for (const [prevOutputFile, currOutputFile] of prevPairs) {
          const prevLocation = mapping.locationByOutput.get(prevOutputFile);
          const currLocation = mapping.locationByOutput.get(currOutputFile);
          const prevPaths = await this.getDiffPaths(prevLocation);
          const currPaths = await this.getDiffPaths(currLocation);

          if (!prevPaths.actual || !currPaths.actual) {
            this.logger.warn(
              `Skipping between-round latexdiff - missing location info for ${prevOutputFile} or ${currOutputFile}`,
            );
            aggregated.push({
              baseLabel: prevLocation
                ? this.getDisplayLabel(prevLocation)
                : path.basename(prevOutputFile),
              revisedLabel: currLocation
                ? this.getDisplayLabel(currLocation)
                : path.basename(currOutputFile),
              status: 'error',
              message: 'One or more round files missing location info',
              locations: {
                base: prevLocation ?? null,
                revised: currLocation ?? null,
                diff: null,
              },
            });
            continue;
          }

          await this.ensureWorkspaceDependency(prevLocation);
          await this.ensureWorkspaceDependency(currLocation);

          const cwd =
            prevPaths.workspaceDir ??
            currPaths.workspaceDir ??
            path.dirname(prevPaths.actual);
          const result = await this.latexdiffService.runDiffBetweenRounds(
            prevLocation!,
            currLocation!,
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
            baseLabel: prevLocation
              ? this.getDisplayLabel(prevLocation)
              : path.basename(prevOutputFile),
            revisedLabel: currLocation
              ? this.getDisplayLabel(currLocation)
              : path.basename(currOutputFile),
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
