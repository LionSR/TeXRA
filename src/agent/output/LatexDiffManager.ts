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
import { TaskRunFileService, flexibleFS, WorkspaceFS } from '@utils/files';
// Type imports
import type { FileLocation } from '@utils/files';

// Internal imports
import { compileLatex2Pdf } from '@latex/texTools';
import { LaTeXdiffService, LaTeXdiffResult } from '@latex/latexdiff';

// Local imports - types
import type { OutputFileInfo, RoundFileMapping } from './types';

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
    private readonly baseFiles: string[],
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

  private async ensureWorkspaceDependency(
    target?: string | null,
  ): Promise<void> {
    if (!target) {
      return;
    }

    if (!(await flexibleFS.exists(target))) {
      return;
    }

    try {
      await this.fileService.mirrorWorkspaceFile(target);
    } catch (error) {
      this.logger.warn(
        `Unable to mirror workspace dependency ${target}: ${toErrorMessage(error)}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
    }
  }

  /**
   * Relocate diff artifact to run storage, returning its FileLocation.
   * Avoids round-trip through string by preserving FileLocation.
   */
  private async relocateDiffArtifact(diffPath: string): Promise<FileLocation> {
    if (!this.fileService.hasRunDirectory()) {
      // Describe once - don't convert back and forth
      return this.fileService.describePath(diffPath);
    }

    // relocateToRunStorage already returns FileLocation - use it directly!
    return await this.fileService.relocateToRunStorage(diffPath);
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
    const aggregated: Array<{
      baseLabel: string;
      basePath?: string;
      revisedLabel: string;
      revisedPath?: string;
      diffPath?: string;
      status: 'success' | 'error';
      message?: string;
      runId?: string | null;
      locations?: {
        base: FileLocation | null;
        revised: FileLocation | null;
        diff: FileLocation | null;
      };
    }> = [];

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

      if (this.agentSetting.isRewrite) {
        this.logger.debug('Running round-based latexdiff operations');
        for (const [baseFile, outputFile] of basePairs) {
          const location = mapping.locationByOutput.get(outputFile);
          const { actual, workspaceDir } = await this.getDiffPaths(location);
          const baseAbsolute = this.fileService.resolveRelativePath(baseFile, {
            preferWorkspace: true,
          }).absolutePath;

          if (!actual) {
            this.logger.warn(
              `Skipping latexdiff for ${outputFile} - no location info`,
            );
            aggregated.push({
              baseLabel: this.fileService.getDisplayLabel(baseFile),
              basePath: baseAbsolute,
              revisedLabel: this.fileService.getDisplayLabel(baseFile),
              revisedPath: location?.absolutePath,
              status: 'error',
              message: 'Revised file location missing',
            });
            continue;
          }

          await this.ensureWorkspaceDependency(baseAbsolute);
          if (location?.absolutePath) {
            await this.ensureWorkspaceDependency(location.absolutePath);
          }
          const cwd = workspaceDir ?? path.dirname(baseAbsolute);

          const result = await this.latexdiffService.runDiffForRound(
            baseAbsolute,
            actual,
            currRound,
            undefined,
            { cwd },
          );
          this.logLatexdiffResult(result, 'round-diff');
          let diffPath = '';
          let diffLocation: FileLocation | undefined;

          if (result.success && result.diffFileName) {
            diffPath = path.join(
              path.dirname(baseAbsolute),
              result.diffFileName,
            );
            const buildDir = path.join(path.dirname(diffPath), 'build');
            await this.dependencies.compileLatex2Pdf(
              diffPath,
              this.channel,
              buildDir,
              true,
            );
            if (this.fileService.hasRunDirectory()) {
              diffLocation = await this.relocateDiffArtifact(diffPath);
              diffPath = diffLocation.absolutePath;
              // Leave the build directory in place; it mainly caches temporary
              // LaTeX intermediates and can be regenerated on demand.
            } else {
              // No run storage - describe the workspace location
              diffLocation = this.fileService.describePath(diffPath);
            }
          }

          const baseLocation = this.fileService.resolveRelativePath(baseFile, {
            preferWorkspace: true,
          });
          const revisedLocation =
            location ?? this.fileService.resolveRelativePath(actual);

          aggregated.push({
            baseLabel: this.fileService.getDisplayLabel(baseFile),
            basePath: baseAbsolute,
            revisedLabel: this.fileService.getDisplayLabel(outputFile),
            revisedPath: actual,
            diffPath: diffPath || undefined,
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
            runId: this.fileService.metadata.executionId ?? null,
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
              baseLabel: this.fileService.getDisplayLabel(prevOutputFile),
              basePath: prevLocation?.absolutePath,
              revisedLabel: this.fileService.getDisplayLabel(currOutputFile),
              revisedPath: currLocation?.absolutePath,
              status: 'error',
              message: 'One or more round files missing location info',
              runId: this.fileService.metadata.executionId ?? null,
              locations: {
                base: prevLocation ?? null,
                revised: currLocation ?? null,
                diff: null,
              },
            });
            continue;
          }

          if (prevLocation?.absolutePath) {
            await this.ensureWorkspaceDependency(prevLocation.absolutePath);
          }
          if (currLocation?.absolutePath) {
            await this.ensureWorkspaceDependency(currLocation.absolutePath);
          }

          const cwd =
            prevPaths.workspaceDir ??
            currPaths.workspaceDir ??
            path.dirname(prevPaths.actual);
          const result = await this.latexdiffService.runDiffBetweenRounds(
            prevPaths.actual,
            currPaths.actual,
            undefined,
            { cwd },
          );
          this.logLatexdiffResult(result, 'between-rounds-diff');
          let diffPath = '';
          let diffLocation: FileLocation | undefined;

          if (result.success && result.diffFileName) {
            diffPath = path.join(
              path.dirname(prevPaths.actual),
              result.diffFileName,
            );
            const buildDir = path.join(path.dirname(diffPath), 'build');
            await this.dependencies.compileLatex2Pdf(
              diffPath,
              this.channel,
              buildDir,
              true,
            );
            if (this.fileService.hasRunDirectory()) {
              diffLocation = await this.relocateDiffArtifact(diffPath);
              diffPath = diffLocation.absolutePath;
              // Build folders stay in the workspace to avoid copying the entire
              // compilation output tree into run storage.
            } else {
              // No run storage - describe the workspace location
              diffLocation = this.fileService.describePath(diffPath);
            }
          }

          aggregated.push({
            baseLabel: this.fileService.getDisplayLabel(prevOutputFile),
            basePath: prevLocation?.absolutePath,
            revisedLabel: this.fileService.getDisplayLabel(currOutputFile),
            revisedPath: currPaths.actual,
            diffPath: diffPath || undefined,
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
            runId: this.fileService.metadata.executionId ?? null,
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
