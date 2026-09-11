// Third-party imports
import { Effect } from 'effect';

// Internal imports
import { withLogChannel } from '@logger/effectLog';
import type { ExecResult } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { ensureError } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';
import { readPlatformSetting } from '@utils/config/platformSettings';

// Local file imports
import { LATEX_CITATION_COMMANDS } from '../latexParsingUtils';
import type { MathMarkupOption } from './mathMarkup';

const LATEXDIFF_PICTURE_ENVIRONMENTS =
  '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*';

const BIBLIOGRAPHY_ERROR_PATTERNS = [
  'bibtex',
  'Something went wrong in executing',
  'latex -draftmode',
  'Running bibtex to generate',
] as const;

/**
 * `--exclude-textcmd` argument: every citation macro, starred forms included,
 * whose argument latexdiff must leave alone instead of marking up as prose.
 */
const LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS: readonly string[] =
  Object.freeze(LATEX_CITATION_COMMANDS.map((name) => `${name}\\*?`));

const LATEXDIFF_CHANGES_ONLY_SUBTYPE = 'ONLYCHANGEDPAGE';

function resolveLatexdiffSubtype(options?: {
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
  constructor(private readonly channel: string) {}

  executeDiff(
    inputFile: string,
    editedFile: string,
    options?: DiffExecutionOptions,
  ): Effect.Effect<ExecResult, Error> {
    return this.executeWithFallback(
      (useFlatten) =>
        this.buildLatexdiffCommand(inputFile, editedFile, useFlatten, options),
      'latexdiff',
      options?.cwd,
    ).pipe(withLogChannel(this.channel));
  }

  executeDiffVc(
    inputFile: string,
    commitHash: string,
    options?: DiffExecutionOptions,
  ): Effect.Effect<ExecResult, Error> {
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
    ).pipe(withLogChannel(this.channel));
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

  /**
   * Run `commandBuilder(true)`, and on a bibliography failure retry it without
   * `--flatten`. The subprocess is torn down by the fiber's own interruption:
   * `Effect.tryPromise` hands the thunk the `AbortSignal` that `executeCommand`
   * uses to kill the process group.
   */
  private executeWithFallback(
    commandBuilder: (useFlatten: boolean) => string[],
    commandType: string,
    cwd?: string,
  ): Effect.Effect<ExecResult, Error> {
    return Effect.gen({ self: this }, function* () {
      // Snapshot the timeout once per invocation so the value stays consistent
      // across the --flatten attempt and any retry, while still picking up any
      // updates the user has made between successive diff runs. Reading per
      // diff also matters because `LaTeXdiffService` is constructed at module
      // scope (before `initPlatform()` runs); a value captured at construction
      // would permanently freeze at whatever the default was at activation-zero.
      const timeoutMs = readPlatformSetting<number>(
        WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
      );
      const execOptions: CommandExecOptions = {
        channel: this.channel,
        timeout: timeoutMs,
        cwd,
      };

      yield* Effect.logDebug(`Attempting ${commandType} with --flatten flag`);
      const result = yield* this.exec(commandBuilder(true), execOptions);

      if (result.success) {
        yield* Effect.logDebug(
          `${commandType} completed successfully (with --flatten)`,
        );
        return result;
      }

      if (result.timedOut) {
        return yield* Effect.fail(
          new Error(`${commandType} operation timed out after ${timeoutMs}ms`),
        );
      }

      if (!this.isBibliographyError(result.stderr)) {
        return yield* Effect.fail(
          new Error(
            result.stderr
              ? `Failed to run ${commandType}: ${result.stderr}`
              : `Failed to run ${commandType}`,
          ),
        );
      }

      return yield* this.retryWithoutFlatten(
        commandBuilder,
        commandType,
        execOptions,
      );
    });
  }

  /** One `executeCommand` invocation, cancelled by the running fiber. */
  private exec(
    command: string[],
    execOptions: CommandExecOptions,
  ): Effect.Effect<ExecResult, Error> {
    return Effect.tryPromise({
      try: (signal) => executeCommand(command, { ...execOptions, signal }),
      catch: ensureError,
    });
  }

  private retryWithoutFlatten(
    commandBuilder: (useFlatten: boolean) => string[],
    commandType: string,
    execOptions: CommandExecOptions,
  ): Effect.Effect<ExecResult, Error> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.logWarning(
        'Bibliography compilation failed with --flatten, retrying without --flatten',
      );
      yield* Effect.logDebug(`Retrying ${commandType} without --flatten flag`);

      const result = yield* this.exec(commandBuilder(false), execOptions);

      if (result.timedOut) {
        return yield* Effect.fail(
          new Error(
            `${commandType} operation timed out after ${execOptions.timeout}ms (retry)`,
          ),
        );
      }

      if (!result.success) {
        return yield* Effect.fail(
          new Error(
            `Failed to run ${commandType} (both with and without --flatten)`,
          ),
        );
      }

      yield* Effect.logDebug(
        `${commandType} completed successfully (without --flatten)`,
      );
      return result;
    });
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
