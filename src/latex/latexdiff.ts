// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - utilities
import {
  logErrorMessage,
  formatError,
} from '@common/errors/errorHandlingUtils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';

// Local imports - latex utils
import { runLatexFormatter } from './texFormatter';

// Local imports - managers
import { DiffFileNameManager } from './latexdiff/diffFileNameManager';
import { DiffFileProcessor } from './latexdiff/diffFileProcessor';
import { DiffCommandExecutor } from './latexdiff/diffCommandExecutor';

export interface LaTeXdiffResult {
  success: boolean;
  diffFileName?: string;
  message?: string;
}

export interface LaTeXdiffMultipleResult {
  success: boolean;
  results: {
    success: string[];
    failed: string[];
  };
  message?: string;
}

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const DEFAULT_LATEXDIFF_TIMEOUT_MS = 10000;

export class LaTeXdiffService {
  private readonly fileNameManager: DiffFileNameManager;
  private readonly fileProcessor: DiffFileProcessor;
  private readonly commandExecutor: DiffCommandExecutor;

  constructor(private readonly channel: string = CHANNEL) {
    this.fileNameManager = new DiffFileNameManager();
    this.fileProcessor = new DiffFileProcessor(channel);
    this.commandExecutor = new DiffCommandExecutor(
      channel,
      this.getLatexdiffTimeout(),
    );
  }

  private getLatexdiffTimeout(): number {
    return getConfig<number>(
      'latexdiff.timeoutMs',
      DEFAULT_LATEXDIFF_TIMEOUT_MS,
    );
  }

