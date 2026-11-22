// Third-party imports
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Ref,
  Result,
} from 'effect';
import {
  CliConfig,
  CliError,
  Command,
  Completions,
  Flag,
  GlobalFlag,
} from 'effect/cli';
import * as NodeServices from '@effect/platform-node/NodeServices';

// Local imports - harness and app
import { setLogSink } from '@texra-ai/worldline/node';
import {
  APPROVAL_POLICIES,
  ensureError,
  formatWordList,
} from '@texra-ai/worldline/schemas';
import { withForkFailureReporting } from '@texra-ai/worldline/transcript';
import { CLI_OUTPUT_FORMATS } from '@texra/shared/cliOutputFormat';

// Local imports - CLI
import type { RunChatInit } from '@cli/chat/tui/runChatTui';
import {
  CliUsageError,
  provideCliInvocation,
  type CliContext,
  type CliGlobalArgs,
  type CliInvocation,
  readCliAmbientState,
  readCliVersion,
} from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import {
  makeCliProcessRuntime,
  type CliProcessRuntime,
  type CliServices,
} from '@cli/runtime/platform/cliProcessRuntime';
import type {
  CliPlatform,
  CliPlatformOptions,
} from '@cli/runtime/platform/initPlatform';
import {
  stderrDiagnosticSink,
  writeErrorStderr,
  writeTextStderr,
} from '@cli/runtime/platform/logSinks';

import { cliPresenterLayer } from './cliHelp';
import { loadConfigAndWarn } from './loadConfigAndWarn';

// ---------------------------------------------------------------------------
// The global flags: every command takes them, before or after its name.
// ---------------------------------------------------------------------------

/** A switch: off unless given, with no `--no-` form. */
export const boolFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withoutNegation,
    Flag.withDefault(false),
    Flag.withDescription(description),
  );

/**
 * The optional `--model/-m` flag the commands that launch an agent share. The
 * surface's own wording is the parameter: a session, a run or a task names what
 * the model is for.
 */
export const modelFlag = (description: string) =>
  Flag.String('model').pipe(
    Flag.withAlias('m'),
    Flag.withDescription(description),
    Flag.optional,
  );

const Print = GlobalFlag.Setting('print')({
  flag: boolFlag(
    'print',
    'For headless commands, run non-interactively and print the result to stdout',
  ).pipe(Flag.withAlias('p')),
});
const Quiet = GlobalFlag.Setting('quiet')({
  flag: boolFlag(
    'quiet',
    'Suppress progress output and informational logs',
  ).pipe(Flag.withAlias('q')),
});
const Verbose = GlobalFlag.Setting('verbose')({
  flag: boolFlag('verbose', 'Show debug-level diagnostics'),
});
const Cwd = GlobalFlag.Setting('cwd')({
  flag: Flag.String('cwd').pipe(
    Flag.withMetavar('directory'),
    Flag.withDescription('Project directory (defaults to $PWD)'),
    Flag.optional,
  ),
});
const OutputFormat = GlobalFlag.Setting('output-format')({
  flag: Flag.Literals('output-format', CLI_OUTPUT_FORMATS).pipe(
    Flag.withDescription('Output format for headless commands (default: text)'),
    Flag.optional,
  ),
});
const ApprovalPolicy = GlobalFlag.Setting('approval-policy')({
  flag: Flag.Literals('approval-policy', APPROVAL_POLICIES).pipe(
    Flag.withDescription(
      'Approval policy: never (Block), ask (Ask), or yolo (Auto-approve; default)',
    ),
    Flag.optional,
  ),
});
const Color = GlobalFlag.Setting('color')({
  flag: Flag.Boolean('color').pipe(
    Flag.withDefault(true),
    Flag.withDescription(
      'Colorize output (honors NO_COLOR / FORCE_COLOR; --no-color disables)',
    ),
  ),
});
const NoInput = GlobalFlag.Setting('no-input')({
  flag: boolFlag(
    'no-input',
    'For headless commands, never prompt (as --print does)',
  ),
});
/**
 * `--source/-s`, repeatable: the extra skill roots of the commands that load
 * skills. A command spreads it into its config; the context reads it.
 */
