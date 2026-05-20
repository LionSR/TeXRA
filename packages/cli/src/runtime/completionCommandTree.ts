// Type imports
import type { ArgDef, ArgsDef, CommandDef, CommandMeta } from 'citty';

export const CLI_COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CliCompletionShell = (typeof CLI_COMPLETION_SHELLS)[number];

export type AnyCommand = CommandDef<any>;

export interface CompletionCommand {
  readonly path: readonly string[];
  readonly description: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly CompletionFlag[];
  readonly positionals: readonly string[];
}

export interface CompletionFlag {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly takesValue: boolean;
  readonly values: readonly string[];
  readonly valueKind?: string;
}

function isCompletionShell(value: string): value is CliCompletionShell {
  return (CLI_COMPLETION_SHELLS as readonly string[]).includes(value);
}

export function parseCompletionShell(value: string): CliCompletionShell {
  if (isCompletionShell(value)) return value;
  throw new Error(
    `Unsupported shell: ${value}. Expected ${CLI_COMPLETION_SHELLS.join(', ')}.`,
  );
}

async function resolveValue<T>(value: T | Promise<T> | (() => T | Promise<T>)) {
  return typeof value === 'function'
    ? await (value as () => T | Promise<T>)()
    : await value;
}

function aliases(arg: ArgDef): string[] {
  if (!('alias' in arg) || arg.alias == null) return [];
  return Array.isArray(arg.alias) ? arg.alias : [arg.alias];
}

function argValues(arg: ArgDef): readonly string[] {
  return arg.type === 'enum' && Array.isArray(arg.options) ? arg.options : [];
}

function flagFromArg(name: string, arg: ArgDef): CompletionFlag | undefined {
  if (arg.type === 'positional') return undefined;
  return {
    name,
    aliases: aliases(arg),
    description: arg.description ?? '',
    takesValue: arg.type !== 'boolean',
    values: argValues(arg),
    valueKind: arg.valueHint,
  };
}

async function commandMeta(command: AnyCommand): Promise<CommandMeta> {
  return command.meta ? await resolveValue(command.meta) : {};
}

async function commandArgs(command: AnyCommand): Promise<ArgsDef> {
  return command.args ? await resolveValue(command.args) : {};
}

async function commandSubcommands(
  command: AnyCommand,
): Promise<Record<string, AnyCommand>> {
  const subcommands = command.subCommands
    ? await resolveValue(command.subCommands)
    : {};
  return Object.fromEntries(
    await Promise.all(
      Object.entries(subcommands).map(async ([name, subcommand]) => [
        name,
        await resolveValue(subcommand),
      ]),
    ),
  );
}

export async function collectCommands(
  command: AnyCommand,
  path: readonly string[] = [],
): Promise<CompletionCommand[]> {
  const [meta, args, subcommands] = await Promise.all([
    commandMeta(command),
    commandArgs(command),
    commandSubcommands(command),
  ]);
  const flags = Object.entries(args)
    .map(([name, arg]) => flagFromArg(name, arg))
    .filter((flag): flag is CompletionFlag => flag !== undefined);
  const positionals = Object.entries(args)
    .filter(([, arg]) => arg.type === 'positional')
    .map(([name]) => name);
  const current: CompletionCommand = {
    path,
    description: meta.description ?? '',
    subcommands: Object.keys(subcommands),
    flags,
    positionals,
  };
  const children = await Promise.all(
    Object.entries(subcommands).map(([name, child]) =>
      collectCommands(child, [...path, name]),
    ),
  );
  return [current, ...children.flat()];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandKey(path: readonly string[]): string {
  return path.join(' ');
}
