import type { ArgsDef, CommandDef, CommandMeta } from 'citty';

// Citty's `CommandDef<T>` is invariant in `T` (T appears in both `run` and
// `setup` parameters), so a narrower const-inferred command isn't assignable
// to the parent type. We treat the subcommand tree as `CommandDef<any>` while
// walking it; this matches citty's own `subCommands` shape and lets
// `showUsage` accept either width via cast at the call site.
export type AnyCommand = CommandDef<any>;

export interface ResolvedCliCommand {
  readonly command: AnyCommand;
  readonly parent?: AnyCommand;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly rootCommand: AnyCommand;
}

export async function resolveCommandMeta(
  cmd: AnyCommand,
): Promise<CommandMeta> {
  const meta = cmd.meta;
  if (meta == null) return {};
  return typeof meta === 'function' ? await meta() : await meta;
}

export async function commandSubCommands(
  cmd: AnyCommand,
): Promise<Record<string, AnyCommand> | undefined> {
  const rawSubs = cmd.subCommands;
  if (!rawSubs) return undefined;
  return typeof rawSubs === 'function'
    ? await (rawSubs as () => Promise<Record<string, AnyCommand>>)()
    : ((await rawSubs) as Record<string, AnyCommand>);
}

export async function commandArgs(cmd: AnyCommand): Promise<ArgsDef> {
  const rawArgs = cmd.args;
  if (!rawArgs) return {};
  return typeof rawArgs === 'function'
    ? await (rawArgs as () => Promise<ArgsDef> | ArgsDef)()
    : ((await rawArgs) as ArgsDef);
}

/**
 * Walk `rawArgs` positional-by-positional through the subcommand tree to find
 * the deepest matched command. Used to scope `--help` to the subcommand the
 * user typed rather than always showing root-level usage.
 *
 * Stops at the first positional that doesn't match a child subcommand. Returns
 * the matched command, immediate parent, and the full command path so usage can
 * render `texra multi-agent run` rather than citty's immediate-parent fallback
 * of `multi-agent run`.
 */
export async function resolveDeepestSubCommand(
  cmd: AnyCommand,
  rawArgs: readonly string[],
): Promise<ResolvedCliCommand> {
  return resolveDeepestSubCommandPath({
    cmd,
    rawArgs,
    commandPath: ['texra'],
    parentPath: [],
    rootCommand: cmd,
  });
}

interface ResolveDeepestSubCommandPathInput {
  readonly cmd: AnyCommand;
  readonly rawArgs: readonly string[];
  readonly parent?: AnyCommand;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly rootCommand: AnyCommand;
}

async function resolveDeepestSubCommandPath({
  cmd,
  rawArgs,
  parent,
  commandPath,
  parentPath,
  rootCommand,
}: ResolveDeepestSubCommandPathInput): Promise<ResolvedCliCommand> {
  const subCommands = await commandSubCommands(cmd);
  if (!subCommands) {
    return { command: cmd, parent, commandPath, parentPath, rootCommand };
  }
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === undefined) break;
    if (token.startsWith('-')) continue;
    const next = subCommands[token];
    if (next) {
      return resolveDeepestSubCommandPath({
        cmd: next,
        rawArgs: rawArgs.slice(i + 1),
        parent: cmd,
        commandPath: [...commandPath, token],
        parentPath: commandPath,
        rootCommand,
      });
    }
    break;
  }
  return { command: cmd, parent, commandPath, parentPath, rootCommand };
}