  async runDiff(
    inputFile: string,
    editedFile: string,
    suffix = '_diff',
    runIndent = true,
    mathMarkup?: string,
  ): Promise<LaTeXdiffResult> {
    let diffFileName = '';
    let outputPath = '';
    try {
      // Validate inputs
      if (!inputFile) {
        logger.warn(this.channel, 'Input file is empty or undefined');
        return { success: false, message: 'Input file is empty or undefined' };
      }

      if (
        !(await WorkspaceFS.exists(inputFile)) ||
        !(await WorkspaceFS.exists(editedFile))
      ) {
        const message = `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`;
        logger.warn(this.channel, message);
        return { success: false, message };
      }

      // Validate document structure
      if (!(await this.validateDocumentStructure(inputFile, editedFile))) {
        return {
          success: false,
          message: 'Files missing document environment',
        };
      }

      diffFileName = this.fileNameManager.generateDiffFileName(
        inputFile,
        editedFile,
        suffix,
      );
      outputPath = path.join(path.dirname(inputFile), diffFileName);

      logger.debug(
        this.channel,
        `Running latexdiff for ${inputFile} and ${editedFile}`,
      );

      // Format files if requested
      if (runIndent) {
        await this.formatFiles([inputFile, editedFile]);
      }

      // Execute latexdiff command
      const result = await this.commandExecutor.executeDiff(
        inputFile,
        editedFile,
        { mathMarkup },
      );
      if (!result.stdout) {
        throw new Error('Latexdiff produced no output');
      }

      // Write and process output
      await WorkspaceFS.write(outputPath, result.stdout);
      await this.fileProcessor.processDiffFile(outputPath);

      logger.debug(
        this.channel,
        `Latexdiff succeeded: ${inputFile} -> ${editedFile}`,
      );

      return {
        success: true,
        diffFileName,
        message: `LaTeXdiff completed successfully: ${diffFileName}`,
      };
    } catch (err) {
      const message = formatError('Error running LaTeX diff', err);
      logger.error(this.channel, message, undefined, MESSAGE_TYPES.INTERNAL);
      logger.debug(
        this.channel,
        `Latexdiff failed: ${inputFile} -> ${editedFile}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return { success: false, message };
    }
  }

  async runDiffVc(
    inputFile: string,
    commitHash: string,
  ): Promise<LaTeXdiffResult> {
    try {
      if (!(await this.validateDocumentStructure(inputFile))) {
        const message = 'File missing document environment';
        logger.error(this.channel, message);
        vscode.window.showWarningMessage(
          'File must contain \\begin{document} and \\end{document}',
        );
        return { success: false, message };
      }

      const diffFileName = inputFile.replace('.tex', `-diff${commitHash}.tex`);
      const outputPath = path.join(
        path.dirname(inputFile),
        path.basename(diffFileName),
      );

      await this.commandExecutor.executeDiffVc(inputFile, commitHash);
      await this.fileProcessor.processDiffFile(outputPath);

      return {
        success: true,
        diffFileName: path.basename(diffFileName),
        message: `LaTeXdiff VC completed successfully: ${path.basename(diffFileName)}`,
      };
    } catch (err) {
      const message = formatError('Error running LaTeX diff VC', err);
      logger.error(this.channel, message, undefined, MESSAGE_TYPES.INTERNAL);
      return { success: false, message };
    }
  }

  async runDiffVcMultiple(
    inputFiles: string[],
    commitHash: string,
  ): Promise<LaTeXdiffMultipleResult> {
    try {
      if (!inputFiles || inputFiles.length === 0) {
        const message = 'No input files provided';
        logger.warn(this.channel, message);
        return {
          success: false,
          results: { success: [], failed: [] },
          message,
        };
      }

      const results = { success: [] as string[], failed: [] as string[] };

      for (const inputFile of inputFiles) {
        try {
          const result = await this.runDiffVc(inputFile, commitHash);
          if (result.success) {
            results.success.push(inputFile);
          } else {
            results.failed.push(inputFile);
          }
        } catch (err) {
          results.failed.push(inputFile);
          logger.error(
            this.channel,
            `Error processing ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const summary = [
        'LaTeX diff operations completed:',
        results.success.length > 0
          ? `\nSuccessful:\n${results.success.join('\n')}`
          : '',
        results.failed.length > 0
          ? `\nFailed:\n${results.failed.join('\n')}`
          : '',
      ].join('');

      logger.info(this.channel, summary);

      return {
        success: results.failed.length === 0,
        results,
        message: summary,
      };
    } catch (err) {
      const message = formatError('Error in runDiffVcMultiple', err);
      logger.error(this.channel, message, undefined, MESSAGE_TYPES.INTERNAL);
      return {
        success: false,
        results: { success: [], failed: [] },
        message,
      };
    }
  }

  async runDiffForRound(
    baseFile: string,
    outputFile: string,
    _round: number,
    mathMarkup?: string,
  ): Promise<LaTeXdiffResult> {
    try {
      if (
        (await WorkspaceFS.exists(baseFile)) &&
        (await WorkspaceFS.exists(outputFile))
      ) {
        return await this.runDiff(
          baseFile,
          outputFile,
          '_diff',
          false,
          mathMarkup,
        );
      }

      const message = `Could not generate latexdiff for round ${_round}. Files not found: ${baseFile} or ${outputFile}`;
      logger.warn(this.channel, message);
      return { success: false, message };
    } catch (err) {
      const message = formatError('Error in runDiffForRound', err);
      logger.error(this.channel, message, undefined, MESSAGE_TYPES.INTERNAL);
      return { success: false, message };
    }
  }

  async runDiffBetweenRounds(
    outputFile1: string,
    outputFile2: string,
    mathMarkup?: string,
  ): Promise<LaTeXdiffResult> {
    try {
      if (
        (await WorkspaceFS.exists(outputFile1)) &&
        (await WorkspaceFS.exists(outputFile2))
      ) {
        const firstRoundMatch = outputFile1.match(/_r(\d+)_/);
        const secondRoundMatch = outputFile2.match(/_r(\d+)_/);

        if (!firstRoundMatch || !secondRoundMatch) {
          const message = 'Could not extract round numbers from file names';
          logger.warn(this.channel, message);
          return { success: false, message };
        }

        const firstRound = firstRoundMatch[1];
        const secondRound = secondRoundMatch[1];
        const diffSuffix = `_diffr${secondRound}r${firstRound}`;
        return await this.runDiff(
          outputFile1,
          outputFile2,
          diffSuffix,
          false,
          mathMarkup,
        );
      }

      const message = `Could not generate latexdiff between rounds. Files not found: ${outputFile1} or ${outputFile2}`;
      logger.warn(this.channel, message);
      return { success: false, message };
    } catch (err) {
      const message = formatError('Error in runDiffBetweenRounds', err);
      logger.error(this.channel, message, undefined, MESSAGE_TYPES.INTERNAL);
      return { success: false, message };
    }
  }

  private async validateDocumentStructure(
    ...files: string[]
  ): Promise<boolean> {
    for (const file of files) {
      const content = await WorkspaceFS.read(file);
      if (
        !content.includes('\\begin{document}') ||
        !content.includes('\\end{document}')
      ) {
        return false;
      }
    }
    return true;
  }

  private async formatFiles(files: string[]): Promise<void> {
    const failedFiles: string[] = [];
    for (const file of files) {
      if (!(await runLatexFormatter(file))) {
        failedFiles.push(file);
      }
    }
    if (failedFiles.length > 0) {
      logger.warn(
        this.channel,
        `Failed to indent files:\n${failedFiles.join('\n')}\nProceeding with latexdiff anyway.`,
      );
    }
  }
}
