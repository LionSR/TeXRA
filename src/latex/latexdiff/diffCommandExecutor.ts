// Local imports - log
import type { ExecResult } from '@agent/types/ResultTypes';

// Internal imports
import * as logger from '@logger/logUtils';
import { executeCommand } from '@utils/system';
import { getConfig } from '@utils/config';

// Local file imports
import { DEFAULT_MATH_MARKUP, type MathMarkupOption } from './mathMarkup';
import { DEFAULT_SUBTYPE, type SubtypeOption } from './subtype';

const DEFAULT_PICTURE_ENVS =
  '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*';

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

/**
 * Options for diff execution.
 * @property mathMarkup - Math markup mode ('off' | 'whole' | 'coarse' | 'fine').
 * Overrides the configured default for this execution.
 * @property subtype - Subtype controlling change boundary marking.
 * Use 'ONLYCHANGEDPAGE' to show only pages containing changes.
 */
interface DiffExecutionOptions {
  mathMarkup?: MathMarkupOption;
  subtype?: SubtypeOption;
  cwd?: string;
}

export class DiffCommandExecutor {
  constructor(
    private readonly channel: string,
    private readonly timeoutMs: number,
  ) {}

  async executeDiff(
    inputFile: string,
    editedFile: string,
    options?: DiffExecutionOptions,
  ): Promise<ExecResult> {
    return this.executeWithFallback(
      (useFlatten) =>
        this.buildLatexdiffCommand(inputFile, editedFile, useFlatten, options),
      'latexdiff',
      options?.cwd,
    );
  }

  async executeDiffVc(
    inputFile: string,
    commitHash: string,
    options?: DiffExecutionOptions,
  ): Promise<ExecResult> {
    return this.executeWithFallback(
      (useFlatten) =>
        this.buildLatexdiffVcCommand(inputFile, commitHash, useFlatten, options),
      'latexdiff-vc',
      options?.cwd,
    );
  }

  /** Insert --flatten flag at specified position if needed (returns new array) */
  private insertFlattenFlag(
    command: string[],
    position: number,
    useFlatten: boolean,
  ): string[] {
    if (!useFlatten) {
      return command;
    }
    return command.toSpliced(position, 0, '--flatten');
  }

  private buildLatexdiffCommand(
    inputFile: string,
    editedFile: string,
    useFlatten = true,
    options?: DiffExecutionOptions,
  ): string[] {
    const { mathMarkup, pictureEnvs, subtype } = this.getLatexdiffConfig(options);
    const command = [
      'latexdiff',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      `--math-markup=${mathMarkup}`,
      `--subtype=${subtype}`,
      inputFile,
      editedFile,
    ];
    return this.insertFlattenFlag(command, 1, useFlatten);
  }

  private buildLatexdiffVcCommand(
    inputFile: string,
    commitHash: string,
    useFlatten = true,
    options?: DiffExecutionOptions,
  ): string[] {
    const { mathMarkup, pictureEnvs, subtype } = this.getLatexdiffConfig(options);
    const command = [
      'latexdiff-vc',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      '--force',
      '--git',
      `--math-markup=${mathMarkup}`,
      `--subtype=${subtype}`,
      '-r',
      commitHash,
      inputFile,
    ];
    return this.insertFlattenFlag(command, 5, useFlatten);
  }

  private async executeWithFallback(
    commandBuilder: (useFlatten: boolean) => string[],
    commandType: string,
    cwd?: string,
  ): Promise<ExecResult> {
    logger.debug(this.channel, `Attempting ${commandType} with --flatten flag`);
    let result = await executeCommand(commandBuilder(true), {
      channel: this.channel,
      timeout: this.timeoutMs,
      cwd,
    });

    if (!result.success) {
      if (result.timedOut) {
        throw new Error(ERROR_MESSAGES.TIMEOUT(commandType, this.timeoutMs));
      }

      const errorOutput = result.stderr ?? '';
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
          timeout: this.timeoutMs,
          cwd,
        });

        if (!result.success) {
          if (result.timedOut) {
            throw new Error(
              ERROR_MESSAGES.TIMEOUT_RETRY(commandType, this.timeoutMs),
            );
          }
          throw new Error(ERROR_MESSAGES.FAILED_BOTH(commandType));
        }

        logger.debug(
          this.channel,
          `${commandType} completed successfully (without --flatten)`,
        );
      } else {
        throw new Error(ERROR_MESSAGES.FAILED_GENERAL(commandType));
      }
    } else {
      logger.debug(
        this.channel,
        `${commandType} completed successfully (with --flatten)`,
      );
    }

    return result;
  }

  private isBibliographyError(errorOutput: string): boolean {
    return BIBLIOGRAPHY_ERROR_PATTERNS.every((pattern) =>
      errorOutput.includes(pattern),
    );
  }

  private getLatexdiffConfig(options?: DiffExecutionOptions): {
    mathMarkup: MathMarkupOption;
    pictureEnvs: string;
    subtype: SubtypeOption;
  } {
    return {
      mathMarkup:
        options?.mathMarkup ??
        getConfig<MathMarkupOption>(
          'texra.latexdiff.mathMarkup',
          DEFAULT_MATH_MARKUP,
        ),
      pictureEnvs: getConfig<string>(
        'texra.latexdiff.pictureEnvironments',
        DEFAULT_PICTURE_ENVS,
      ),
      subtype:
        options?.subtype ??
        getConfig<SubtypeOption>('texra.latexdiff.subtype', DEFAULT_SUBTYPE),
    };
  }
}
