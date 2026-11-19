// Third-party imports
import {
  Cause,
  Context,
  Effect,
  Exit,
  type Layer,
  ManagedRuntime,
  Option,
  Ref,
  Result,
} from 'effect';
import { Command, Flag, GlobalFlag } from 'effect/cli';

// Local imports - harness and app
import { setLogSink } from '@texra-ai/harness/node';
import { APPROVAL_POLICIES, ensureError } from '@texra-ai/harness/schemas';
import { withForkFailureReporting } from '@texra-ai/harness/transcript';
import { CLI_OUTPUT_FORMATS } from '@texra/shared/cliOutputFormat';

// Local imports - CLI
import type { RunChatInit } from '@cli/chat/tui/runChatTui';
import {
  CliUsageError,
  provideCliInvocation,
  type CliContext,
  type CliGlobalArgs,
  type CliInvocation,
} from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import {
  makeCliProcessRuntime,
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

import { loadConfigAndWarn } from './loadConfigAndWarn';

// ---------------------------------------------------------------------------
// The global flags: every command takes them, before or after its name.
// ---------------------------------------------------------------------------

const boolFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withoutNegation,
    Flag.withDefault(false),
    Flag.withDescription(description),
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
  flag: boolFlag(
    'verbose',
    'Emit debug-level diagnostics (the terminal has no level filter of its own)',
  ),
});
const Cwd = GlobalFlag.Setting('cwd')({
  flag: Flag.String('cwd').pipe(
    Flag.withMetavar('directory'),
    Flag.withDescription('Directory the command works in (defaults to $PWD)'),
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
      'Privileged tool actions: never (deny all), ask (prompt; default), or yolo (auto-approve)',
    ),
    Flag.optional,
  ),
});
const Color = GlobalFlag.Setting('color')({
  flag: Flag.Boolean('color').pipe(
    Flag.withDefault(true),
    Flag.withDescription(
      'Emit ANSI color (also honors NO_COLOR / FORCE_COLOR / TERM); --no-color disables it on every stream',
    ),
  ),
});
const NoInput = GlobalFlag.Setting('no-input')({
  flag: boolFlag(
    'no-input',
    'For headless commands, disable prompts and default approvals to never',
  ),
});
const SkillSources = GlobalFlag.Setting('source')({
  flag: Flag.String('source').pipe(
    Flag.withAlias('s'),
    Flag.withMetavar('directory'),
    Flag.withDescription(
      'Additional skill root; may be repeated and is resolved relative to --cwd',
    ),
    Flag.atLeast(0),
  ),
});

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
  SkillSources,
] as const;

/** The global flags as the context reads them. */
export const readCliGlobalArgs = Effect.gen(function* () {
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
    skillSourcePaths: yield* SkillSources,
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
  const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    labels,
  );
  return Effect.fail(
    new CliUsageError({
      message: `texra ${commandName} is interactive and does not support ${list}. For scripting, use \`texra run\` or a concrete non-interactive subcommand.`,
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
export type CliLaunch = () => Promise<number>;

/** Where a command's handler leaves its launch; the parse answers it. */
export class CliSelection extends Context.Service<
  CliSelection,
  Ref.Ref<CliLaunch | undefined>
>()('@texra-ai/cli/CliSelection') {}

/**
 * What a command's program finishes with: nothing, which is success, the
 * process exit code, or the chat session it hands the terminal to. The TUI
 * is not part of the program: `runChat` installs Ink, its own SIGINT/SIGTERM
 * pair and the teardown it owns, so it mounts after the program has finished
 * rather than inside a fiber of the runtime it outlives.
 */
export type CliCommandOutcome = number | void | { readonly chat: RunChatInit };

/** How a command runs once its context is built. */
export interface CliLaunchOptions {
  /** The command's own wording for a failure: a number writes the error to
   *  stderr and is the exit code; a function reports it and returns one. */
  readonly catchExitCode?: number | ((error: unknown) => number);
  /** Platform options for a command over the `--cwd` project. */
  readonly platform?: CliPlatformOptions;
  /** The layer a command that needs neither the process services nor the
   *  platform runs over instead. */
  readonly layer?: (
    context: CliContext,
  ) => Layer.Layer<CliServices | CliPlatform>;
}

/**
 * Build the command's runtime, run `program` on it, mount the chat it names,
 * and dispose the runtime: the code it answers is the process exit code.
 * The command runs on its runtime from plain async code, never from inside
 * a default-runtime fiber: started from one, a headless run's Ctrl-C
 * shutdown drain never finished.
 */
export async function launchCliCommand<E>(
  context: CliContext,
  program: Effect.Effect<CliCommandOutcome, E, CliServices | CliPlatform>,
  options: CliLaunchOptions,
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
  const built = Result.try({
    try: () =>
      options.layer === undefined
        ? makeCliProcessRuntime(context, options.platform)
        : withForkFailureReporting(ManagedRuntime.make(options.layer(context))),
    catch: ensureError,
  });
  if (Result.isFailure(built)) return report(Cause.fail(built.failure));
  const runtime = built.success;
  try {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isFailure(exit)) return report(exit.cause);
    const outcome = exit.value;
    if (outcome === undefined) return CliExitCode.Success;
    if (typeof outcome === 'number') return outcome;
    // The TUI mounts here, after the program has finished, on the runtime
    // that program ran on: `runChat` owns Ink, its signals and its teardown.
    const { runChat } = await import('@cli/chat/tui/runChatTui');
    return (await runChat(runtime, context, outcome.chat)).exitCode;
  } finally {
    // The command's one shutdown: its platform's sessions and project, then
    // the process services, the usage log drained.
    await runtime.dispose();
  }
}

// ---------------------------------------------------------------------------
// A leaf command.
// ---------------------------------------------------------------------------

export interface CliCommandOptions<Config extends Command.Command.Config, E>
  extends CliLaunchOptions {
  readonly description: string;
  readonly config: Config;
  /**
   * The command as the program it is, given the context its global flags
   * built and its parsed flags and arguments. It is called before the
   * runtime is built: a refusal of the arguments that needs no runtime
   * throws `CliUsageError` here, so it opens nothing under the storage root.
   */
  readonly run: (
    context: CliContext,
    input: Command.Command.Config.Infer<Config>,
  ) => Effect.Effect<
    CliCommandOutcome,
    E,
    CliServices | CliPlatform | CliInvocation
  >;
}

/**
 * A leaf command's handler: read the global flags, build the context
 * (printing the config warnings), build the program and leave its launch
 * for the process edge. Bare `texra` runs `chat`'s through this.
 */
export function selectCliCommand<
  const Config extends Command.Command.Config,
  E,
>(name: string, options: CliCommandOptions<Config, E>) {
  const interactive = INTERACTIVE_COMMAND_NAMES.includes(name);
  return (input: Command.Command.Config.Infer<Config>) =>
    Effect.gen(function* () {
      const globalArgs = yield* readCliGlobalArgs;
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
>(name: Name, options: CliCommandOptions<Config, E>) {
  return Command.make(
    name,
    options.config,
    selectCliCommand(name, options),
  ).pipe(Command.withDescription(options.description));
}
