import * as path from 'node:path';

import { formatError, isFileNotFoundError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { executeCommand } from '@utils/system/execUtils';
import { readPlatformSetting } from '@utils/config/platformSettings';
import {
  buildBetweenRoundDiffSuffix,
  generateDiffFileName,
} from './latexdiff/diffFileNameManager';
import { DiffFileProcessor } from './latexdiff/diffFileProcessor';
import { DiffCommandExecutor } from './latexdiff/diffCommandExecutor';
import type { MathMarkupOption } from './latexdiff/mathMarkup';

export interface LaTeXdiffResult {
  success: boolean;
  diffFileName?: string;
  message?: string;
}

function hasDocumentEnvironment(content: string): boolean {
  return (
    content.includes('\\begin{document}') && content.includes('\\end{document}')
  );
}

export class LaTeXdiffService {
  private readonly fileProcessor: DiffFileProcessor;
  private readonly commandExecutor: DiffCommandExecutor;

  private get log() {
    return createLog(this.channel);
  }

  constructor(private readonly channel: string) {
    this.fileProcessor = new DiffFileProcessor();
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
   * which evaluate before `initPlatform()` runs in `activate()`. `readPlatformSetting`
   * uses `tryPlatform()` internally, so it returns the catalog schema default
   * instead of throwing when the platform isn't initialized yet — keeping
   * construction safe. Called per-diff so user updates take effect on the next
   * invocation without any rebuild.
   */
  private getLatexdiffTimeout(): number {
    return readPlatformSetting<number>(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS);
  }

  private logDiffError(context: string, err: unknown): LaTeXdiffResult {
    const message = formatError(context, err);
    this.log.error(message);
    return { success: false, message };
  }

  /** Read both diff inputs, returning null when either input no longer exists. */
  private async readDiffInputs(
    inputLocation: FileLocation,
    editedLocation: FileLocation,
  ): Promise<string[] | null> {
    try {
      return await Promise.all([
        AbsoluteFS.read(inputLocation.absolutePath),
        AbsoluteFS.read(editedLocation.absolutePath),
      ]);
    } catch (error) {
      if (isFileNotFoundError(error)) return null;
      throw error;
    }
  }

  async runDiff(
    inputLocation: FileLocation,
    editedLocation: FileLocation,
    suffix = '_diff',
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; subtype?: string; outputDirectory?: string },
  ): Promise<LaTeXdiffResult> {
    try {
      const inputFile = inputLocation.absolutePath;
      const editedFile = editedLocation.absolutePath;

      if (!inputFile) {
        this.log.warn('Input file is empty or undefined');
        return { success: false, message: 'Input file is empty or undefined' };
      }

      // Direct callers use one read pass for both existence and document
      // structure validation. Round-specific wrappers keep their earlier
      // exists checks so they can report round-specific error messages.
      const contents = await this.readDiffInputs(inputLocation, editedLocation);
      if (!contents) {
        const message = `One or both files do not exist. Input: ${inputFile}, Edited: ${editedFile}`;
        this.log.warn(message);
        return { success: false, message };
      }
      if (!contents.every(hasDocumentEnvironment)) {
        return {
          success: false,
          message: 'Files missing document environment',
        };
      }

      const diffFileName = generateDiffFileName(inputFile, editedFile, suffix);
      const outputDirectory =
        options?.outputDirectory ?? path.dirname(inputFile);
      const outputPath = path.join(outputDirectory, diffFileName);

      this.log.debug(
        `Running latexdiff for ${inputLocation.absolutePath} and ${editedLocation.absolutePath}`,
      );

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
      await AbsoluteFS.ensureDir(outputDirectory);
      const outputLocation = pathToLocation(outputPath);
      await AbsoluteFS.write(outputLocation.absolutePath, result.stdout);
      await this.fileProcessor.processDiffFile(outputLocation, editedLocation);

      this.log.debug(
        `Latexdiff succeeded: ${inputLocation.absolutePath} -> ${editedLocation.absolutePath}`,
      );

      return {
        success: true,
        diffFileName,
        message: `LaTeXdiff completed successfully: ${diffFileName}`,
      };
    } catch (err) {
      this.log.debug(
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
        this.log.error(message);
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
      await this.fileProcessor.processDiffFile(
        pathToLocation(outputPath),
        inputLocation,
      );

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

  async runDiffForRound(
    baseLocation: FileLocation,
    outputLocation: FileLocation,
    round: number,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; outputDirectory?: string },
  ): Promise<LaTeXdiffResult> {
    try {
      if (!(await this.bothFilesExist(baseLocation, outputLocation))) {
        const message = `Could not generate latexdiff for round ${round}. Files not found: ${baseLocation.absolutePath} or ${outputLocation.absolutePath}`;
        this.log.warn(message);
        return { success: false, message };
      }

      return await this.runDiff(
        baseLocation,
        outputLocation,
        '_diff',
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
    fromRound: number,
    toRound: number,
    mathMarkup?: MathMarkupOption,
    options?: { cwd?: string; outputDirectory?: string },
  ): Promise<LaTeXdiffResult> {
    try {
      if (!(await this.bothFilesExist(firstLocation, secondLocation))) {
        const message = `Could not generate latexdiff between rounds. Files not found: ${firstLocation.absolutePath} or ${secondLocation.absolutePath}`;
        this.log.warn(message);
        return { success: false, message };
      }

      const diffSuffix = buildBetweenRoundDiffSuffix(toRound, fromRound);
      return await this.runDiff(
        firstLocation,
        secondLocation,
        diffSuffix,
        mathMarkup,
        options,
      );
    } catch (err) {
      return this.logDiffError('Error in runDiffBetweenRounds', err);
    }
  }

  private async validateDocumentStructure(
    file: FileLocation,
  ): Promise<boolean> {
    return hasDocumentEnvironment(await AbsoluteFS.read(file.absolutePath));
  }

  private async bothFilesExist(
    first: FileLocation,
    second: FileLocation,
  ): Promise<boolean> {
    const [firstExists, secondExists] = await Promise.all([
      AbsoluteFS.exists(first.absolutePath),
      AbsoluteFS.exists(second.absolutePath),
    ]);
    return firstExists && secondExists;
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
}
