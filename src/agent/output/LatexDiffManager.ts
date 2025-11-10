// Standard library imports
import * as path from 'path';

// Local imports - agent
import { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { LaTeXdiffService, LaTeXdiffResult } from '@latex/latexdiff';
import { compileLatex2Pdf } from '@latex/texTools';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';
import { checkToolInstalled } from '@utils/system';
import {
  TaskRunFileService,
  existsFlexible,
  toAbsolutePath,
} from '@utils/files';
import type { FileLocation } from '@utils/files';

// Local imports - types
import type { RoundFileMapping } from './types';

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
    private readonly outputFiles: { [key: number]: string[] },
    private readonly baseFiles: string[],
    private readonly logger: AgentLogger,
    private readonly channel: string,
    private readonly fileService: TaskRunFileService,
    private readonly dependencies: LatexDiffDependencies = defaultLatexDiffDependencies,
  ) {
    this.latexdiffService = new LaTeXdiffService(channel);
  }

  private async resolveDiffTarget(
    relativePath: string,
    location?: FileLocation,
  ): Promise<{
    actual: string | null;
    workspaceDir?: string;
    workspaceReference?: string;
  }> {
    const workspaceReference = location?.workspace?.absolutePath
      ? toAbsolutePath(location.workspace.absolutePath)
      : relativePath
        ? this.fileService.resolveRelativePath(relativePath, {
            preferWorkspace: true,
          }).workspace?.absolutePath
        : undefined;

    const workspaceDir = workspaceReference
      ? path.dirname(workspaceReference)
      : undefined;

    const actualCandidate = location?.absolutePath;

    if (actualCandidate && (await existsFlexible(actualCandidate))) {
      return { actual: actualCandidate, workspaceDir, workspaceReference };
    }

    if (workspaceReference && (await existsFlexible(workspaceReference))) {
      return {
        actual: workspaceReference,
        workspaceDir,
        workspaceReference,
      };
    }

    return { actual: null, workspaceDir, workspaceReference };
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

    if (!(await existsFlexible(target))) {
      return;
    }

    try {
      await this.fileService.mirrorWorkspaceFile(target);
    } catch (error) {
      this.logger.warn(
        `Unable to mirror workspace dependency ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
    }
  }

  private async relocateDiffArtifact(diffPath: string): Promise<string> {
    if (!this.fileService.hasRunDirectory()) {
      return diffPath;
    }

    const relocation = await this.fileService.relocateToRunStorage(diffPath);
    return relocation.absolutePath;
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
      if (outputFiles.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
        );
        return;
      }

      this.logger.debug(`Base files: ${this.baseFiles}`);
      this.logger.debug(`r${currRound} output files: ${outputFiles}`);

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
          const resolved = await this.resolveDiffTarget(outputFile, location);
          const baseAbsolute = this.fileService.resolveRelativePath(baseFile, {
            preferWorkspace: true,
          }).absolutePath;
          await this.ensureWorkspaceDependency(baseAbsolute);
          await this.ensureWorkspaceDependency(resolved.workspaceReference);
          const cwd = resolved.workspaceDir ?? path.dirname(baseAbsolute);

          if (!resolved.actual) {
            this.logger.warn(
              `Skipping latexdiff for ${outputFile} - file not found after relocation`,
            );
            aggregated.push({
              baseLabel: this.fileService.getDisplayLabel(baseFile),
              basePath: baseAbsolute,
              revisedLabel: this.fileService.getDisplayLabel(baseFile),
              revisedPath: location?.absolutePath,
              status: 'error',
              message: 'Revised file missing for latexdiff',
            });
            continue;
          }

          const result = await this.latexdiffService.runDiffForRound(
            baseAbsolute,
            resolved.actual,
            currRound,
            undefined,
            { cwd },
          );
          this.logLatexdiffResult(result, 'round-diff');
          let diffPath = '';
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
              diffPath = await this.relocateDiffArtifact(diffPath);
              // Leave the build directory in place; it mainly caches temporary
              // LaTeX intermediates and can be regenerated on demand.
            }
          }
          const baseLocation = this.fileService.resolveRelativePath(baseFile, {
            preferWorkspace: true,
          });
          const revisedLocation =
            location ??
            (resolved.actual
              ? this.fileService.describePath(resolved.actual)
              : undefined);
          const diffLocation = diffPath
            ? this.fileService.describePath(diffPath)
            : undefined;

          aggregated.push({
            baseLabel: this.fileService.getDisplayLabel(baseFile),
            basePath: baseAbsolute,
            revisedLabel: this.fileService.getDisplayLabel(baseFile),
            revisedPath: resolved.actual ?? location?.absolutePath,
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
          const prevResolved = await this.resolveDiffTarget(
            prevOutputFile,
            prevLocation,
          );
          const currResolved = await this.resolveDiffTarget(
            currOutputFile,
            currLocation,
          );
          await this.ensureWorkspaceDependency(prevResolved.workspaceReference);
          await this.ensureWorkspaceDependency(currResolved.workspaceReference);

          if (!prevResolved.actual || !currResolved.actual) {
            this.logger.warn(
              `Skipping between-round latexdiff - missing files for ${prevOutputFile} or ${currOutputFile}`,
            );
            aggregated.push({
              baseLabel: this.fileService.getDisplayLabel(prevOutputFile),
              basePath: prevLocation?.absolutePath,
              revisedLabel: this.fileService.getDisplayLabel(currOutputFile),
              revisedPath: currLocation?.absolutePath,
              status: 'error',
              message: 'One or more round files missing for latexdiff',
              runId: this.fileService.metadata.executionId ?? null,
              locations: {
                base: prevLocation ?? null,
                revised: currLocation ?? null,
                diff: null,
              },
            });
            continue;
          }

          const workspaceCwd =
            prevResolved.workspaceDir ?? currResolved.workspaceDir;
          const cwd =
            workspaceCwd ?? path.dirname(toAbsolutePath(prevResolved.actual));
          const result = await this.latexdiffService.runDiffBetweenRounds(
            prevResolved.actual,
            currResolved.actual,
            undefined,
            { cwd },
          );
          this.logLatexdiffResult(result, 'between-rounds-diff');
          let diffPath = '';
          if (result.success && result.diffFileName) {
            diffPath = path.join(
              path.dirname(toAbsolutePath(prevResolved.actual)),
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
              diffPath = await this.relocateDiffArtifact(diffPath);
              // Build folders stay in the workspace to avoid copying the entire
              // compilation output tree into run storage.
            }
          }
          const diffLocation = diffPath
            ? this.fileService.describePath(diffPath)
            : undefined;

          aggregated.push({
            baseLabel: this.fileService.getDisplayLabel(prevOutputFile),
            basePath: prevLocation?.absolutePath,
            revisedLabel: this.fileService.getDisplayLabel(currOutputFile),
            revisedPath: currResolved.actual ?? currLocation?.absolutePath,
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
        `Error during latexdiff processing: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
    }
  }
}
