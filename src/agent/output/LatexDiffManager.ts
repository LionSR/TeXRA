// Standard library imports
import * as path from 'path';

// Local imports - agent
import { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { LaTeXdiffService, LaTeXdiffResult } from '@latex/latexdiff';
import { compileLatex2Pdf } from '@latex/texTools';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { getConfig } from '@utils/config';
import { checkToolInstalled } from '@utils/system';
import type { RoundOutputMapping } from './types';

export class LatexDiffManager {
  private readonly latexdiffService: LaTeXdiffService;

  constructor(
    private readonly agentSetting: AgentWorkflowSetting,
    private readonly outputFiles: { [key: number]: string[] },
    private readonly baseFiles: string[],
    private readonly logger: AgentLogger,
    private readonly channel: string,
  ) {
    this.latexdiffService = new LaTeXdiffService(channel);
  }

  private logLatexdiffResult(
    result: LaTeXdiffResult,
    operation: string = 'latexdiff',
    groupId?: string,
  ): void {
    if (result.success) {
      this.logger.debug(
        `Successfully generated ${operation} file: ${result.diffFileName}`,
        groupId,
      );
    } else {
      if (result.message && result.message.includes('document environment')) {
        this.logger.debug(
          `Skipping ${operation}: ${result.message}`,
          groupId,
          MESSAGE_TYPES.INTERNAL,
        );
      } else {
        this.logger.warn(
          `Failed to generate ${operation}: ${result.message}`,
          groupId,
          MESSAGE_TYPES.INTERNAL,
        );
      }
    }
  }

  async handleLatexdiffofOutput(
    currRound: number,
    mapping: RoundOutputMapping,
    groupId?: string,
  ): Promise<void> {
    const diffProcessGroupId = groupId ?? this.logger.getActiveGroupId();
    const generateBetweenRoundDiffs = getConfig<boolean>(
      'latexdiff.generateBetweenRoundDiffs',
      false,
    );
    const aggregated: Array<{
      base: string;
      revised: string;
      output: string;
      status: 'success' | 'error';
      message?: string;
    }> = [];

    try {
      if (!(await checkToolInstalled('latexdiff'))) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
          diffProcessGroupId,
        );
        return;
      }

      const outputFiles = this.outputFiles[currRound] || [];
      if (outputFiles.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
          diffProcessGroupId,
        );
        return;
      }

      this.logger.debug(`Base files: ${this.baseFiles}`, diffProcessGroupId);
      this.logger.debug(
        `r${currRound} output files: ${outputFiles}`,
        diffProcessGroupId,
      );

      const processDiffPair = async (
        baseFile: string,
        revisedFile: string,
        runner: () => Promise<LaTeXdiffResult>,
        operation: 'round-diff' | 'between-rounds-diff',
      ): Promise<void> => {
        const result = await runner();
        this.logLatexdiffResult(result, operation, diffProcessGroupId);
        aggregated.push({
          base: baseFile,
          revised: revisedFile,
          output: result.diffFileName
            ? path.join(path.dirname(baseFile), result.diffFileName)
            : '',
          status: result.success ? 'success' : 'error',
          message: result.success ? undefined : result.message,
        });
        if (result.success && result.diffFileName) {
          const diffPath = path.join(
            path.dirname(baseFile),
            result.diffFileName,
          );
          const buildDir = path.join(path.dirname(diffPath), 'build');
          await compileLatex2Pdf(
            diffPath,
            this.channel,
            buildDir,
            true, // prefer latexmk when available
          );
        }
      };

      const basePairs = Array.from(mapping.baseToOutput.entries());

      this.logger.debug(
        `Matched base files to output files: ${basePairs
          .map(
            ([base, output]) =>
              `${path.basename(base)} -> ${path.basename(output)}`,
          )
          .join(', ')}`,
        diffProcessGroupId,
      );

      if (this.agentSetting.isRewrite) {
        this.logger.debug(
          'Running round-based latexdiff operations',
          diffProcessGroupId,
        );
        for (const [baseFile, outputFile] of basePairs) {
          await processDiffPair(
            baseFile,
            outputFile,
            () =>
              this.latexdiffService.runDiffForRound(
                baseFile,
                outputFile,
                currRound,
              ),
            'round-diff',
          );
        }
      }

      if (generateBetweenRoundDiffs && currRound > 0) {
        this.logger.debug(
          'Running between-rounds latexdiff operations',
          diffProcessGroupId,
        );
        const prevPairs = Array.from(mapping.prevToCurrent.entries());

        this.logger.debug(
          `Matched previous round files to current round files: ${prevPairs
            .map(
              ([prev, curr]) =>
                `${path.basename(prev)} -> ${path.basename(curr)}`,
            )
            .join(', ')}`,
          diffProcessGroupId,
        );

        for (const [prevOutputFile, currOutputFile] of prevPairs) {
          await processDiffPair(
            prevOutputFile,
            currOutputFile,
            () =>
              this.latexdiffService.runDiffBetweenRounds(
                prevOutputFile,
                currOutputFile,
              ),
            'between-rounds-diff',
          );
        }
      } else if (!generateBetweenRoundDiffs) {
        this.logger.debug(
          'Skipping between-round latexdiff operations: disabled in settings',
          diffProcessGroupId,
        );
      }

      if (aggregated.length > 0) {
        this.logger.latexDiff(aggregated, diffProcessGroupId);
      } else {
        this.logger.debug('No latexdiff results to report', diffProcessGroupId);
      }
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${err instanceof Error ? err.message : String(err)}`,
        diffProcessGroupId,
      );
    }
  }
}
