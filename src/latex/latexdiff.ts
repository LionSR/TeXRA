// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - log
import { extractLastRoundMatch } from '@agent/utils/mergeFileUtils';
import { formatError, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { MESSAGE_TYPES } from '@shared/schemas';
import { flexibleFS, pathToLocation } from '@utils/files';
import type { FileLocation } from '@shared/schemas';
import { getConfig } from '@utils/config';

// Local imports - latex utils
import { runLatexFormatter } from './texFormatter';
import { generateDiffFileName } from './latexdiff/diffFileNameManager';
import { DiffFileProcessor } from './latexdiff/diffFileProcessor';
import { DiffCommandExecutor } from './latexdiff/diffCommandExecutor';

// Type imports
import type { MathMarkupOption } from './latexdiff/mathMarkup';

// ============================================================================
// LaTeXdiff Result Schemas
// ============================================================================

export const LaTeXdiffResultSchema = z.object({
  success: z.boolean(),
  diffFileName: z.string().optional(),
  message: z.string().optional(),
});
export type LaTeXdiffResult = z.infer<typeof LaTeXdiffResultSchema>;

export const LaTeXdiffMultipleResultSchema = z.object({
  success: z.boolean(),
  results: z.object({
    success: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  message: z.string().optional(),
});
export type LaTeXdiffMultipleResult = z.infer<
  typeof LaTeXdiffMultipleResultSchema
>;

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

const DEFAULT_LATEXDIFF_TIMEOUT_MS = 10000;

export class LaTeXdiffService {
  private readonly fileProcessor: DiffFileProcessor;
  private readonly commandExecutor: DiffCommandExecutor;

  constructor(private readonly channel: string = CHANNEL) {
    this.fileProcessor = new DiffFileProcessor(channel);
    this.commandExecutor = new DiffCommandExecutor(
      channel,
      this.getLatexdiffTimeout(),
    );
  }

  private getLatexdiffTimeout(): number {
    return getConfig<number>(
      'texra.latexdiff.timeoutMs',
      DEFAULT_LATEXDIFF_TIMEOUT_MS,
    );
  }

  private logDiffError(context: string, err: unknown): LaTeXdiffResult {
    const message = formatError(context, err);
    logger.error(this.channel, message, {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
    return { success: false, message };
  }

  private logDiffMultipleError(
    context: string,
    err: unknown,
  ): LaTeXdiffMultipleResult {
    const message = formatError(context, err);
    logger.error(this.channel, message, {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
    return {
      success: false,
      results: { success: [], failed: [] },
      message,
    };
  }

  async runDiff(
    inputLocation: FileLocation,
    editedLocation: FileLocation,
    suffix = '_diff',
    runIndent = true,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; subtype?: string },
  ): Promise<LaTeXdiffResult> {
    let diffFileName = '';
    let outputPath = '';
    try {
      // Extract absolute paths for file operations
      const inputFile = inputLocation.absolutePath;
      const editedFile = editedLocation.absolutePath;

      // Validate inputs
      if (!inputFile) {
        logger.warn(this.channel, 'Input file is empty or undefined');
        return { success: false, message: 'Input file is empty or undefined' };
      }

      const inputExists = await flexibleFS.exists(inputLocation);
      const editedExists = await flexibleFS.exists(editedLocation);
      if (!inputExists || !editedExists) {
        const message = `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`;
        logger.warn(this.channel, message);
        return { success: false, message };
      }

      // Validate document structure
      if (
        !(await this.validateDocumentStructure(inputLocation, editedLocation))
      ) {
        return {
          success: false,
          message: 'Files missing document environment',
        };
      }

      diffFileName = generateDiffFileName(inputFile, editedFile, suffix);
      outputPath = path.join(path.dirname(inputFile), diffFileName);

      logger.debug(
        this.channel,
        `Running latexdiff for ${inputLocation.absolutePath} and ${editedLocation.absolutePath}`,
      );

      // Format files if requested
      if (runIndent) {
        await this.formatFiles([inputLocation, editedLocation]);
      }

      // Execute latexdiff command
      const result = await this.commandExecutor.executeDiff(
        inputFile,
        editedFile,
        { mathMarkup, subtype: options?.subtype, cwd: options?.cwd },
      );
      if (!result.stdout) {
        throw new Error('Latexdiff produced no output');
      }

      // Write and process output
      const outputLocation = pathToLocation(outputPath);
      await flexibleFS.write(outputLocation, result.stdout);
      await this.fileProcessor.processDiffFile(outputLocation);

      logger.debug(
        this.channel,
        `Latexdiff succeeded: ${inputLocation.absolutePath} -> ${editedLocation.absolutePath}`,
      );

      return {
        success: true,
        diffFileName,
        message: `LaTeXdiff completed successfully: ${diffFileName}`,
      };
    } catch (err) {
      const result = this.logDiffError('Error running LaTeX diff', err);
      logger.debug(
        this.channel,
        `Latexdiff failed: ${inputLocation.absolutePath} -> ${editedLocation.absolutePath}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
      return result;
    }
  }

  async runDiffVc(
    inputLocation: FileLocation,
    commitHash: string,
    mathMarkup?: MathMarkupOption,
  ): Promise<LaTeXdiffResult> {
    try {
      const inputFile = inputLocation.absolutePath;
      if (!(await this.validateDocumentStructure(inputLocation))) {
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

      await this.commandExecutor.executeDiffVc(inputFile, commitHash, {
        mathMarkup,
      });
      await this.fileProcessor.processDiffFile(pathToLocation(outputPath));

      return {
        success: true,
        diffFileName: path.basename(diffFileName),
        message: `LaTeXdiff VC completed successfully: ${path.basename(diffFileName)}`,
      };
    } catch (err) {
      return this.logDiffError('Error running LaTeX diff VC', err);
    }
  }

  async runDiffVcMultiple(
    inputLocations: FileLocation[],
    commitHash: string,
    mathMarkup?: MathMarkupOption,
  ): Promise<LaTeXdiffMultipleResult> {
    try {
      if (!inputLocations || inputLocations.length === 0) {
        const message = 'No input files provided';
        logger.warn(this.channel, message);
        return {
          success: false,
          results: { success: [], failed: [] },
          message,
        };
      }

      const results = { success: [] as string[], failed: [] as string[] };

      for (const inputLocation of inputLocations) {
        try {
          const result = await this.runDiffVc(
            inputLocation,
            commitHash,
            mathMarkup,
          );
          const inputFile = inputLocation.absolutePath;
          if (result.success) {
            results.success.push(inputFile);
          } else {
            results.failed.push(inputFile);
          }
        } catch (err) {
          const inputFile = inputLocation.absolutePath;
          results.failed.push(inputFile);
          logger.error(
            this.channel,
            `Error processing ${inputFile}: ${toErrorMessage(err)}`,
          );
        }
      }

      const summaryParts = ['LaTeX diff operations completed:'];
      if (results.success.length > 0) {
        summaryParts.push(`Successful:\n${results.success.join('\n')}`);
      }
      if (results.failed.length > 0) {
        summaryParts.push(`Failed:\n${results.failed.join('\n')}`);
      }
      const summary = summaryParts.join('\n');

      logger.info(this.channel, summary);

      return {
        success: results.failed.length === 0,
        results,
        message: summary,
      };
    } catch (err) {
      return this.logDiffMultipleError('Error in runDiffVcMultiple', err);
    }
  }

  async runDiffForRound(
    baseLocation: FileLocation,
    outputLocation: FileLocation,
    round: number,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string },
  ): Promise<LaTeXdiffResult> {
    try {
      const [baseExists, outputExists] = await Promise.all([
        flexibleFS.exists(baseLocation),
        flexibleFS.exists(outputLocation),
      ]);

      if (!baseExists || !outputExists) {
        const message = `Could not generate latexdiff for round ${round}. Files not found: ${baseLocation.absolutePath} or ${outputLocation.absolutePath}`;
        logger.warn(this.channel, message);
        return { success: false, message };
      }

      return await this.runDiff(
        baseLocation,
        outputLocation,
        '_diff',
        false,
        mathMarkup,
        options,
      );
    } catch (err) {
      return this.logDiffError('Error in runDiffForRound', err);
    }
  }

  async runDiffBetweenRounds(
    firstLocation: FileLocation,
    secondLocation: FileLocation,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string },
  ): Promise<LaTeXdiffResult> {
    try {
      const [firstExists, secondExists] = await Promise.all([
        flexibleFS.exists(firstLocation),
        flexibleFS.exists(secondLocation),
      ]);

      if (!firstExists || !secondExists) {
        const message = `Could not generate latexdiff between rounds. Files not found: ${firstLocation.absolutePath} or ${secondLocation.absolutePath}`;
        logger.warn(this.channel, message);
        return { success: false, message };
      }

      const firstRoundMatch = extractLastRoundMatch(firstLocation.absolutePath);
      const secondRoundMatch = extractLastRoundMatch(
        secondLocation.absolutePath,
      );

      if (!firstRoundMatch || !secondRoundMatch) {
        const message = 'Could not extract round numbers from file names';
        logger.warn(this.channel, message);
        return { success: false, message };
      }

      const diffSuffix = `_diffr${secondRoundMatch[1]}r${firstRoundMatch[1]}`;
      return await this.runDiff(
        firstLocation,
        secondLocation,
        diffSuffix,
        false,
        mathMarkup,
        options,
      );
    } catch (err) {
      return this.logDiffError('Error in runDiffBetweenRounds', err);
    }
  }

  private async validateDocumentStructure(
    ...files: FileLocation[]
  ): Promise<boolean> {
    for (const file of files) {
      const content = await flexibleFS.read(file);
      if (
        !content.includes('\\begin{document}') ||
        !content.includes('\\end{document}')
      ) {
        return false;
      }
    }
    return true;
  }

  private async formatFiles(fileLocations: FileLocation[]): Promise<void> {
    const failedFiles: string[] = [];
    for (const location of fileLocations) {
      const file = location.absolutePath;
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