export const SKILL_SOURCES_CONFIG = {
  skillSources: Flag.String('source').pipe(
    Flag.withAlias('s'),
    Flag.withMetavar('directory'),
    Flag.withDescription(
      'Additional skill root; may be repeated and is resolved relative to --cwd',
    ),
    Flag.atLeast(0),
  ),
};

const skillSourcesOf = (input: unknown): readonly string[] =>
  Predicate.hasProperty(input, 'skillSources') &&
  Array.isArray(input.skillSources)
    ? input.skillSources
    : [];

/** The global flags, declared once on the root command. */
export const CLI_GLOBAL_FLAGS = [
  Print,
  Quiet,
  Verbose,
  Cwd,
  OutputFormat,
  ApprovalPolicy,
  Color,
  NoInput,
] as const;

/** The global flags as completion and the root's shortcuts read them. */
export const CLI_GLOBAL_FLAG_DESCRIPTORS = Completions.fromCommand(
  Command.make(
    'texra',
    Object.fromEntries(
      CLI_GLOBAL_FLAGS.map((setting) => [setting.id, setting.flag]),
    ),
  ),
).flags;

/** The global flags as the context reads them, with a command's skill
 *  roots. */
export const readCliGlobalArgs = Effect.fn('readCliGlobalArgs')(function* (
  skillSourcePaths: readonly string[] = [],
) {
  const cwd = Option.getOrUndefined(yield* Cwd);
  return {
    print: yield* Print,
    quiet: yield* Quiet,
    verbose: yield* Verbose,
    cwd: cwd !== undefined && cwd.trim() !== '' ? cwd : undefined,
    outputFormat: Option.getOrUndefined(yield* OutputFormat),
    approvalPolicy: Option.getOrUndefined(yield* ApprovalPolicy),
    noColor: !(yield* Color),
    noInput: yield* NoInput,
    skillSourcePaths,
  } satisfies CliGlobalArgs;
});

/** Commands that own the terminal refuse the headless-only flags. */
const INTERACTIVE_COMMAND_NAMES: readonly string[] = ['chat', 'setup'];

function rejectHeadlessOnlyFlags(
  globalArgs: CliGlobalArgs,
  commandName: string,
): Effect.Effect<void, CliUsageError> {
  const labels = [
    globalArgs.print === true ? '--print' : undefined,
    globalArgs.outputFormat !== undefined ? '--output-format' : undefined,
    globalArgs.noInput === true ? '--no-input' : undefined,
  ].filter((label) => label !== undefined);
  if (labels.length === 0) return Effect.void;
  return Effect.fail(
    new CliUsageError({
      message: `texra ${commandName} is interactive and does not support ${formatWordList(labels, 'and')}. For scripting, use \`texra run\` or a concrete non-interactive subcommand.`,
    }),
  );
}

// ---------------------------------------------------------------------------
// What a parsed command line runs: an exit code, or a command's launch.
// ---------------------------------------------------------------------------

/**
 * The command a parsed command line selected, run at the process edge after
 * the parse has finished: it builds the command's runtime, runs its program
 * there and disposes it, outside any fiber of the parse.
 */
type CliLaunch = () => Promise<number>;

/** Where a command's handler leaves its launch, or the exit code of a
 *  command that finished in the parse; the parse answers it. */
class CliSelection extends Context.Service<
  CliSelection,
  Ref.Ref<CliLaunch | number>
>()('@texra-ai/cli/CliSelection') {}

/** A command that finished in the parse ends the process with `code`. */
export const selectExitCode = (code: number) =>
  CliSelection.use((selection) => Ref.set(selection, code));

/**
 * What a command's program finishes with: nothing, which is success, the
 * process exit code, or the chat session it hands the terminal to. The TUI
 * is not part of the program: `runChat` installs Ink, its own SIGINT/SIGTERM
 * pair and the teardown it owns, so it mounts after the program has finished
 * rather than inside a fiber of the runtime it outlives.
 */
type CliCommandOutcome = number | void | { readonly chat: RunChatInit };

