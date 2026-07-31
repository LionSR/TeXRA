import { quote } from 'shell-quote';

import {
  CLI_COMPLETION_SHELLS,
  COMPLETION_SOURCES,
  commandKey,
  completionFlagVariants,
  completionSourceListing,
  type CompletionCommand,
  type CompletionFlag,
  type CompletionFlagVariant,
} from './completionCommandTree';

const { agents, models, toolUseAgents, workflowAgents } = COMPLETION_SOURCES;

const DYNAMIC_FLAG_VALUE_SOURCES: ReadonlyMap<string, string> = new Map([
  ['agent', toolUseAgents.shellFunction],
  ['model', models.shellFunction],
]);

function zshFlagValueSuffix(
  flag: CompletionFlag,
  variant: CompletionFlagVariant,
): string {
  if (variant.values.length > 0) return `: :(${variant.values.join(' ')})`;
  if (!variant.takesValue) return '';
  const dynamicSource = DYNAMIC_FLAG_VALUE_SOURCES.get(flag.name);
  if (dynamicSource) return `:${flag.name}:($(${dynamicSource}))`;
  return `:${variant.valueKind ?? 'value'}:`;
}

const POSITIONAL_SPECS: Readonly<Record<string, string>> = {
  completion: `1:shell:(${CLI_COMPLETION_SHELLS.join(' ')})`,
  run: `1:agent:($(${workflowAgents.shellFunction}))`,
  'agents show': `1:agent:($(${agents.shellFunction}))`,
  'agents run': `1:agent:($(${toolUseAgents.shellFunction}))`,
  'models show': `1:model:($(${models.shellFunction}))`,
};

function dynamicSourceFunctions(): string {
  return Object.values(COMPLETION_SOURCES)
    .map(
      (source) =>
        `${source.shellFunction}() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" == "0" ]] && return
  ${completionSourceListing(source)}
}`,
    )
    .join('\n\n');
}

function zshFlagSpec(flag: CompletionFlag): string[] {
  return completionFlagVariants(flag).flatMap((variant) => {
    const names = [
      `--${variant.name}`,
      ...variant.aliases.map((alias) => `-${alias}`),
    ];
    const suffix = zshFlagValueSuffix(flag, variant);
    return names.map((name) => `${name}[${variant.description}]${suffix}`);
  });
}

export function zshCompletion(commands: readonly CompletionCommand[]): string {
  const root = commands.find((command) => command.path.length === 0);
  const pathCases = commands
    .filter((command) => command.path.length > 0)
    .map((command) => {
      const key = commandKey(command.path);
      const subs = command.subcommands.length
        ? `_values 'subcommands' ${quote(command.subcommands)}`
        : 'true';
      const positionalSpec = POSITIONAL_SPECS[key];
      const specs = [
        ...command.flags.flatMap(zshFlagSpec),
        ...(positionalSpec ? [positionalSpec] : []),
      ];
      const args = specs.length ? `_arguments ${quote(specs)}` : 'true';
      return `${quote([key])}) ${subs}; ${args} ;;`;
    })
    .join('\n    ');
  const rootSpecs = [
    ...(root?.flags ?? []).flatMap(zshFlagSpec),
    `1:command:(${(root?.subcommands ?? []).join(' ')})`,
  ];
  return `#compdef texra

${dynamicSourceFunctions()}

_texra() {
  local path
  path="\${words[2]}"
  [[ -n "\${words[3]}" && "\${words[3]}" != -* ]] && path="$path \${words[3]}"

  case "$path" in
    ${pathCases}
    *) _arguments ${quote(rootSpecs)} ;;
  esac
}

_texra "$@"
`;
}
