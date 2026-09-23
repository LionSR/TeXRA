// Third-party imports
import { Effect } from 'effect';

// Internal imports
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { LatexdiffMathMarkupValue } from '@shared/constants/latexConfig';
import type { ExecResult } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { executeCommand } from '@utils/system/execUtils';
import { readSettingFrom } from '@utils/config/platformSettings';

// Local file imports
import { LATEX_CITATION_COMMANDS } from '../latexParsingUtils';

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

/**
 * Options for diff execution.
 * @property mathMarkup - Math markup mode.
 * @property subtype - Subtype for change boundary marking (e.g., 'ONLYCHANGEDPAGE').
 */
interface DiffExecutionOptions {
  mathMarkup?: LatexdiffMathMarkupValue;
  subtype?: string;
  /**
   * Directory the latexdiff process runs in — required so the caller names
   * the root it holds instead of the command reaching for an ambient one
   * (#12421).
   */
  cwd: string | undefined;
}

type CommandExecOptions = {
  channel: string;
  timeout: number;
  cwd: string | undefined;
};

export class DiffCommandExecutor {
  constructor(
    private readonly channel: string,
    /** The roots of the workspace this diff belongs to; its settings are read
     *  from these slots, never from the calling context's. */
    private readonly roots: WorkspaceRoots,
  ) {}

  private setting<T>(key: string) {
    return readSettingFrom<T>(this.roots, key);
  }

  executeDiff(
    inputFile: string,
    editedFile: string,
    options: DiffExecutionOptions,
  ): Effect.Effect<ExecResult, Error> {
    return this.executeWithFallback(
      (useFlatten) =>
        this.buildLatexdiffCommand(inputFile, editedFile, useFlatten, options),
      'latexdiff',
      options.cwd,
    ).pipe(withLogChannel(this.channel));
  }

  executeDiffVc(
    inputFile: string,
    commitHash: string,
    options: DiffExecutionOptions,
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
      options.cwd,
    ).pipe(withLogChannel(this.channel));
  }

  /** Markup-related flags shared by the latexdiff and latexdiff-vc commands. */
  private markupFlags(
    mathMarkup: LatexdiffMathMarkupValue,
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
    useFlatten: boolean,
    options: DiffExecutionOptions,
  ) {
    return Effect.gen({ self: this }, function* () {
      const { mathMarkup, subtype } = yield* this.getLatexdiffConfig(options);
      return [
        'latexdiff',
        ...(useFlatten ? ['--flatten'] : []),
        '--encoding=utf8',
        '-c',
        `PICTUREENV=${LATEXDIFF_PICTURE_ENVIRONMENTS}`,
        ...this.markupFlags(mathMarkup, subtype),
        inputFile,
        editedFile,
      ];
    });
  }

  private buildLatexdiffVcCommand(
    inputFile: string,
    commitHash: string,
    useFlatten: boolean,
    options: DiffExecutionOptions,
  ) {
    return Effect.gen({ self: this }, function* () {
      const { mathMarkup, subtype } = yield* this.getLatexdiffConfig(options);
      return [
        'latexdiff-vc',
        '--encoding=utf8',
        '-c',
        `PICTUREENV=${LATEXDIFF_PICTURE_ENVIRONMENTS}`,
        '--force',
        ...(useFlatten ? ['--flatten'] : []),
        '--git',
        ...this.markupFlags(mathMarkup, subtype),
        '-r',
        commitHash,
        inputFile,
      ];
    });
  }

  /**
   * Run `commandBuilder(true)`, and on a bibliography failure retry it without
   * `--flatten`. The subprocess is torn down by the fiber's own interruption:
   * `executeCommand` kills the process group from its own finalizer.
   */
  private executeWithFallback(
    commandBuilder: (useFlatten: boolean) => Effect.Effect<string[], Error>,
    commandType: string,
    cwd: string | undefined,
  ): Effect.Effect<ExecResult, Error> {
    return Effect.gen({ self: this }, function* () {
      // Snapshot the timeout once per invocation so the value stays consistent
      // across the --flatten attempt and any retry, while still picking up any
      // updates the user has made between successive diff runs. Reading per
      // diff also matters because `LaTeXdiffService` is constructed at module
      // scope (before any host is composed); a value captured at construction
      // would permanently freeze at whatever the default was at activation-zero.
      const timeoutMs = yield* this.setting<number>(
        WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
      );
      const execOptions: CommandExecOptions = {
        channel: this.channel,
        timeout: timeoutMs,
        cwd,
      };

      yield* Effect.logDebug(`Attempting ${commandType} with --flatten flag`);
      const result = yield* this.exec(yield* commandBuilder(true), execOptions);

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
  ): Effect.Effect<ExecResult> {
    return executeCommand(command, {
      ...execOptions,
      // The roots of the workspace being diffed, held by this executor.
      settings: this.roots,
    });
  }

  private retryWithoutFlatten(
    commandBuilder: (useFlatten: boolean) => Effect.Effect<string[], Error>,
    commandType: string,
    execOptions: CommandExecOptions,
  ): Effect.Effect<ExecResult, Error> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.logWarning(
        'Bibliography compilation failed with --flatten, retrying without --flatten',
      );
      yield* Effect.logDebug(`Retrying ${commandType} without --flatten flag`);

      const result = yield* this.exec(
        yield* commandBuilder(false),
        execOptions,
      );

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

  private getLatexdiffConfig(options: DiffExecutionOptions) {
    return Effect.gen({ self: this }, function* () {
      const changesOnly = yield* this.setting<boolean>(
        WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
      );

      return {
        mathMarkup:
          options.mathMarkup ??
          (yield* this.setting<LatexdiffMathMarkupValue>(
            WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          )),
        subtype:
          options.subtype ??
          (changesOnly ? LATEXDIFF_CHANGES_ONLY_SUBTYPE : undefined),
      };
    });
  }
}
