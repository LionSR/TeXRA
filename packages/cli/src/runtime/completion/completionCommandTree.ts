// Third-party imports
import { Command, Completions } from 'effect/cli';

// Local imports - CLI
import { CLI_GLOBAL_FLAG_DESCRIPTORS } from '@cli/commands/_helpers/cliCommand';

export const CLI_COMPLETION_SHELLS = Object.freeze([
  'bash',
  'zsh',
  'fish',
] as const);
export type CliCompletionShell = (typeof CLI_COMPLETION_SHELLS)[number];

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
}

export type CompletionFlagVariant = Omit<CompletionFlag, 'negatedName'>;

/**
 * Flags whose value is a path, keyed by flag name: the shells complete
 * files or directories for them. effect/cli's path flags resolve against
 * the process directory and require the path, where TeXRA resolves against
 * `--cwd` and reads `-` as stdin, so these flags stay strings.
 */
const PATH_VALUE_FLAGS: Readonly<Record<string, 'file' | 'directory'>> =
  Object.freeze({
    cwd: 'directory',
    source: 'directory',
    input: 'file',
    context: 'file',
    output: 'file',
    'output-dir': 'directory',
    'instruction-file': 'file',
  });

function completionFlag(flag: Completions.FlagDescriptor): CompletionFlag {
  const takesValue = flag.type._tag !== 'Boolean';
  const negation =
    flag.type._tag === 'Boolean' && typeof flag.negation === 'string'
      ? flag.negation
      : undefined;
  return {
    name: flag.name,
    aliases: flag.aliases,
    description: flag.description ?? '',
    takesValue,
    values: flag.type._tag === 'Choice' ? flag.type.values : [],
    valueKind: PATH_VALUE_FLAGS[flag.name],
    ...(negation === undefined ? {} : { negatedName: negation }),
  };
}

export function completionFlagVariants(
  flag: CompletionFlag,
): CompletionFlagVariant[] {
  const { negatedName, ...variant } = flag;
  if (negatedName === undefined) return [variant];
  return [
    variant,
    {
      name: negatedName,
      aliases: [],
      description: flag.description,
      takesValue: false,
      values: [],
    },
  ];
}

export function completionFlagTokens(flag: CompletionFlag): string[] {
  return completionFlagVariants(flag).flatMap((variant) => [
    `--${variant.name}`,
    ...variant.aliases.map((alias) => `-${alias}`),
  ]);
}

const GLOBAL_COMPLETION_FLAGS = CLI_GLOBAL_FLAG_DESCRIPTORS.map(completionFlag);

/** Every command of the tree, root first, each with the global flags. */
export function collectCommands(
  root: Command.Command.Any,
): CompletionCommand[] {
  const walk = (
    descriptor: Completions.CommandDescriptor,
    path: readonly string[],
  ): CompletionCommand[] => [
    {
      path,
      description: descriptor.description ?? '',
      subcommands: descriptor.subcommands.map((child) => child.name),
      flags: [
        ...descriptor.flags.map(completionFlag),
        ...GLOBAL_COMPLETION_FLAGS,
      ],
    },
    ...descriptor.subcommands.flatMap((child) =>
      walk(child, [...path, child.name]),
    ),
  ];
  return walk(Completions.fromCommand(root), []);
}

export function commandKey(path: readonly string[]): string {
  return path.join(' ');
}

/**
 * A completable resource, read at completion time from a `texra` listing
 * command whose first whitespace column holds the value. Every shell generator
 * renders these into its own syntax, so a listing command only ever changes
 * here.
 */
export interface CompletionSource {
  /** Shell function name used by the generators that declare one (bash, zsh). */
  readonly shellFunction: string;
  readonly command: string;
}

const COMPLETION_SOURCES = {
  agents: {
    shellFunction: '_texra_agents',
    command: 'agents list --quiet',
  },
  /**
   * Every launchable agent, hidden ones included. The name column prints the
   * source-qualified key for a name two listed agents share, so a collision
   * completes to a spelling that names exactly one agent.
   */
  launchableAgents: {
    shellFunction: '_texra_launchable_agents',
    command: 'agents list --quiet --all',
  },
  models: {
    shellFunction: '_texra_models',
    command: 'models list --quiet',
  },
} as const satisfies Record<string, CompletionSource>;

/**
 * Positional completions backed by a dynamic listing source, keyed by the
 * space-joined command path whose Nth argument (e.g. `texra run <agent>`) is
 * completed against the source. Every shell generator renders this into its own
 * syntax, so a positional source only ever changes here.
 */
export const POSITIONAL_COMPLETION_SOURCES: Readonly<
  Record<string, CompletionSource>
> = Object.freeze({
  run: COMPLETION_SOURCES.launchableAgents,
  'agents show': COMPLETION_SOURCES.agents,
  'agents customize': COMPLETION_SOURCES.launchableAgents,
  'agents reset': COMPLETION_SOURCES.agents,
  'agents keep': COMPLETION_SOURCES.agents,
  'models show': COMPLETION_SOURCES.models,
});

/**
 * Dynamic flag-value completions, keyed by flag name. `--model`/`-m` and
 * `--agent` complete their value from a listing source; generators with a
 * dynamic-value mechanism (bash, zsh, fish) derive their flag cases from this,
 * so a new dynamic-value flag is not silently absent in one shell.
 */
export const DYNAMIC_VALUE_FLAG_SOURCES: Readonly<
  Record<string, CompletionSource>
> = Object.freeze({
  model: COMPLETION_SOURCES.models,
  agent: COMPLETION_SOURCES.launchableAgents,
});

/** Every dynamic listing source, for the generators that emit each function. */
export function allCompletionSources(): CompletionSource[] {
  return Object.values(COMPLETION_SOURCES);
}

/** The listing pipeline a shell function body runs, shared by bash and zsh. */
export function completionSourceListing(source: CompletionSource): string {
  return `texra ${source.command} 2>/dev/null | awk '{print $1}'`;
}
