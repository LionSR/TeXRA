import * as path from 'path';

import { z } from 'zod';

import { extractLastRoundMatch } from '@agent/utils/mergeFileUtils';
import * as logger from '@agent/core/logger';
import { tryGetWorkspaceState } from '@agent/core/stateStore';
import { formatError, toErrorMessage } from '@common/errors';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { flexibleFS, pathToLocation, type FileLocation } from '@utils/files';
import { executeCommand } from '@utils/system';
import { runLatexFormatter } from './texFormatter';
import { generateDiffFileName } from './latexdiff/diffFileNameManager';
import { DiffFileProcessor } from './latexdiff/diffFileProcessor';
import { DiffCommandExecutor } from './latexdiff/diffCommandExecutor';
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

const DEFAULT_LATEXDIFF_TIMEOUT_MS = LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs;

export class LaTeXdiffService {
  private readonly fileProcessor: DiffFileProcessor;
  private readonly commandExecutor: DiffCommandExecutor;

  constructor(private readonly channel: string = CHANNEL) {
    this.fileProcessor = new DiffFileProcessor(channel);
    // Pass a thunk so DiffCommandExecutor reads the current workspace value
    // each time it runs a diff. Module-scope instances (in latexdiffCommands.ts
    // and latexPreview.ts) construct before `initPlatform()` runs, so a value
    // captured here would be permanently frozen at the default — defeating
    // user changes to LATEXDIFF_TIMEOUT_MS.
    this.commandExecutor = new DiffCommandExecutor(channel, () =>
      this.getLatexdiffTimeout(),
    );
  }

  /**
   * Resolve the latexdiff timeout from workspace state. Tolerant of
   * pre-initialization: `LaTeXdiffService` is instantiated at module scope in
   * `commands/latex/latexdiffCommands.ts` and `tools/approval/latexPreview.ts`,
   * which evaluate before `initPlatform()` runs in `activate()`. A throwing
   * `getWorkspaceState()` would prevent the extension from activating; falling
   * back to the documented default keeps construction safe. Called per-diff
   * so user updates take effect on the next invocation without any rebuild.
   */
  private getLatexdiffTimeout(): number {
    return (
      tryGetWorkspaceState()?.get<number>(
        WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
        DEFAULT_LATEXDIFF_TIMEOUT_MS,
      ) ?? DEFAULT_LATEXDIFF_TIMEOUT_MS
    );
  }

  private logDiffError(context: string, err: unknown): LaTeXdiffResult {
    const message = formatError(context, err);
    logger.error(this.channel, message);
    return { success: false, message };
  }

  async runDiff(
    inputLocation: FileLocation,
    editedLocation: FileLocation,
    suffix = '_diff',
    runIndent = true,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; subtype?: string; outputDirectory?: string },
  ): Promise<LaTeXdiffResult> {
    try {
      const inputFile = inputLocation.absolutePath;
      const editedFile = editedLocation.absolutePath;

      if (!inputFile) {
        logger.warn(this.channel, 'Input file is empty or undefined');
        return { success: false, message: 'Input file is empty or undefined' };
      }

      const [inputExists, editedExists] = await Promise.all([
        flexibleFS.exists(inputLocation),
        flexibleFS.exists(editedLocation),
      ]);
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

      const diffFileName = generateDiffFileName(inputFile, editedFile, suffix);
      const outputDirectory =
        options?.outputDirectory ?? path.dirname(inputFile);
      const outputPath = path.join(outputDirectory, diffFileName);

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
      await flexibleFS.ensureDir(pathToLocation(outputDirectory));
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
      logger.debug(
        this.channel,
        `Latexdiff failed: ${inputLocation.absolutePath} -> ${editedLocation.absolutePath}`,
      );
      return this.logDiffError('Error running LaTeX diff', err);
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
        const message =
          'File missing document environment (must contain \\begin{document} and \\end{document})';
        logger.error(this.channel, message);
        return { success: false, message };
      }

      // latexdiff-vc --git runs `git show <commit>:<file>`, which expects
      // a path relative to the repo root. Absolute paths break its temp
      // path construction. Resolve via git rev-parse to get the repo root.
      const fileDir = path.dirname(inputFile);
      const gitRoot = await this.getGitRoot(fileDir);
      const cwd = gitRoot ?? fileDir;
      const filePath = gitRoot
        ? path.relative(gitRoot, inputFile)
        : path.basename(inputFile);

      await this.commandExecutor.executeDiffVc(filePath, commitHash, {
        mathMarkup,
        cwd,
      });

      // latexdiff-vc writes output alongside the input, relative to cwd
      const diffFilePath = filePath.replace('.tex', `-diff${commitHash}.tex`);
      const outputPath = path.join(cwd, diffFilePath);
      await this.fileProcessor.processDiffFile(pathToLocation(outputPath));

      const diffFileName = path.basename(diffFilePath);

      return {
        success: true,
        diffFileName,
        message: `LaTeXdiff VC completed successfully: ${diffFileName}`,
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
      if (inputLocations.length === 0) {
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
      const message = formatError('Error in runDiffVcMultiple', err);
      logger.error(this.channel, message);
      return {
        success: false,
        results: { success: [], failed: [] },
        message,
      };
    }
  }

  async runDiffForRound(
    baseLocation: FileLocation,
    outputLocation: FileLocation,
    round: number,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; outputDirectory?: string },
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
    options?: { cwd?: string; outputDirectory?: string },
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

  private async getGitRoot(cwd: string): Promise<string | null> {
    try {
      const result = await executeCommand(
        ['git', 'rev-parse', '--show-toplevel'],
        { channel: this.channel, cwd },
      );
      return result.success && result.stdout ? result.stdout.trim() : null;
    } catch {
      return null;
    }
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
