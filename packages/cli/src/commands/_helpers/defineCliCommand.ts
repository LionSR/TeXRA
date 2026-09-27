import { defineCommand, type ArgsDef, type CommandDef } from 'citty';
import { Cause, Exit, type Effect } from 'effect';

import {
  installCliProcessRuntime,
  NO_PLATFORM_INSTALL,
} from '@cli/runtime/cliProcessRuntime';
import {
  prePlatformDiagnosticSink,
  writeErrorStderr,
} from '@cli/runtime/logSinks';
import type { RunChatInit } from '@cli/chat/tui/runChatTui';
import type { ParsedGlobalArgs } from '@cli/runtime/globalArgs';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { setLogSink, silentLogSink } from '@logger/logSink';
import type { ProcessServices } from '@platform/processRuntime';

import { contextFromArgs } from './context';
import { setExitCode } from './exitCode';

// citty hands `run` a context whose `args` is keyed by the command's `ArgsDef`.
// We mirror that shape so handlers keep full literal-typed access to `ctx.args`
// and `ctx.rawArgs`, exactly as a hand-written `defineCommand` would.
type CliCommandRunContext<A extends ArgsDef> = Parameters<
  NonNullable<CommandDef<A>['run']>
>[0];

/**
 * What a command's program settles on: the process exit code, or the chat
 * session it hands the terminal to (`texra setup`'s setup agent, `texra
 * resume`'s tool-use session). The TUI is not part of the program: `runChat`
 * installs Ink, its own SIGINT/SIGTERM pair and the teardown it owns, so it
 * mounts after the program has settled rather than inside a fiber of the
 * runtime it outlives.
 */
type CliCommandOutcome = number | { readonly chat: RunChatInit };

interface DefineCliCommandOptions<A extends ArgsDef, E> {
  readonly meta: CommandDef<A>['meta'];
  readonly args?: A;
  /**
   * citty's `setup`, which runs before `run`: an argv refusal that must
   * precede the context build (and the config warnings it prints) throws
   * `CliUsageError` here.
   */
  readonly setup?: CommandDef<A>['setup'];
  /**
   * Core handler. Receives the already-built `CliContext` (with config
   * warnings surfaced by `contextFromArgs`) and citty's run context, and
   * returns the command as the program it is: one Effect ending in the
   * process exit code, which this helper runs on the process runtime below.
   * The value it settles on is forwarded to `setExitCode`, so a handler
   * reduces to "do the work, return a code" — or, for a command that ends in
   * the chat TUI, "do the work, name the session", which this helper mounts
   * once the program has settled.
   *
   * It is called to BUILD that program, before the runtime is installed. A
   * command that can refuse its arguments without the runtime refuses HERE,
   * in the builder, by throwing `CliUsageError` (`texra clone`'s project
   * parse, `texra history`'s id and limit parses, `texra config edit`'s
   * terminal check, `texra login`'s transport check), so the refusal opens
   * nothing under the storage root. A usage error the program raises instead
   * still exits 2: the process entry disposes whatever runtime is installed.
   */
  readonly run: (
    context: CliContext,
    ctx: CliCommandRunContext<A>,
  ) => Effect.Effect<CliCommandOutcome, E, ProcessServices>;
  /**
   * Set by the two commands that bring no platform up. Their program still
   * runs on a process runtime, but one installed with `NO_PLATFORM_INSTALL`:
   * a state store and a global-root handle that refuse, because neither
   * command runs the platform shutdown that would dispose an opened one.
   * Every other command omits it and takes the install that opens both.
   */
  readonly install?: 'noPlatform';
  /**
   * How this command reports a failure of its own — the program's, and the
   * runtime install that precedes it. A number writes the error message to
   * stderr and becomes the exit code, replacing the per-command
   * `catch (error) { writeTextStderr(toErrorMessage(error)); setExitCode(...) }`
   * boilerplate. A function reports the failure itself and returns the code,
   * which is what a command whose failures have their own wording needs: the
   * `models` group hands its `reportModelPlatformFailure` here, so an install
   * that cannot open the storage root still reads as "could not list models"
   * rather than as a TeXRA crash.
   *
   * It speaks for the work only. A `CliUsageError` the builder above throws
   * is raised before this report exists, so a command can both refuse its
   * arguments as a usage error and report a failed run with its own code.
   */
  readonly catchExitCode?: number | ((error: unknown) => number);
}

