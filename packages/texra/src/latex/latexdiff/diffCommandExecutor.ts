// Third-party imports
import { Effect, Schema } from 'effect';

// Internal imports
import { withLogChannel, Settings } from '@texra-ai/harness/host';
import { executeCommand, type ExecResult } from '@texra-ai/harness/node';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';

// Local file imports
import { LATEX_CITATION_COMMANDS } from '../latexParsingUtils';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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

/** One latexdiff or latexdiff-vc run that did not succeed. */
class LatexdiffFailed extends Schema.TaggedError<LatexdiffFailed>()(
  'LatexdiffFailed',
  {
    commandType: Schema.String,
    flatten: Schema.Boolean,
    timedOut: Schema.Boolean,
    timeoutMs: Schema.Number,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    const variant = this.flatten ? '' : ' (without --flatten)';
    if (this.timedOut) {
      return `${this.commandType} operation timed out after ${this.timeoutMs}ms${variant}`;
    }
    return this.stderr
      ? `Failed to run ${this.commandType}${variant}: ${this.stderr}`
      : `Failed to run ${this.commandType}${variant}`;
  }
}

export class DiffCommandExecutor {
  constructor(
    private readonly channel: string,
    /** The roots of the workspace this diff belongs to; its settings are read
     *  from these slots, never from the calling context's. */
    private readonly roots: WorkspaceRoots,
  ) {}

  private setting<T>(key: string) {
    return Settings.get<T>(this.roots, key);
  }

  executeDiff(
    inputFile: string,
    editedFile: string,
    options: DiffExecutionOptions,
  ): Effect.Effect<ExecResult, Error, ChildProcessSpawner> {
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
  ): Effect.Effect<ExecResult, Error, ChildProcessSpawner> {
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
  ): Effect.Effect<ExecResult, Error, ChildProcessSpawner> {
    return Effect.gen({ self: this }, function* () {
      // Read the timeout once per invocation so the --flatten attempt and any
      // retry use the same value, while each diff run still picks up a value
      // the user changed since the last one.
      const timeoutMs = yield* this.setting<number>(
        DocumentsStateKey.LATEXDIFF_TIMEOUT_MS,
      );
      const execOptions: CommandExecOptions = {
        channel: this.channel,
        timeout: timeoutMs,
        cwd,
      };
      const attempt = (flatten: boolean) =>
        Effect.gen({ self: this }, function* () {
          const variant = flatten ? 'with --flatten' : 'without --flatten';
          yield* Effect.logDebug(`Running ${commandType} ${variant}`);
          const result = yield* this.exec(
            yield* commandBuilder(flatten),
            execOptions,
          );
          if (!result.success) {
            return yield* new LatexdiffFailed({
              commandType,
              flatten,
              timedOut: result.timedOut,
              timeoutMs,
              stderr: result.stderr,
            });
          }
          yield* Effect.logDebug(
            `${commandType} completed successfully (${variant})`,
          );
          return result;
        });

      return yield* attempt(true).pipe(
        Effect.catchIf(
          (error) =>
            error instanceof LatexdiffFailed &&
            !error.timedOut &&
            this.isBibliographyError(error.stderr),
          () =>
            Effect.logWarning(
              'Bibliography compilation failed with --flatten, retrying without --flatten',
            ).pipe(Effect.andThen(attempt(false))),
        ),
      );
    });
  }

  /** One `executeCommand` invocation, cancelled by the running fiber. */
  private exec(
    command: string[],
    execOptions: CommandExecOptions,
  ): Effect.Effect<ExecResult, never, ChildProcessSpawner> {
    return executeCommand(command, {
      ...execOptions,
      // The roots of the workspace being diffed, held by this executor.
      settings: this.roots,
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
        DocumentsStateKey.LATEXDIFF_CHANGES_ONLY,
      );

      return {
        mathMarkup:
          options.mathMarkup ??
          (yield* this.setting<LatexdiffMathMarkupValue>(
            DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
          )),
        subtype:
          options.subtype ??
          (changesOnly ? LATEXDIFF_CHANGES_ONLY_SUBTYPE : undefined),
      };
    });
  }
}
