import { defineCommand, type ArgsDef, type CommandDef } from 'citty';
import {
  Cause,
  Effect,
  Exit,
  type Layer,
  ManagedRuntime,
  Result,
} from 'effect';

import { setLogSink } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';
import { withForkFailureReporting } from '@texra-ai/harness/transcript';
import {
  makeCliProcessRuntime,
  type CliServices,
} from '@cli/runtime/platform/cliProcessRuntime';
import type {
  CliPlatform,
  CliPlatformOptions,
} from '@cli/runtime/platform/initPlatform';
import {
  prePlatformDiagnosticSink,
  silentLogSink,
  writeErrorStderr,
} from '@cli/runtime/platform/logSinks';
import type { RunChatInit } from '@cli/chat/tui/runChatTui';
import {
  provideCliInvocation,
  type CliContext,
  type CliInvocation,
} from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';

import { loadConfigAndWarn } from './loadConfigAndWarn';
import { setExitCode } from './exitCode';

// citty hands `run` a context whose `args` is keyed by the command's `ArgsDef`.
// We mirror that shape so handlers keep full literal-typed access to `ctx.args`
// and `ctx.rawArgs`, exactly as a hand-written `defineCommand` would.
type CliCommandRunContext<A extends ArgsDef> = Parameters<
  NonNullable<CommandDef<A>['run']>
>[0];

/**
 * What a command's program finishes with: the process exit code, or the chat
 * session it hands the terminal to (`texra setup`'s setup agent, `texra
 * resume`'s tool-use session). The TUI is not part of the program: `runChat`
 * installs Ink, its own SIGINT/SIGTERM pair and the teardown it owns, so it
 * mounts after the program has finished rather than inside a fiber of the
 * runtime it outlives.
 */
type CliCommandOutcome = number | { readonly chat: RunChatInit };

interface DefineCliCommandOptions<A extends ArgsDef, E, R, O> {
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
   * warnings surfaced by `loadConfigAndWarn`) and citty's run context, and
   * returns the command as the program it is, run with that context as its
   * `CliInvocation`: one Effect ending in the
   * process exit code, which this helper runs on the command's runtime.
   * The value it finishes with is forwarded to `setExitCode`, so a handler
   * reduces to "do the work, return a code" — or, for a command that ends in
   * the chat TUI, "do the work, name the session", which this helper mounts
   * once the program has finished.
   *
   * It is called to BUILD that program, before the runtime is built. A
   * command that can refuse its arguments without the runtime refuses HERE,
   * in the builder, by throwing `CliUsageError` (`texra clone`'s project
   * parse, `texra history`'s id and limit parses, `texra config edit`'s
   * terminal check), so the refusal opens
   * nothing under the storage root. A usage error the program raises instead
   * still exits 2.
   */
  readonly run: (
    context: CliContext,
    ctx: CliCommandRunContext<A>,
  ) => Effect.Effect<O, E, R | CliInvocation>;
  /**
   * How this command reports a failure of its own — the program's, and the
   * runtime build that precedes it. A number writes the error message to
   * stderr and becomes the exit code, replacing the per-command
   * `catch (error) { writeTextStderr(toErrorMessage(error)); setExitCode(...) }`
   * boilerplate. A function reports the failure itself and returns the code,
   * which is what a command whose failures have their own wording needs: the
   * `models` group hands its `reportModelPlatformFailure` here, so a runtime
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
 * Combines the `loadConfigAndWarn` → build the command's runtime → run the
 * command's program → `setExitCode` → dispose the runtime boilerplate
 * (optionally with the error→stderr+exit-code catch) that every headless
 * command repeats into one declaration.
 *
 * The runtime and the run are this helper's, not each command's: a command
 * is one program on a runtime built for it, and this is the one place the
 * CLI enters it. A command over the `--cwd` project runs over the process
 * services and its {@link CliPlatform}, brought up with `platform` the first
 * time the program asks; one that needs neither names the `layer` it runs
 * over instead, so a read of what that layer lacks fails to type-check. One
 * command cannot use this: `texra doctor` reports a runtime that fails to
 * build, which leaves it nothing to run its report on.
 */