/**
 * Folds the `contextFromArgs` → install the process runtime → run the
 * command's program → `setExitCode` boilerplate (optionally with the
 * error→stderr+exit-code catch) that every headless command repeats into one
 * declaration.
 *
 * The runtime install and the run are this helper's, not each command's: a
 * command is one program on the process runtime, and this is the one place
 * the CLI enters it. Two commands cannot use this. `texra doctor`'s report
 * runs before the runtime exists and, when the platform init fails, after
 * that init has disposed the runtime it installed, so it has none to borrow
 * at either end. `texra chat` refuses an unusable terminal and skips its
 * update check before anything installs a runtime, which this helper does
 * before the program starts.
 */
export function defineCliCommand<const A extends ArgsDef, E>(
  options: DefineCliCommandOptions<A, E>,
): CommandDef<A> {
  return defineCommand<A>({
    meta: options.meta,
    args: options.args,
    setup: options.setup,
    async run(ctx) {
      // citty's `ctx.args` for a generic `ArgsDef` widens past the precise
      // `ParsedGlobalArgs` shape; every command that uses this helper spreads
      // `GLOBAL_ARGS`, overriding individual entries such as `cwd` only when
      // it needs command-specific help text.
      const context = await contextFromArgs(
        ctx.args as ParsedGlobalArgs,
        ctx.rawArgs,
      );
      const runCtx = ctx as CliCommandRunContext<A>;
      // Built before the run below, not inside it: a `CliUsageError` the
      // builder throws is the command refusing its arguments, which `runCli`
      // reports as a usage error, and `catchExitCode` speaks only for the
      // work. Building it here keeps that true for a command that does both.
      const program = options.run(context, runCtx);
      // The sink that covers the runtime build below, chosen now that the
      // context has answered `--quiet`. `installCliProcessRuntime` logs
      // while its layers build (`UsageLogService started …`), and for a
      // command that brings a platform up `initCliPlatform`'s own
      // `setLogSink` runs one step later — inside the program this builds
      // the runtime for. `bin/texra.ts` already put those lines on stderr;
      // this is where `--quiet` can still silence them, and for the two
      // platform-less entries it is the one sink they ever get.
      setLogSink(
        context.quietLogs ? silentLogSink : prePlatformDiagnosticSink,
        { trusted: true },
      );
      // The command runs on the process runtime from plain async code, never
      // from inside a default-runtime fiber: started from one, a headless
      // run's Ctrl-C shutdown drain never settled. A failed install folds
      // into the same exit as a failed program, so both reach one report.
      const exit = await installCliProcessRuntime(
        context.storageRoot,
        options.install === 'noPlatform'
          ? { ...NO_PLATFORM_INSTALL, minimumLogLevel: context.minimumLogLevel }
          : {
              resourcesPath: context.resourcesPath,
              minimumLogLevel: context.minimumLogLevel,
            },
      ).then(
        (runtime) => runtime.runPromiseExit(program),
        (error: unknown) => Exit.fail(error),
      );
      if (Exit.isSuccess(exit)) {
        const outcome = exit.value;
        if (typeof outcome === 'number') {
          setExitCode(outcome);
          return;
        }
        // The TUI mounts at this Promise edge, after the program has settled:
        // `runChat` is the interactive host entry and owns Ink, its own signal
        // handlers and its teardown.
        const { runChat } = await import('@cli/chat/tui/runChatTui');
        setExitCode((await runChat(context, outcome.chat)).exitCode);
        return;
      }
      // Ctrl-C or SIGTERM: the platform's shutdown interrupted the command,
      // and its signal handler ends the process with the signal's code. That
      // is a cancel, not a crash for `bin/texra.ts` to report as a bug.
      if (Cause.hasInterruptsOnly(exit.cause)) {
        setExitCode(CliExitCode.Interrupted);
        return;
      }
      const error = Cause.squash(exit.cause);
      if (options.catchExitCode === undefined) throw error;
      if (typeof options.catchExitCode === 'function') {
        setExitCode(options.catchExitCode(error));
        return;
      }
      writeErrorStderr(error);
      setExitCode(options.catchExitCode);
    },
  });
}
