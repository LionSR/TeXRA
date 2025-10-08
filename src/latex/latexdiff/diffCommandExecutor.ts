// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { executeCommand } from '@utils/system';
import { getConfig } from '@utils/config';
import type { ExecResult } from '@agent/types/ResultTypes';
import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  type MathMarkupOption,
} from './mathMarkup';

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
 */
interface DiffExecutionOptions {
  mathMarkup?: MathMarkupOption;
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
        this.buildLatexdiffCommand(
          inputFile,
          editedFile,
          useFlatten,
          options?.mathMarkup,
        ),
      'latexdiff',
    );
  }

  async executeDiffVc(
    inputFile: string,
    commitHash: string,
    options?: DiffExecutionOptions,
  ): Promise<ExecResult> {
    return this.executeWithFallback(
      (useFlatten) =>
        this.buildLatexdiffVcCommand(
          inputFile,
          commitHash,
          useFlatten,
          options?.mathMarkup,
        ),
      'latexdiff-vc',
    );
  }

  private buildLatexdiffCommand(
    inputFile: string,
    editedFile: string,
    useFlatten = true,
    mathMarkupOverride?: MathMarkupOption,
  ): string[] {
    const { mathMarkup, pictureEnvs } =
      this.getLatexdiffConfig(mathMarkupOverride);
    const baseCommand = [
      'latexdiff',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      `--math-markup=${mathMarkup}`,
      inputFile,
      editedFile,
    ];

    if (useFlatten) {
      baseCommand.splice(1, 0, '--flatten');
    }

    return baseCommand;
  }

  private buildLatexdiffVcCommand(
    inputFile: string,
    commitHash: string,
    useFlatten = true,
    mathMarkupOverride?: MathMarkupOption,
  ): string[] {
    const { mathMarkup, pictureEnvs } =
      this.getLatexdiffConfig(mathMarkupOverride);
    const baseCommand = [
      'latexdiff-vc',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      '--force',
      '--git',
      `--math-markup=${mathMarkup}`,
      '-r',
      commitHash,
      inputFile,
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
      timeout: this.timeoutMs,
    });

    if (!result.success) {
      if (result.timedOut) {
        throw new Error(ERROR_MESSAGES.TIMEOUT(commandType, this.timeoutMs));
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
          timeout: this.timeoutMs,
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

  private getLatexdiffConfig(mathMarkupOverride?: MathMarkupOption): {
    mathMarkup: MathMarkupOption;
    pictureEnvs: string;
  } {
    const configuredMathMarkup = getConfig<string>(
      'latexdiff.mathMarkup',
      DEFAULT_MATH_MARKUP,
    );
    const normalizedConfig = MATH_MARKUP_OPTIONS.includes(
      configuredMathMarkup as MathMarkupOption,
    )
      ? (configuredMathMarkup as MathMarkupOption)
      : DEFAULT_MATH_MARKUP;

    return {
      mathMarkup: mathMarkupOverride ?? normalizedConfig,
      pictureEnvs: getConfig<string>(
        'latexdiff.pictureEnvironments',
        DEFAULT_PICTURE_ENVS,
      ),
    };
  }
}
