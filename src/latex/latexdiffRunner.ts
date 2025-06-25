// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { executeCommand } from '@utils/system';
import { ExecResult } from '../types/ResultTypes';
import { getConfig } from '@utils/config';
import { logErrorMessage, showLoggedMessage } from '@utils/errorHandlingUtils';

// Local imports - latex utils
import { runLatexFormatter } from './texFormatter';

// Local imports - replacement utils
import replacementEngine from '@replacement/engine';

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

const LATEXDIFF_TIMEOUT_MS = 10000;
const DEFAULT_PICTURE_ENVS =
  '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*';
const DEFAULT_MATH_MARKUP = 'coarse';

const BIBLIOGRAPHY_ERROR_PATTERNS = [
  'bibtex',
  'Something went wrong in executing',
  'latex -draftmode',
  'Running bibtex to generate',
] as const;

const ERROR_MESSAGES = {
  TIMEOUT: (commandType: string, timeoutMs: number) =>
    `${commandType} operation timed out after ${timeoutMs}ms`,
  TIMEOUT_RETRY: (commandType: string, timeoutMs: number) =>
    `${commandType} operation timed out after ${timeoutMs}ms (retry)`,
  FAILED_BOTH: (commandType: string) =>
    `Failed to run ${commandType} (both with and without --flatten)`,
  FAILED_GENERAL: (commandType: string) => `Failed to run ${commandType}`,
} as const;

export class LatexdiffRunner {
  constructor(private readonly channel: string = CHANNEL) {}

  async runDiff(
    inputFile: string,
    editedFile: string,
    suffix = '_diff',
    runIndent = true,
  ): Promise<LaTeXdiffResult> {
    try {
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

      logger.info(
        this.channel,
        `Running latexdiff for ${inputFile} and ${editedFile}`,
      );

      if (runIndent) {
        const indentResults = [] as string[];
        if (!(await runLatexFormatter(inputFile))) {
          indentResults.push(inputFile);
        }
        if (!(await runLatexFormatter(editedFile))) {
          indentResults.push(editedFile);
        }
        if (indentResults.length > 0) {
          logger.warn(
            this.channel,
            `Failed to indent files:\n${indentResults.join('\n')}\nProceeding with latexdiff anyway.`,
          );
        }
      }

      const inputContent = await WorkspaceFS.readFile(inputFile);
      const editedContent = await WorkspaceFS.readFile(editedFile);

      const documentChecks = [
        { file: inputFile, content: inputContent },
        { file: editedFile, content: editedContent },
      ];

      const invalidFiles: string[] = [];
      for (const { file, content } of documentChecks) {
        if (
          !content.includes('\\begin{document}') ||
          !content.includes('\\end{document}')
        ) {
          invalidFiles.push(file);
        }
      }
      if (invalidFiles.length > 0) {
        const message = `Files missing document environment: ${invalidFiles.join(', ')}. Skipping latexdiff.`;
        logger.warn(this.channel, message);
        return { success: false, message };
      }

      const editedFileName = path.basename(editedFile);
      let diffFileName: string;

      const inputRoundMatch = path.basename(inputFile).match(/_r(\d+)_([^.]+)/);
      const editedRoundMatch = editedFileName.match(/_r(\d+)_([^.]+)/);

      if (inputRoundMatch && editedRoundMatch) {
        const firstRound = inputRoundMatch[1];
        const secondRound = editedRoundMatch[1];
        const firstModel = inputRoundMatch[2];
        const secondModel = editedRoundMatch[2];

        if (firstModel === secondModel) {
          const baseNameMatch = path
            .parse(editedFileName)
            .name.match(/^(.*?_r\d+)/);
          if (!baseNameMatch) {
            throw new Error('Failed to extract base name from edited file');
          }
          diffFileName = `${baseNameMatch[1]}_${secondModel}_diffr${secondRound}r${firstRound}.tex`;
        } else {
          const baseNameMatch = path
            .parse(editedFileName)
            .name.match(/^(.*?)_r\d+/);
          if (!baseNameMatch) {
            throw new Error('Failed to extract base name from edited file');
          }
          diffFileName = `${baseNameMatch[1]}_diffr${secondRound}r${firstRound}.tex`;
        }
      } else {
        diffFileName = `${path.parse(editedFileName).name}${suffix}.tex`;
      }

      const outputPath = path.join(path.dirname(inputFile), diffFileName);

      const { mathMarkup, pictureEnvs } = this.getLatexdiffConfig();

      const result = await this.executeWithFallback(
        (useFlatten) =>
          this.buildLatexdiffCommand(
            inputFile,
            editedFile,
            pictureEnvs,
            mathMarkup,
            useFlatten,
          ),
        'latexdiff',
      );

      if (!result.stdout) {
        throw new Error('Latexdiff produced no output');
      }

      await WorkspaceFS.writeFile(outputPath, result.stdout);

      await this.processDiffFile(outputPath);
      await this.processTikzPictureEndings(outputPath);

      return {
        success: true,
        diffFileName,
        message: `LaTeXdiff completed successfully: ${diffFileName}`,
      };
    } catch (err) {
      const message = logErrorMessage(
        this.channel,
        'Error running LaTeX diff',
        err,
      );
      return { success: false, message };
    }
  }

