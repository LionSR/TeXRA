import * as path from 'path';

import { AgentSetting } from '@agent/core/AgentDataclass';
import { AgentLogger } from '@logger/AgentLogger';
import { createFileMapping } from '@utils/files';
import { compileLatex2Pdf } from '@latex/texTools';
import { checkToolInstalled } from '@utils/system';
import { LatexdiffRunner, LaTeXdiffResult } from '@latex/latexdiffRunner';

export class LatexDiffManager {
  private readonly runner: LatexdiffRunner;

  constructor(
    private readonly agentSetting: AgentSetting,
    private readonly outputFiles: { [key: number]: string[] },
    private readonly baseFiles: string[],
    private readonly logger: AgentLogger,
    private readonly channel: string,
  ) {
    this.runner = new LatexdiffRunner(this.channel);
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
      this.logger.warn(
        `Failed to generate ${operation}: ${result.message}`,
        groupId,
      );
    }
  }

  async handleLatexdiffofOutput(
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    const diffProcessGroupId = groupId ?? this.logger.getActiveGroupId();

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

      const baseToOutputMap = createFileMapping(
        this.baseFiles,
        outputFiles,
        'contains',
      );

      this.logger.debug(
        `Matched base files to output files: ${Array.from(
          baseToOutputMap.entries(),
        )
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
        for (const [baseFile, outputFile] of baseToOutputMap.entries()) {
          const result = await this.runner.runDiffForRound(
            baseFile,
            outputFile,
            currRound,
          );
          this.logLatexdiffResult(result, 'round-diff', diffProcessGroupId);
          if (result.success && result.diffFileName) {
            const diffPath = path.join(
              path.dirname(baseFile),
              result.diffFileName,
            );
            const buildDir = path.join(path.dirname(diffPath), 'build');
            await compileLatex2Pdf(diffPath, this.channel, buildDir);
          }
        }
      }

      if (currRound > 0) {
        this.logger.debug(
          'Running between-rounds latexdiff operations',
          diffProcessGroupId,
        );
        const prevOutputFiles = this.outputFiles[currRound - 1] || [];
        const prevToCurrentMap = createFileMapping(
          prevOutputFiles,
          outputFiles,
          'basename',
          true,
        );

        this.logger.debug(
          `Matched previous round files to current round files: ${Array.from(
            prevToCurrentMap.entries(),
          )
            .map(
              ([prev, curr]) =>
                `${path.basename(prev)} -> ${path.basename(curr)}`,
            )
            .join(', ')}`,
          diffProcessGroupId,
        );

        for (const [
          prevOutputFile,
          currOutputFile,
        ] of prevToCurrentMap.entries()) {
          const result = await this.runner.runDiffBetweenRounds(
            prevOutputFile,
            currOutputFile,
          );
          this.logLatexdiffResult(
            result,
            'between-rounds-diff',
            diffProcessGroupId,
          );
          if (result.success && result.diffFileName) {
            const diffPath = path.join(
              path.dirname(prevOutputFile),
              result.diffFileName,
            );
            const buildDir = path.join(path.dirname(diffPath), 'build');
            await compileLatex2Pdf(diffPath, this.channel, buildDir);
          }
        }
      }
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${err instanceof Error ? err.message : String(err)}`,
        diffProcessGroupId,
      );
    }
  }
}
