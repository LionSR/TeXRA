// Local imports - log
import type { ExecResult } from '@agent/types/ResultTypes';

// Internal imports
import * as logger from '@agent/core/logger';
import { getConfig } from '@agent/core/config';
import { getWorkspaceState } from '@agent/core/stateStore';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { executeCommand } from '@utils/system';

// Local file imports
import { DEFAULT_MATH_MARKUP, type MathMarkupOption } from './mathMarkup';

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

export const LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS = [
  'cite\\*?',
  'citep\\*?',
  'citet\\*?',
  'citealp\\*?',
  'citealt\\*?',
  'citeauthor\\*?',
  'citeyear\\*?',
  'citeyearpar\\*?',
  'parencite\\*?',
  'textcite\\*?',
  'autocite\\*?',
  'footcite\\*?',
  'supercite\\*?',
  'smartcite\\*?',
] as const;

export function buildLatexdiffTextCommandExclusionFlag(): string {
  return `--exclude-textcmd=${LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS.join(',')}`;
}

/**
 * Options for diff execution.
 * @property mathMarkup - Math markup mode ('off' | 'whole' | 'coarse' | 'fine').
 * @property subtype - Subtype for change boundary marking (e.g., 'ONLYCHANGEDPAGE').
 */
interface DiffExecutionOptions {
  mathMarkup?: MathMarkupOption;
  subtype?: string;
  cwd?: string;
}

export class DiffCommandExecutor {
  /**
   * `getTimeoutMs` is read fresh on every diff invocation so user updates to
   * `LATEXDIFF_TIMEOUT_MS` propagate to the next diff without rebuilding the
   * service. Captured as a thunk because `LaTeXdiffService` is constructed at
   * module scope (before `initPlatform()` runs); a captured number would
   * permanently freeze at whatever the default was at activation-zero.
   */
  constructor(
    private readonly channel: string,
    private readonly getTimeoutMs: () => number,
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
        this.buildLatexdiffVcCommand(
          inputFile,
          commitHash,
          useFlatten,
          options,
        ),
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
    const { mathMarkup, pictureEnvs, subtype } =
      this.getLatexdiffConfig(options);
    const command = [
      'latexdiff',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      buildLatexdiffTextCommandExclusionFlag(),
      `--math-markup=${mathMarkup}`,
      ...(subtype ? [`--subtype=${subtype}`] : []),
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
    const { mathMarkup, pictureEnvs, subtype } =
      this.getLatexdiffConfig(options);
    const command = [
      'latexdiff-vc',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      '--force',
      '--git',
      buildLatexdiffTextCommandExclusionFlag(),
      `--math-markup=${mathMarkup}`,
      ...(subtype ? [`--subtype=${subtype}`] : []),
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
    // Snapshot the timeout once per invocation so the value stays consistent
    // across the --flatten attempt and any retry, while still picking up any
    // updates the user has made between successive diff runs.
    const timeoutMs = this.getTimeoutMs();
    const execOptions = { channel: this.channel, timeout: timeoutMs, cwd };

    logger.debug(this.channel, `Attempting ${commandType} with --flatten flag`);
    const result = await executeCommand(commandBuilder(true), execOptions);

    if (result.success) {
      logger.debug(
        this.channel,
        `${commandType} completed successfully (with --flatten)`,
      );
      return result;
    }

    if (result.timedOut) {
      throw new Error(ERROR_MESSAGES.TIMEOUT(commandType, timeoutMs));
    }

    if (!this.isBibliographyError(result.stderr ?? '')) {
      throw new Error(ERROR_MESSAGES.FAILED_GENERAL(commandType));
    }

    return this.retryWithoutFlatten(
      commandBuilder,
      commandType,
      execOptions,
      timeoutMs,
    );
  }

  private async retryWithoutFlatten(
    commandBuilder: (useFlatten: boolean) => string[],
    commandType: string,
    execOptions: { channel: string; timeout: number; cwd?: string },
    timeoutMs: number,
  ): Promise<ExecResult> {
    logger.warn(
      this.channel,
      'Bibliography compilation failed with --flatten, retrying without --flatten',
    );
    logger.debug(
      this.channel,
      `Retrying ${commandType} without --flatten flag`,
    );

    const result = await executeCommand(commandBuilder(false), execOptions);

    if (result.timedOut) {
      throw new Error(ERROR_MESSAGES.TIMEOUT_RETRY(commandType, timeoutMs));
    }

    if (!result.success) {
      throw new Error(ERROR_MESSAGES.FAILED_BOTH(commandType));
    }

    logger.debug(
      this.channel,
      `${commandType} completed successfully (without --flatten)`,
    );
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
    subtype?: string;
  } {
    return {
      mathMarkup:
        options?.mathMarkup ??
        getWorkspaceState().get<MathMarkupOption>(
          WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup as MathMarkupOption,
        ),
      pictureEnvs: getConfig<string>(
        'texra.latexdiff.pictureEnvironments',
        DEFAULT_PICTURE_ENVS,
      ),
      subtype: options?.subtype,
    };
  }
}
