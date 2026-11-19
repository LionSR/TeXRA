import {
  defineCommand,
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
} from 'citty';
import { Effect, type Layer } from 'effect';

import type { CliServices } from '@cli/runtime/platform/cliProcessRuntime';
import type {
  CliPlatform,
  CliPlatformOptions,
} from '@cli/runtime/platform/initPlatform';
import {
  provideCliInvocation,
  type CliContext,
  type CliInvocation,
} from '@cli/runtime/platform/cliContext';

import { loadConfigAndWarn } from './loadConfigAndWarn';
import { setExitCode } from './exitCode';
import {
  launchCliCommand,
  type CliCommandOutcome,
} from './cliCommand';
import {
  GLOBAL_ARGS,
  INTERACTIVE_COMMAND_NAMES,
  pickGlobalArgs,
  INTERACTIVE_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './globalArgs';

// citty hands `run` a context whose `args` is keyed by the command's `ArgsDef`.
// We mirror that shape so handlers keep full literal-typed access to `ctx.args`
// and `ctx.rawArgs`, exactly as a hand-written `defineCommand` would.
type CliCommandRunContext<A extends ArgsDef> = Parameters<
  NonNullable<CommandDef<A>['run']>
>[0];

interface DefineCliCommandOptions<A extends ArgsDef, E, R, O> {
  readonly meta: CommandMeta & { readonly name: string };
  /**
   * The command's own arguments. The global flags come first, added here:
   * every command takes {@link GLOBAL_ARGS}, and an interactive one
   * ({@link INTERACTIVE_COMMAND_NAMES}) takes {@link INTERACTIVE_GLOBAL_ARGS}
   * and refuses the headless-only flags before anything is built.
   */
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
   * `CliInvocation`: one Effect ending in the process exit code, or in
   * nothing for success, which this helper runs on the command's runtime.
   * The value it finishes with is forwarded to `setExitCode`, so a handler
   * reduces to "do the work" — or, for a command that ends in the chat TUI,
   * "do the work, name the session", which this helper mounts once the
   * program has finished.
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
  options: DefineCliCommandOptions<A, E, NoInfer<R>, number | void> & {
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
  const { name } = options.meta;
  const interactive = INTERACTIVE_COMMAND_NAMES.includes(name);
  return defineCommand<A>({
    meta: options.meta,
    // The global flags parse too; a program reads them through
    // `loadConfigAndWarn`, never `ctx.args`.
    args: Object.assign(
      {},
      interactive ? INTERACTIVE_GLOBAL_ARGS : GLOBAL_ARGS,
      options.args,
    ),
    setup: interactive
      ? (ctx) => {
          rejectHeadlessOnlyFlags(ctx.rawArgs, name);
          return options.setup?.(ctx);
        }
      : options.setup,
    async run(ctx) {
      // A pre-runtime run: the context program opens the config stores
      // before the command's runtime exists.
      const context = await Effect.runPromise(
        loadConfigAndWarn(pickGlobalArgs(ctx.args, ctx.rawArgs)),
      );
      // Built before the run below, not inside it: a `CliUsageError` the
      // builder throws is the command refusing its arguments, which `runCli`
      // reports as a usage error, and `catchExitCode` speaks only for the
      // work. Building it here keeps that true for a command that does both.
      const program = options
        .run(context, ctx)
        .pipe(provideCliInvocation(context));
      setExitCode(await launchCliCommand(context, program, options));
    },
  });
}
