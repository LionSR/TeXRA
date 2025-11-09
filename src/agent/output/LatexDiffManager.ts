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

  private async resolveDiffInput(
    actualPath: string,
    workspaceCandidate?: string,
  ): Promise<{
    actual: string | null;
    workspaceDir?: string;
    displayPath: string;
  }> {
    const workspaceAbsolute = workspaceCandidate
      ? toAbsolutePath(workspaceCandidate)
      : undefined;
    const workspaceExists = workspaceCandidate
      ? await existsFlexible(workspaceCandidate)
      : false;
    const workspaceDir = workspaceAbsolute
      ? path.dirname(workspaceAbsolute)
      : undefined;
    const displayPath = this.fileService.getWorkspaceDisplayPath(
      workspaceCandidate ?? actualPath,
    );

    if (workspaceAbsolute && workspaceExists) {
      return {
        actual: workspaceAbsolute,
        workspaceDir,
        displayPath,
      };
    }

    if (await existsFlexible(actualPath)) {
      return {
        actual: toAbsolutePath(actualPath),
        workspaceDir,
        displayPath,
      };
    }

    return {
      actual: null,
      workspaceDir,
      displayPath,
    };
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
      base: string;
      revised: string;
      output: string;
      status: 'success' | 'error';
      message?: string;
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
          const resolved = await this.resolveDiffInput(
            outputFile,
            mapping.workspaceByOutput.get(outputFile),
          );
          const baseAbsolute = toAbsolutePath(baseFile);
          const cwd = resolved.workspaceDir ?? path.dirname(baseAbsolute);

          if (!resolved.actual) {
            this.logger.warn(
              `Skipping latexdiff for ${outputFile} - file not found after relocation`,
            );
            aggregated.push({
              base: this.fileService.getWorkspaceDisplayPath(baseFile),
              revised: resolved.displayPath,
              output: '',
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
              const relocation =
                await this.fileService.relocateToRunStorage(diffPath);
              diffPath = relocation.storagePath;
              await this.fileService.relocateToRunStorage(buildDir);
            }
          }
          aggregated.push({
            base: this.fileService.getWorkspaceDisplayPath(baseFile),
            revised: resolved.displayPath,
            output: diffPath,
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
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
          const prevResolved = await this.resolveDiffInput(
            prevOutputFile,
            mapping.workspaceByOutput.get(prevOutputFile),
          );
          const currResolved = await this.resolveDiffInput(
            currOutputFile,
            mapping.workspaceByOutput.get(currOutputFile),
          );

          if (!prevResolved.actual || !currResolved.actual) {
            this.logger.warn(
              `Skipping between-round latexdiff - missing files for ${prevOutputFile} or ${currOutputFile}`,
            );
            aggregated.push({
              base: prevResolved.displayPath,
              revised: currResolved.displayPath,
              output: '',
              status: 'error',
              message: 'One or more round files missing for latexdiff',
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
              const relocation =
                await this.fileService.relocateToRunStorage(diffPath);
              diffPath = relocation.storagePath;
              await this.fileService.relocateToRunStorage(buildDir);
            }
          }
          aggregated.push({
            base: prevResolved.displayPath,
            revised: currResolved.displayPath,
            output: diffPath,
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
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