/** The services a command's runtime serves by default. */
type CliRuntimeServices = CliServices | CliPlatform;

/** A TeXRA leaf command. */
export interface CliCommandOptions<
  Config extends Command.Command.Config,
  E,
  R extends CliRuntimeServices = CliRuntimeServices,
> {
  readonly description: string;
  readonly config: Config;
  /** The command's own wording for a failure: a number writes the error to
   *  stderr and is the exit code; a function reports it and returns one. */
  readonly catchExitCode?: number | ((error: unknown) => number);
  /** Platform options for a command over the `--cwd` project. */
  readonly platform?: CliPlatformOptions;
  /** The layer a command that needs neither the platform nor every process
   *  service runs over instead; its program may read only what it serves. */
  readonly layer?: (context: CliContext) => Layer.Layer<R>;
  /**
   * The command as the program it is, given the context its global flags
   * built and its parsed flags and arguments. It is called before the
   * runtime is built: a refusal of the arguments that needs no runtime
   * throws `CliUsageError` here, so it opens nothing under the storage root.
   */
  readonly run: (
    context: CliContext,
    input: Command.Command.Config.Infer<Config>,
  ) => Effect.Effect<CliCommandOutcome, E, NoInfer<R> | CliInvocation>;
}

/**
 * Build the command's runtime, run `program` on it, mount the chat it names,
 * and dispose the runtime: the code it answers is the process exit code.
 * The command runs on its runtime from plain async code, never from inside
 * a default-runtime fiber: started from one, a headless run's Ctrl-C
 * shutdown drain never finished.
 */
async function launchCliCommand<E, R extends CliRuntimeServices>(
  context: CliContext,
  program: Effect.Effect<CliCommandOutcome, E, R>,
  options: Pick<
    CliCommandOptions<Command.Command.Config, E, R>,
    'catchExitCode' | 'platform' | 'layer'
  >,
): Promise<number> {
  const report = (cause: Cause.Cause<unknown>): number => {
    // Ctrl-C or SIGTERM: the platform's shutdown interrupted the command,
    // and its signal handler ends the process with the signal's code.
    if (Cause.hasInterruptsOnly(cause)) return CliExitCode.Interrupted;
    const error = Cause.squash(cause);
    // A usage error the program raises exits 2 like one the parse raises.
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return CliExitCode.Usage;
    }
    if (options.catchExitCode === undefined) throw error;
    if (typeof options.catchExitCode === 'function') {
      return options.catchExitCode(error);
    }
    writeErrorStderr(error);
    return options.catchExitCode;
  };
  // The command's diagnostic sink for its whole life, at the level the
  // context decided from argv (`--quiet`, `--verbose`). Only the chat
  // replaces it, while Ink owns the terminal.
  setLogSink(stderrDiagnosticSink(context.minimumLogLevel), { trusted: true });
  const { layer } = options;
  type Built =
    | { readonly chat: true; readonly runtime: CliProcessRuntime }
    | {
        readonly chat: false;
        readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
      };
  const built = Result.try({
    try: (): Built =>
      layer === undefined
        ? {
            chat: true,
            runtime: makeCliProcessRuntime(context, options.platform),
          }
        : {
            chat: false,
            runtime: withForkFailureReporting(
              ManagedRuntime.make(layer(context)),
            ),
          },
    catch: ensureError,
  });
  if (Result.isFailure(built)) return report(Cause.fail(built.failure));
  const { runtime } = built.success;
  try {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isFailure(exit)) return report(exit.cause);
    const outcome = exit.value;
    if (outcome === undefined) return CliExitCode.Success;
    if (typeof outcome === 'number') return outcome;
    // The TUI mounts here, after the program has finished, on the runtime
    // that program ran on: `runChat` owns Ink, its signals and its teardown.
    // A command over its own layer has no platform to chat on.
    if (!built.success.chat) return report(Cause.die(outcome));
    const { runChat } = await import('@cli/chat/tui/runChatTui');
    return (await runChat(built.success.runtime, context, outcome.chat))
      .exitCode;
  } finally {
    // The command's one shutdown: its platform's sessions and project, then
    // the process services, the usage log drained.
    await runtime.dispose();
  }
}

