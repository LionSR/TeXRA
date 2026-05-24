import {
  CLI_COMPLETION_SHELLS,
  commandKey,
  shellQuote,
  type CompletionCommand,
  type CompletionFlag,
} from './completionCommandTree';

function zshFlagSpec(flag: CompletionFlag): string[] {
  const names = [`--${flag.name}`, ...flag.aliases.map((alias) => `-${alias}`)];
  const suffix =
    flag.values.length > 0
      ? `: :(${flag.values.join(' ')})`
      : flag.takesValue
        ? `:${flag.valueKind ?? 'value'}:`
        : '';
  return names.map((name) => `${name}[${flag.description}]${suffix}`);
}

export function zshCompletion(commands: readonly CompletionCommand[]): string {
  const root = commands.find((command) => command.path.length === 0);
  const pathCases = commands
    .filter((command) => command.path.length > 0)
    .map((command) => {
      const key = commandKey(command.path);
      const subs = command.subcommands.length
        ? `_values 'subcommands' ${command.subcommands.map(shellQuote).join(' ')}`
        : 'true';
      const specs = [
        ...command.flags.flatMap(zshFlagSpec),
        ...(key === 'completion'
          ? [`1:shell:(${CLI_COMPLETION_SHELLS.join(' ')})`]
          : []),
        ...(key === 'run' ? [`1:agent:($(_texra_agents))`] : []),
        ...(key === 'agents show' ? [`1:agent:($(_texra_agents))`] : []),
        ...(key === 'models show' ? [`1:model:($(_texra_models))`] : []),
      ];
      const args = specs.length
        ? `_arguments ${specs.map(shellQuote).join(' ')}`
        : 'true';
      return `${shellQuote(key)}) ${subs}; ${args} ;;`;
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
    *) _arguments ${rootSpecs.map(shellQuote).join(' ')} ;;
  esac
}

_texra "$@"
`;
}