  async runDiffVc(
    inputFile: string,
    commitHash: string,
  ): Promise<LaTeXdiffResult> {
    try {
      const inputContent = await WorkspaceFS.readFile(inputFile);

      if (
        !inputContent.includes('\\begin{document}') ||
        !inputContent.includes('\\end{document}')
      ) {
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

      const { mathMarkup, pictureEnvs } = this.getLatexdiffConfig();

      await this.executeWithFallback(
        (useFlatten) =>
          this.buildLatexdiffVcCommand(
            inputFile,
            commitHash,
            pictureEnvs,
            mathMarkup,
            useFlatten,
          ),
        'latexdiff-vc',
      );

      await this.processDiffFile(outputPath);
      await this.processTikzPictureEndings(outputPath);

      return {
        success: true,
        diffFileName: path.basename(diffFileName),
        message: `LaTeXdiff VC completed successfully: ${path.basename(diffFileName)}`,
      };
    } catch (err) {
      const message = logErrorMessage(
        this.channel,
        'Error running LaTeX diff VC',
        err,
      );
      return { success: false, message };
    }
  }

  async runDiffMultiple(
    inputFiles: string[],
    editedFiles: string[],
  ): Promise<LaTeXdiffMultipleResult> {
    try {
      if (inputFiles.length !== editedFiles.length) {
        const message =
          'The number of input files must match the number of edited files. Stopping latexdiff.';
        await showLoggedMessage(
          this.channel,
          'The number of input files must match the number of edited files',
        );
        return {
          success: false,
          results: { success: [], failed: [] },
          message,
        };
      }

      const results: { success: string[]; failed: string[] } = {
        success: [],
        failed: [],
      };

      for (let i = 0; i < inputFiles.length; i++) {
        try {
          const result = await this.runDiff(
            inputFiles[i],
            editedFiles[i],
            '_diff',
            false,
          );

          if (result.success) {
            results.success.push(inputFiles[i]);
          } else {
            results.failed.push(inputFiles[i]);
          }
        } catch (err) {
          results.failed.push(inputFiles[i]);
          logger.error(
            this.channel,
            `Error processing ${inputFiles[i]}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const summary = [
        'LaTeXdiff operations completed:',
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
      const message = logErrorMessage(
        this.channel,
        'Error in runLatexdiffMultiple',
        err,
      );
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
    round: number,
  ): Promise<LaTeXdiffResult> {
    try {
      if (
        (await WorkspaceFS.exists(baseFile)) &&
        (await WorkspaceFS.exists(outputFile))
      ) {
        return await this.runDiff(baseFile, outputFile, '_diff', false);
      }

      const message = `Could not generate latexdiff for round ${round}. Files not found: ${baseFile} or ${outputFile}`;
      logger.warn(this.channel, message);
      return { success: false, message };
    } catch (err) {
      const message = logErrorMessage(
        this.channel,
        'Error in runLatexdiffForRound',
        err,
      );
      return { success: false, message };
    }
  }

  async runDiffBetweenRounds(
    outputFile1: string,
    outputFile2: string,
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
        return await this.runDiff(outputFile1, outputFile2, diffSuffix, false);
      }

      const message = `Could not generate latexdiff between rounds. Files not found: ${outputFile1} or ${outputFile2}`;
      logger.warn(this.channel, message);
      return { success: false, message };
    } catch (err) {
      const message = logErrorMessage(
        this.channel,
        'Error in runLatexdiffBetweenRounds',
        err,
      );
      return { success: false, message };
    }
  }

  private isBibliographyError(errorOutput: string): boolean {
    return BIBLIOGRAPHY_ERROR_PATTERNS.every((pattern) =>
      errorOutput.includes(pattern),
    );
  }

  private getLatexdiffConfig(): { mathMarkup: string; pictureEnvs: string } {
    return {
      mathMarkup: getConfig<string>(
        'latexdiff.mathMarkup',
        DEFAULT_MATH_MARKUP,
      ),
      pictureEnvs: getConfig<string>(
        'latexdiff.pictureEnvironments',
        DEFAULT_PICTURE_ENVS,
      ),
    };
  }

  private buildLatexdiffCommand(
    inputFile: string,
    editedFile: string,
    pictureEnvs: string,
    mathMarkup: string,
    useFlatten = true,
  ): string[] {
    const baseCommand = [
      'latexdiff',
      '--encoding=utf8',
      '-c',
      `"PICTUREENV=${pictureEnvs}"`,
      `--math-markup=${mathMarkup}`,
      `"${inputFile}"`,
      `"${editedFile}"`,
    ];

    if (useFlatten) {
      baseCommand.splice(1, 0, '--flatten');
    }

    return baseCommand;
  }

  private buildLatexdiffVcCommand(
    inputFile: string,
    commitHash: string,
    pictureEnvs: string,
    mathMarkup: string,
    useFlatten = true,
  ): string[] {
    const baseCommand = [
      'latexdiff-vc',
      '--encoding=utf8',
      '-c',
      `"PICTUREENV=${pictureEnvs}"`,
      '--force',
      '--git',
      `--math-markup=${mathMarkup}`,
      '-r',
      commitHash,
      `"${inputFile}"`,
    ];

    if (useFlatten) {
      baseCommand.splice(5, 0, '--flatten');
    }

    return baseCommand;
  }

  private async executeWithFallback(
    commandBuilder: (useFlatten: boolean) => string[],
    commandType: string,
  ): Promise<ExecResult> {
    logger.debug(this.channel, `Attempting ${commandType} with --flatten flag`);
    let result = await executeCommand(commandBuilder(true), {
      channel: this.channel,
      timeout: LATEXDIFF_TIMEOUT_MS,
    });

    if (!result.success) {
      if (result.timedOut) {
        throw new Error(
          ERROR_MESSAGES.TIMEOUT(commandType, LATEXDIFF_TIMEOUT_MS),
        );
      }

      const errorOutput = result.stderr || '';
      if (this.isBibliographyError(errorOutput)) {
        logger.warn(
          this.channel,
          'Bibliography compilation failed with --flatten, retrying without --flatten',
        );

        logger.debug(
          this.channel,
          `Retrying ${commandType} without --flatten flag`,
        );
        result = await executeCommand(commandBuilder(false), {
          channel: this.channel,
          timeout: LATEXDIFF_TIMEOUT_MS,
        });

        if (!result.success) {
          if (result.timedOut) {
            throw new Error(
              ERROR_MESSAGES.TIMEOUT_RETRY(commandType, LATEXDIFF_TIMEOUT_MS),
            );
          }
          throw new Error(ERROR_MESSAGES.FAILED_BOTH(commandType));
        }

        logger.info(
          this.channel,
          `${commandType} completed successfully (without --flatten)`,
        );
      } else {
        throw new Error(ERROR_MESSAGES.FAILED_GENERAL(commandType));
      }
    } else {
      logger.info(
        this.channel,
        `${commandType} completed successfully (with --flatten)`,
      );
    }

    return result;
  }

  private async processDiffFile(diffFileName: string): Promise<void> {
    try {
      const content = await WorkspaceFS.readFile(diffFileName);

      let processedContent = content;
      const starEnvironments = [
        'align\\*',
        'equation\\*',
        'gather\\*',
        'multline\\*',
        'flalign\\*',
        'alignat\\*',
      ];

      const envPattern = starEnvironments.join('|');
      const starEnvRegex = new RegExp(
        `\\\\begin\\{(${envPattern})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
        'g',
      );

      processedContent = processedContent.replace(
        starEnvRegex,
        (_match, envName, envContent) => {
          const cleanContent = envContent.replace(/\\label\{[^}]*\}/g, '');
          return `\\begin{${envName}}${cleanContent}\\end{${envName}}`;
        },
      );

      const lines = processedContent.split('\n');
      let newContent = '';
      let addBlock = false;
      const packagesToAddNewline = [
        '\\usepackage{tikz}',
        '\\usepackage{pgfplots}',
        '\\providecommand{\\DIFaddbegin}',
        '\\RequirePackage[normalem]{ulem}',
        '\\usetikzlibrary',
        '\\RequirePackage{color}',
      ];

      let documentStarted = false;

      for (const line of lines) {
        if (
          line.startsWith('%!TEX root') ||
          line.startsWith('% !TEX root') ||
          line.startsWith('%! TEX root')
        ) {
          continue;
        }

        if (packagesToAddNewline.some((pkg) => line.includes(pkg))) {
          newContent += '\n';
        }

        if (line.includes('\\documentclass') || line.includes('\\input')) {
          addBlock = false;
          documentStarted = true;
        } else if (
          (line.includes('%DIF ADD') ||
            line.includes('Here is') ||
            line.includes('以下是')) &&
          !documentStarted
        ) {
          addBlock = true;
        }

        if (!addBlock) {
          newContent += line + '\n';
        }

        if (line.includes('\\RequirePackage{color}')) {
          newContent += '\n';
        }
      }

      newContent = replacementEngine.applyAll(newContent);

      await WorkspaceFS.writeFile(diffFileName, newContent);
    } catch (err) {
      logger.error(
        this.channel,
        `Error processing diff file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async processTikzPictureEndings(filePath: string): Promise<void> {
    const content = await WorkspaceFS.readFile(filePath);

    let newContent = content;
    const patterns = [
      [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
      [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
    ];

    for (const [pattern, replacement] of patterns) {
      newContent = newContent.replace(pattern, replacement as string);
    }

    await WorkspaceFS.writeFile(filePath, newContent);
  }
}