// ---------------------------------------------------------------------------
// A leaf command.
// ---------------------------------------------------------------------------

/**
 * A leaf command's handler: read the global flags, build the context
 * (printing the config warnings), build the program and leave its launch
 * for the process edge. Bare `texra` runs `chat`'s through this.
 */
export function selectCliCommand<
  const Config extends Command.Command.Config,
  E,
  R extends CliRuntimeServices,
>(name: string, options: CliCommandOptions<Config, E, R>) {
  const interactive = INTERACTIVE_COMMAND_NAMES.includes(name);
  return (input: Command.Command.Config.Infer<Config>) =>
    Effect.gen(function* () {
      const globalArgs = yield* readCliGlobalArgs(skillSourcesOf(input));
      if (interactive) yield* rejectHeadlessOnlyFlags(globalArgs, name);
      const context = yield* loadConfigAndWarn(globalArgs);
      const program = yield* Effect.sync(() =>
        options.run(context, input).pipe(provideCliInvocation(context)),
      ).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof CliUsageError
            ? Effect.fail(defect)
            : Effect.die(defect),
        ),
      );
      const selection = yield* CliSelection;
      yield* Ref.set(selection, () =>
        launchCliCommand(context, program, options),
      );
    });
}

/** A TeXRA leaf command, its handler {@link selectCliCommand}. */
export function cliCommand<
  const Name extends string,
  const Config extends Command.Command.Config,
  E,
  R extends CliRuntimeServices = CliRuntimeServices,
>(name: Name, options: CliCommandOptions<Config, E, R>) {
  return Command.make(
    name,
    options.config,
    selectCliCommand(name, options),
  ).pipe(Command.withDescription(options.description));
}

// ---------------------------------------------------------------------------
// The process entry.
// ---------------------------------------------------------------------------

/**
 * Parse `argv` against `command` and answer what it selected: the exit code
 * of a command line that ran nothing past the parse (help, a usage error,
 * completions, a command with no runtime), or the selected command's launch.
 */
const selectCommandLine = Effect.fn('selectCommandLine')(function* <
  Name extends string,
  I,
  CI,
  E,
>(
  command: Command.Command<Name, I, CI, E, CliSelection | Command.Environment>,
  argv: readonly string[],
) {
  const selection = yield* Ref.make<CliLaunch | number>(CliExitCode.Success);
  const colors =
    readCliAmbientState().stdoutColorEnabled === true &&
    !argv
      .slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length)
      .includes('--no-color');
  return yield* Command.runWith(command, { version: readCliVersion() })(
    argv,
  ).pipe(
    Effect.andThen(Ref.get(selection)),
    Effect.catch((error) => {
      // Help and the usage error are already printed: help is success, a
      // usage error exits 2.
      if (CliError.isCliError(error) && error._tag === 'ShowHelp') {
        return Effect.succeed(
          error.errors.length === 0 ? CliExitCode.Success : CliExitCode.Usage,
        );
      }
      if (error instanceof CliUsageError) {
        return Effect.sync(() => {
          writeTextStderr(error.message);
          return CliExitCode.Usage;
        });
      }
      return Effect.fail(error);
    }),
    Effect.provideService(CliSelection, selection),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        cliPresenterLayer(colors),
        // `--help` and `--version`; completion is `texra completion`'s and
        // the log level is `--quiet`/`--verbose`'s.
        CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      ),
    ),
  );
});

/**
 * One invocation of a TeXRA binary: parse `argv`, then run the command it
 * selected at this Promise edge, outside the parse's fiber, and answer the
 * exit code.
 */
export async function runCliCommandLine<Name extends string, I, CI, E>(
  command: Command.Command<Name, I, CI, E, CliSelection | Command.Environment>,
  argv: readonly string[],
): Promise<{ exitCode: number }> {
  const selected = await Effect.runPromise(selectCommandLine(command, argv));
  return {
    exitCode: typeof selected === 'number' ? selected : await selected(),
  };
}
