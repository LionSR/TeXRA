import { quote } from 'shell-quote';

import {
  CLI_COMPLETION_SHELLS,
  commandKey,
  completionFlagVariants,
  type CompletionCommand,
  type CompletionFlag,
  type CompletionFlagVariant,
} from './completionCommandTree';

const DYNAMIC_FLAG_VALUE_SOURCES: ReadonlyMap<string, string> = new Map([
  ['agent', '_texra_tool_use_agents'],
  ['model', '_texra_models'],
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
  run: `1:agent:($(_texra_workflow_agents))`,
  'agents show': `1:agent:($(_texra_agents))`,
  'agents run': `1:agent:($(_texra_tool_use_agents))`,
  'models show': `1:model:($(_texra_models))`,
};

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

_texra_agents() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" == "0" ]] && return
  texra agents list --quiet 2>/dev/null | awk '{print $2}'
}

_texra_workflow_agents() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" == "0" ]] && return
  texra agents list --quiet --all --category workflow 2>/dev/null | awk '{print $2}'
}

_texra_tool_use_agents() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" == "0" ]] && return
  texra agents list --quiet --all --category toolUse 2>/dev/null | awk '{print $2}'
}

_texra_models() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" == "0" ]] && return
  texra models list --quiet 2>/dev/null | awk '{print $1}'
}

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
