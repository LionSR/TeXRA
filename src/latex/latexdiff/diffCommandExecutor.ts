// Internal imports
import * as logger from '@logger/logUtils';
import type { ExecResult } from '@shared/schemas/opResults';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { executeCommand } from '@utils/system/execUtils';
import { readPlatformSetting } from '@utils/config/platformSettings';

// Local file imports
import type { MathMarkupOption } from './mathMarkup';

const LATEXDIFF_PICTURE_ENVIRONMENTS =
  '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*';

const BIBLIOGRAPHY_ERROR_PATTERNS = [
  'bibtex',
  'Something went wrong in executing',
  'latex -draftmode',
  'Running bibtex to generate',
] as const;

export const LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS = Object.freeze([
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
] as const);

export const LATEXDIFF_CHANGES_ONLY_SUBTYPE = 'ONLYCHANGEDPAGE';

export function resolveLatexdiffSubtype(options?: {
  subtype?: string;
  changesOnly?: boolean;
}): string | undefined {
  return (
    options?.subtype ??
    (options?.changesOnly ? LATEXDIFF_CHANGES_ONLY_SUBTYPE : undefined)
  );
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

type CommandExecOptions = { channel: string; timeout: number; cwd?: string };

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

  /** Markup-related flags shared by the latexdiff and latexdiff-vc commands. */
  private markupFlags(
    mathMarkup: MathMarkupOption,
    subtype?: string,
  ): string[] {
    return [
      '--graphics-markup=none',
      `--exclude-textcmd=${LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS.join(',')}`,
      `--math-markup=${mathMarkup}`,
      ...(subtype ? [`--subtype=${subtype}`] : []),
    ];
  }

  private buildLatexdiffCommand(
    inputFile: string,
    editedFile: string,
    useFlatten = true,
    options?: DiffExecutionOptions,
  ): string[] {
    const { mathMarkup, pictureEnvs, subtype } =
      this.getLatexdiffConfig(options);
    return [
      'latexdiff',
      ...(useFlatten ? ['--flatten'] : []),
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      ...this.markupFlags(mathMarkup, subtype),
      inputFile,
      editedFile,
    ];
  }

  private buildLatexdiffVcCommand(
    inputFile: string,
    commitHash: string,
    useFlatten = true,
    options?: DiffExecutionOptions,
  ): string[] {
    const { mathMarkup, pictureEnvs, subtype } =
      this.getLatexdiffConfig(options);
    return [
      'latexdiff-vc',
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${pictureEnvs}`,
      '--force',
      ...(useFlatten ? ['--flatten'] : []),
      '--git',
      ...this.markupFlags(mathMarkup, subtype),
      '-r',
      commitHash,
      inputFile,
    ];
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
    const execOptions: CommandExecOptions = {
      channel: this.channel,
      timeout: timeoutMs,
      cwd,
    };

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
      throw new Error(
        `${commandType} operation timed out after ${timeoutMs}ms`,
      );
    }

    if (!this.isBibliographyError(result.stderr ?? '')) {
      throw new Error(
        result.stderr
          ? `Failed to run ${commandType}: ${result.stderr}`
          : `Failed to run ${commandType}`,
      );
    }

    return this.retryWithoutFlatten(commandBuilder, commandType, execOptions);
  }

  private async retryWithoutFlatten(
    commandBuilder: (useFlatten: boolean) => string[],
    commandType: string,
    execOptions: CommandExecOptions,
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
      throw new Error(
        `${commandType} operation timed out after ${execOptions.timeout}ms (retry)`,
      );
    }

    if (!result.success) {
      throw new Error(
        `Failed to run ${commandType} (both with and without --flatten)`,
      );
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
    const changesOnly = readPlatformSetting<boolean>(
      WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
    );

    return {
      mathMarkup:
        options?.mathMarkup ??
        readPlatformSetting<MathMarkupOption>(
          WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
        ),
      pictureEnvs: LATEXDIFF_PICTURE_ENVIRONMENTS,
      subtype: resolveLatexdiffSubtype({
        subtype: options?.subtype,
        changesOnly,
      }),
    };
  }
}
