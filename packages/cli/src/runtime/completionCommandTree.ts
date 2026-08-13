// Type imports
import { AGENT_CATEGORIES, byCategory, type ByCategory } from '@shared/schemas';
import type { ArgDef, ArgsDef, CommandDef, CommandMeta } from 'citty';

export const CLI_COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CliCompletionShell = (typeof CLI_COMPLETION_SHELLS)[number];

export type AnyCommand = CommandDef<any>;

export interface CompletionCommand {
  readonly path: readonly string[];
  readonly description: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly CompletionFlag[];
}

export interface CompletionFlag {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly takesValue: boolean;
  readonly values: readonly string[];
  readonly valueKind?: string;
  readonly negatedName?: string;
  readonly negatedDescription?: string;
}

export type CompletionFlagVariant = Omit<
  CompletionFlag,
  'negatedName' | 'negatedDescription'
>;

function isCompletionShell(value: string): value is CliCompletionShell {
  return (CLI_COMPLETION_SHELLS as readonly string[]).includes(value);
}

export function parseCompletionShell(value: string): CliCompletionShell {
  if (isCompletionShell(value)) return value;
  throw new Error(
    `Unsupported shell: ${value}. Expected ${CLI_COMPLETION_SHELLS.join(', ')}.`,
  );
}

async function resolveValue<T>(
  value: T | Promise<T> | (() => T | Promise<T>),
): Promise<T> {
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

function isNegatableBoolean(arg: ArgDef): boolean {
  if (arg.type !== 'boolean') return false;
  // Booleans defaulting to `true` are passed via their negated form. Keep this
  // in step with the CLI flag router so a documented `--no-<name>` completes.
  return 'default' in arg && arg.default === true;
}

function negativeDescription(arg: ArgDef): string | undefined {
  if (!('negativeDescription' in arg)) return undefined;
  return typeof arg.negativeDescription === 'string'
    ? arg.negativeDescription
    : undefined;
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
    ...(isNegatableBoolean(arg)
      ? {
          negatedName: `no-${name}`,
          negatedDescription: negativeDescription(arg),
        }
      : {}),
  };
}

export function completionFlagVariants(
  flag: CompletionFlag,
): CompletionFlagVariant[] {
  const variants: CompletionFlagVariant[] = [
    {
      name: flag.name,
      aliases: flag.aliases,
      description: flag.description,
      takesValue: flag.takesValue,
      values: flag.values,
      valueKind: flag.valueKind,
    },
  ];
  if (flag.negatedName) {
    variants.push({
      name: flag.negatedName,
      aliases: [],
      description: flag.negatedDescription ?? flag.description,
      takesValue: false,
      values: [],
    });
  }
  return variants;
}

export function completionFlagTokens(flag: CompletionFlag): string[] {
  return completionFlagVariants(flag).flatMap((variant) => [
    `--${variant.name}`,
    ...variant.aliases.map((alias) => `-${alias}`),
  ]);
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
  const flags: CompletionFlag[] = [];
  for (const [name, arg] of Object.entries(args)) {
    const flag = flagFromArg(name, arg);
    if (flag !== undefined) flags.push(flag);
  }
  const current: CompletionCommand = {
    path,
    description: meta.description ?? '',
    subcommands: Object.keys(subcommands),
    flags,
  };
  const children = await Promise.all(
    Object.entries(subcommands).map(([name, child]) =>
      collectCommands(child, [...path, name]),
    ),
  );
  return [current, ...children.flat()];
}

export function commandKey(path: readonly string[]): string {
  return path.join(' ');
}

/**
 * A completable resource, read at completion time from a `texra` listing
 * command whose Nth whitespace column holds the value. Every shell generator
 * renders these into its own syntax, so a listing command or column only ever
 * changes here.
 */
export interface CompletionSource {
  /** Shell function name used by the generators that declare one (bash, zsh). */
  readonly shellFunction: string;
  readonly command: string;
  readonly column: number;
}

const COMPLETION_SOURCES = {
  agents: {
    shellFunction: '_texra_agents',
    command: 'agents list --quiet',
    column: 2,
  },
  models: {
    shellFunction: '_texra_models',
    command: 'models list --quiet',
    column: 1,
  },
} as const satisfies Record<string, CompletionSource>;

const AGENT_COMPLETION_SHELL_FUNCTIONS: ByCategory<string> = {
  workflow: '_texra_workflow_agents',
  toolUse: '_texra_tool_use_agents',
};

/** Per-category agent listing sources (roster-filtered `agents list`). */
const AGENT_COMPLETION_SOURCES: ByCategory<CompletionSource> = byCategory(
  (category) => ({
    shellFunction: AGENT_COMPLETION_SHELL_FUNCTIONS[category],
    command: `agents list --quiet --all --category ${category}`,
    column: 2,
  }),
);

/**
 * Positional completions backed by a dynamic listing source, keyed by the
 * space-joined command path whose Nth argument (e.g. `texra run <agent>`) is
 * completed against the source. Every shell generator renders this into its own
 * syntax, so a positional source only ever changes here.
 */
export const POSITIONAL_COMPLETION_SOURCES: Readonly<
  Record<string, CompletionSource>
> = {
  run: AGENT_COMPLETION_SOURCES.workflow,
  'agents run': AGENT_COMPLETION_SOURCES.toolUse,
  'agents show': COMPLETION_SOURCES.agents,
  'models show': COMPLETION_SOURCES.models,
};

/**
 * Dynamic flag-value completions, keyed by flag name. `--model`/`-m` and
 * `--agent` complete their value from a listing source; generators with a
 * dynamic-value mechanism (bash, zsh, fish) derive their flag cases from this,
 * so a new dynamic-value flag is not silently absent in one shell.
 */
export const DYNAMIC_VALUE_FLAG_SOURCES: Readonly<
  Record<string, CompletionSource>
> = {
  model: COMPLETION_SOURCES.models,
  agent: AGENT_COMPLETION_SOURCES.toolUse,
};

/** Every dynamic listing source, for the generators that emit each function. */
export function allCompletionSources(): CompletionSource[] {
  return [
    ...Object.values(COMPLETION_SOURCES),
    ...AGENT_CATEGORIES.map((category) => AGENT_COMPLETION_SOURCES[category]),
  ];
}

/** The listing pipeline a shell function body runs, shared by bash and zsh. */
export function completionSourceListing(source: CompletionSource): string {
  return `texra ${source.command} 2>/dev/null | awk '{print $${source.column}}'`;
}