export function defineCliCommand<const A extends ArgsDef, E>(
  options: DefineCliCommandOptions<
    A,
    E,
    CliServices | CliPlatform,
    CliCommandOutcome
  > & { readonly platform?: CliPlatformOptions },
): CommandDef<A>;
export function defineCliCommand<const A extends ArgsDef, E, R>(
  options: DefineCliCommandOptions<A, E, NoInfer<R>, number> & {
    readonly layer: (context: CliContext) => Layer.Layer<R>;
  },
): CommandDef<A>;
export function defineCliCommand<const A extends ArgsDef, E>(
  options: DefineCliCommandOptions<
    A,
    E,
    CliServices | CliPlatform,
    CliCommandOutcome
  > & {
    readonly platform?: CliPlatformOptions;
    readonly layer?: (
      context: CliContext,
    ) => Layer.Layer<CliServices | CliPlatform>;
  },
): CommandDef<A> {
  function report(cause: Cause.Cause<unknown>): void {
    // Ctrl-C or SIGTERM: the platform's shutdown interrupted the command,
    // and its signal handler ends the process with the signal's code. That
    // is a cancel, not a crash for `bin/texra.ts` to report as a bug.
    if (Cause.hasInterruptsOnly(cause)) {
      setExitCode(CliExitCode.Interrupted);
      return;
    }
    const error = Cause.squash(cause);
    if (options.catchExitCode === undefined) throw error;
    if (typeof options.catchExitCode === 'function') {
      setExitCode(options.catchExitCode(error));
      return;
    }
    writeErrorStderr(error);
    setExitCode(options.catchExitCode);
  }

  return defineCommand<A>({
    meta: options.meta,
    args: options.args,
    setup: options.setup,
    async run(ctx) {
      // A pre-runtime run: the context program opens the config stores
      // before the command's runtime exists.
      const context = await Effect.runPromise(
        loadConfigAndWarn(ctx.args, ctx.rawArgs),
      );
      // Built before the run below, not inside it: a `CliUsageError` the
      // builder throws is the command refusing its arguments, which `runCli`
      // reports as a usage error, and `catchExitCode` speaks only for the
      // work. Building it here keeps that true for a command that does both.
      const program = options
        .run(context, ctx)
        .pipe(provideCliInvocation(context));
      // The sink that covers the runtime build below, chosen now that the
      // context has answered `--quiet`. The runtime logs while its layers
      // build (`UsageLogService started …`), and a command's platform sets
      // its own sink only once the program asks for it. `bin/texra.ts`
      // already put those lines on stderr; this is where `--quiet` can
      // still silence them, and for a command with no platform it is the
      // one sink it ever gets.
      setLogSink(
        context.quietLogs ? silentLogSink : prePlatformDiagnosticSink,
        { trusted: true },
      );
      // The command runs on its runtime from plain async code, never from
      // inside a default-runtime fiber: started from one, a headless run's
      // Ctrl-C shutdown drain never finished. A runtime that cannot be
      // built reaches the same report as a failed program.
      const built = Result.try({
        try: () =>
          options.layer === undefined
            ? makeCliProcessRuntime(context, options.platform)
            : withForkFailureReporting(
                ManagedRuntime.make(options.layer(context)),
              ),
        catch: ensureError,
      });
      if (Result.isFailure(built)) return report(Cause.fail(built.failure));
      const runtime = built.success;
      try {
        const exit = await runtime.runPromiseExit(program);
        if (Exit.isFailure(exit)) return report(exit.cause);
        const outcome = exit.value;
        if (typeof outcome === 'number') return setExitCode(outcome);
        // The TUI mounts at this Promise edge, after the program has
        // finished, on the runtime that program ran on: `runChat` owns Ink,
        // its own signal handlers and its teardown.
        const { runChat } = await import('@cli/chat/tui/runChatTui');
        setExitCode((await runChat(runtime, context, outcome.chat)).exitCode);
      } finally {
        // The command's one shutdown: its platform's sessions and project,
        // then the process services, the usage log drained.
        await runtime.dispose();
      }
    },
  });
}
