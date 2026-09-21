import { defineCommand, type ArgsDef, type CommandDef } from 'citty';

import {
  installCliProcessRuntime,
  NO_PLATFORM_INSTALL,
} from '@cli/runtime/cliProcessRuntime';
import {
  platformlessDiagnosticSink,
  writeErrorStderr,
} from '@cli/runtime/logSinks';
import type { ParsedGlobalArgs } from '@cli/runtime/globalArgs';
import type { CliContext } from '@cli/runtime/cliContext';
import { setLogSink, silentLogSink } from '@logger/logSink';
import type { ProcessServices } from '@platform/processRuntime';

import { contextFromArgs } from './context';
import { setExitCode } from './exitCode';
// Type-only: this file's one `catch` is the command boundary below, and a
// value import of `effect` would make it a raw catch in an effect importer.
import type { Effect } from 'effect';

// citty hands `run` a context whose `args` is keyed by the command's `ArgsDef`.
// We mirror that shape so handlers keep full literal-typed access to `ctx.args`
// and `ctx.rawArgs`, exactly as a hand-written `defineCommand` would.
type CliCommandRunContext<A extends ArgsDef> = Parameters<
  NonNullable<CommandDef<A>['run']>
>[0];

interface DefineCliCommandOptions<A extends ArgsDef, E> {
  readonly meta: CommandDef<A>['meta'];
  readonly args?: A;
  /**
   * Core handler. Receives the already-built `CliContext` (with config
   * warnings surfaced by `contextFromArgs`) and citty's run context, and
   * returns the command as the program it is: one Effect ending in the
   * process exit code, which this helper runs on the process runtime below.
   * The value it settles on is forwarded to `setExitCode`, so a handler
   * reduces to "do the work, return a code".
   *
   * It is called to BUILD that program, before the runtime is installed. A
   * command that refuses its arguments must therefore refuse HERE, in the
   * builder, by throwing `CliUsageError` (`texra clone`'s project parse,
   * `texra history`'s id and limit parses, `texra config edit`'s terminal
   * check, `texra login`'s transport check) — not by returning a program that
   * settles on an exit code. A returned program is run, and running one
   * installs a process runtime that only the platform shutdown disposes; a
   * command that refuses before it brings a platform up would leave the
   * global root's handle holding the event loop open past its own exit.
   */
  readonly run: (
    context: CliContext,
    ctx: CliCommandRunContext<A>,
  ) => Effect.Effect<number, E, ProcessServices>;
  /**
   * Set by the two commands that bring no platform up. Their program still
   * runs on a process runtime, but one installed with `NO_PLATFORM_INSTALL`:
   * a state store and a global-root handle that refuse, because neither
   * command runs the platform shutdown that would dispose an opened one.
   * Every other command omits it and takes the install that opens both.
   */
  readonly install?: 'noPlatform';
  /**
   * When set, the handler is wrapped in a try/catch that writes the error
   * message to stderr and assigns this exit code — replacing the per-command
   * `catch (error) { writeTextStderr(toErrorMessage(error)); setExitCode(...) }`
   * boilerplate. Omit it for commands that rely on `runCli`'s top-level
   * `CliUsageError` handling instead.
   */
  readonly catchExitCode?: number;
}

/**
 * Folds the `contextFromArgs` → install the process runtime → run the
 * command's program → `setExitCode` boilerplate (optionally with the
 * error→stderr+exit-code catch) that every headless command repeats into one
 * declaration.
 *
 * The runtime install and the run are this helper's, not each command's: a
 * command is one program on the process runtime, and this is the one place
 * the CLI enters it. `texra doctor` is the one command that cannot use this —
 * its report runs before the runtime exists and, when the platform init
 * fails, after that init has disposed the runtime it installed, so it has
 * none to borrow at either end.
 */
export function defineCliCommand<const A extends ArgsDef, E>(
  options: DefineCliCommandOptions<A, E>,
): CommandDef<A> {
  return defineCommand<A>({
    meta: options.meta,
    args: options.args,
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
      const exitCode = async (): Promise<number> => {
        const program = options.run(context, runCtx);
        if (options.install === 'noPlatform') {
          // The one sink these two entries ever get, chosen exactly as
          // `initCliPlatform` chooses one for every other command: no init
          // runs for them, and the console fallback it would have replaced
          // puts the runtime build's own DEBUG and INFO lines on stdout,
          // beside the command's result.
          setLogSink(
            context.quietLogs ? silentLogSink : platformlessDiagnosticSink,
            { trusted: true },
          );
        }
        const runtime = await installCliProcessRuntime(
          context.storageRoot,
          options.install === 'noPlatform' ? NO_PLATFORM_INSTALL : undefined,
        );
        return runtime.runPromise(program);
      };
      if (options.catchExitCode === undefined) {
        setExitCode(await exitCode());
        return;
      }
      try {
        setExitCode(await exitCode());
      } catch (error) {
        writeErrorStderr(error);
        setExitCode(options.catchExitCode);
      }
    },
  });
}
