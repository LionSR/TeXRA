// Standard library imports
import { promises as fs } from 'fs';
import * as path from 'path';

// Local imports - agent
import { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { LaTeXdiffService, LaTeXdiffResult } from '@latex/latexdiff';
import { compileLatex2Pdf } from '@latex/texTools';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';
import { checkToolInstalled } from '@utils/system';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';

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
    private readonly dependencies: LatexDiffDependencies = defaultLatexDiffDependencies,
    private readonly resolveRunRoot?: () => string | undefined,
  ) {
    this.latexdiffService = new LaTeXdiffService(channel);
    this.runMirrorCache = new Map();
  }

  private readonly runMirrorCache: Map<string, string>;

  private getRunRoot(): string | undefined {
    return this.resolveRunRoot ? this.resolveRunRoot() : undefined;
  }

  private isManagedPath(filePath: string): boolean {
    const runRoot = this.getRunRoot();
    if (!runRoot) {
      return false;
    }
    const normalizedRoot = path.resolve(runRoot);
    const normalizedFile = path.resolve(filePath);
    return normalizedFile.startsWith(normalizedRoot);
  }

  private async ensureRunLocalPath(filePath: string): Promise<string> {
    if (!filePath || this.isManagedPath(filePath)) {
      return filePath;
    }

    const runRoot = this.getRunRoot();
    if (!runRoot) {
      return filePath;
    }

    const cached = this.runMirrorCache.get(filePath);
    if (cached) {
      return cached;
    }

    if (!(await AbsoluteFS.exists(filePath))) {
      return filePath;
    }

    const workspaceRoot = WorkspaceFS.getPath();
    const relative = workspaceRoot
      ? path.relative(workspaceRoot, path.resolve(filePath))
      : path.basename(filePath);
    const mirrorDir = path.join(runRoot, 'workspace');
    const targetPath = path.join(mirrorDir, relative);

    await AbsoluteFS.ensureDir(path.dirname(targetPath));

    try {
      await fs.symlink(filePath, targetPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        await AbsoluteFS.copy(filePath, targetPath, { overwrite: true });
      }
    }

    this.runMirrorCache.set(filePath, targetPath);
    return targetPath;
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
          const basePath = await this.ensureRunLocalPath(baseFile);
          const outputPath = await this.ensureRunLocalPath(outputFile);
          const result = await this.latexdiffService.runDiffForRound(
            basePath,
            outputPath,
            currRound,
          );
          this.logLatexdiffResult(result, 'round-diff');
          aggregated.push({
            base: basePath,
            revised: outputPath,
            output: result.diffFileName
              ? path.join(path.dirname(basePath), result.diffFileName)
              : '',
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
          });
          if (result.success && result.diffFileName) {
            const diffPath = path.join(
              path.dirname(basePath),
              result.diffFileName,
            );
            const buildDir = path.join(path.dirname(diffPath), 'build');
            await this.dependencies.compileLatex2Pdf(
              diffPath,
              this.channel,
              buildDir,
              true,
            );
          }
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
          const prevPath = await this.ensureRunLocalPath(prevOutputFile);
          const currPath = await this.ensureRunLocalPath(currOutputFile);
          const result = await this.latexdiffService.runDiffBetweenRounds(
            prevPath,
            currPath,
          );
          this.logLatexdiffResult(result, 'between-rounds-diff');
          aggregated.push({
            base: prevPath,
            revised: currPath,
            output: result.diffFileName
              ? path.join(path.dirname(prevPath), result.diffFileName)
              : '',
            status: result.success ? 'success' : 'error',
            message: result.success ? undefined : result.message,
          });
          if (result.success && result.diffFileName) {
            const diffPath = path.join(
              path.dirname(prevPath),
              result.diffFileName,
            );
            const buildDir = path.join(path.dirname(diffPath), 'build');
            await this.dependencies.compileLatex2Pdf(
              diffPath,
              this.channel,
              buildDir,
              true,
            );
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
