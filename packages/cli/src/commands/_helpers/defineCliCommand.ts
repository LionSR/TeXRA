import { defineCommand, type ArgsDef, type CommandDef } from 'citty';

import { writeErrorStderr } from '@cli/runtime/logSinks';
import type { ParsedGlobalArgs } from '@cli/runtime/globalArgs';

import type { CliContext } from '@cli/runtime/cliContext';

import { contextFromArgs } from './context';
import { setExitCode } from './exitCode';

// citty hands `run` a context whose `args` is keyed by the command's `ArgsDef`.
// We mirror that shape so handlers keep full literal-typed access to `ctx.args`
// and `ctx.rawArgs`, exactly as a hand-written `defineCommand` would.
type CliCommandRunContext<A extends ArgsDef> = Parameters<
  NonNullable<CommandDef<A>['run']>
>[0];

export interface DefineCliCommandOptions<A extends ArgsDef> {
  readonly meta: CommandDef<A>['meta'];
  readonly args?: A;
  /**
   * Core handler. Receives the already-built `CliContext` (with config
   * warnings surfaced by `contextFromArgs`) and citty's run context, and
   * returns the process exit code. The return value is forwarded to
   * `setExitCode`, so a handler reduces to "do the work, return a code".
   */
  readonly run: (
    context: CliContext,
    ctx: CliCommandRunContext<A>,
  ) => Promise<number>;
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
 * Folds the `contextFromArgs` → `setExitCode(await handler(...))` boilerplate
 * (optionally with the error→stderr+exit-code catch) that every headless
 * command repeats into one declaration. Behavior is identical to the manual
 * form; only the scaffolding moves here.
 */
export function defineCliCommand<const A extends ArgsDef>(
  options: DefineCliCommandOptions<A>,
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
      if (options.catchExitCode === undefined) {
        setExitCode(await options.run(context, runCtx));
        return;
      }
      try {
        setExitCode(await options.run(context, runCtx));
      } catch (error) {
        writeErrorStderr(error);
        setExitCode(options.catchExitCode);
      }
    },
  });
}
