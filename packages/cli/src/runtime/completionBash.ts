import {
  CLI_COMPLETION_SHELLS,
  commandKey,
  shellQuote,
  type CompletionCommand,
  type CompletionFlag,
} from './completionCommandTree';

function flagTokens(flags: readonly CompletionFlag[]): string[] {
  return flags.flatMap((flag) => [
    `--${flag.name}`,
    ...flag.aliases.map((alias) => `-${alias}`),
  ]);
}

function flagValueCases(commands: readonly CompletionCommand[]): string {
  const cases = new Map<string, string[]>();
  for (const command of commands) {
    for (const flag of command.flags) {
      if (flag.values.length === 0) continue;
      cases.set(`--${flag.name}`, [...flag.values]);
      for (const alias of flag.aliases) {
        cases.set(`-${alias}`, [...flag.values]);
      }
    }
  }
  return [...cases.entries()]
    .map(
      ([flag, values]) =>
        `${flag}) COMPREPLY=( $(compgen -W ${shellQuote(values.join(' '))} -- "$cur") ); return ;;`,
    )
    .join('\n    ');
}

function commandCaseBlock(command: CompletionCommand): string {
  const key = commandKey(command.path);
  const commands = command.subcommands.join(' ');
  const flags = flagTokens(command.flags).join(' ');
  return `${shellQuote(key)}) subcommands=${shellQuote(commands)}; flags=${shellQuote(flags)} ;;`;
}

function allCommandPaths(commands: readonly CompletionCommand[]): string[] {
  return commands
    .map((command) => commandKey(command.path))
    .filter((path) => path.length > 0);
}

export function bashCompletion(commands: readonly CompletionCommand[]): string {
  const rootCommands = commands.find((command) => command.path.length === 0);
  const valueCases = flagValueCases(commands);
  return `# bash completion for texra
_texra_completion_dynamic() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" != "0" ]]
}

_texra_agents() {
  _texra_completion_dynamic || return 0
  texra agents list --quiet 2>/dev/null | awk '{print $2}'
}

_texra_models() {
  _texra_completion_dynamic || return 0
  texra models list --quiet 2>/dev/null | awk '{print $1}'
}

_texra_completion_path() {
  local i=1 path="" token next
  while (( i < COMP_CWORD )); do
    token="\${COMP_WORDS[i]}"
    case "$token" in
      --output-format|--approval-policy|--api-mode|--cwd|--agent|--model|-m|--input|-i|--output|--instruction|--provider|--month|--login-hint)
        ((i+=2)); continue ;;
      --*=*|-*) ((i++)); continue ;;
    esac
    next="$token"
    [[ -n "$path" ]] && next="$path $token"
    case " ${allCommandPaths(commands).join(' ')} " in
      *" $next "*) path="$next"; ((i++)); continue ;;
    esac
    break
  done
  printf '%s' "$path"
}

_texra() {
  local cur prev path subcommands flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    ${valueCases}
    --model|-m) COMPREPLY=( $(compgen -W "$(_texra_models)" -- "$cur") ); return ;;
    --agent) COMPREPLY=( $(compgen -W "$(_texra_agents)" -- "$cur") ); return ;;
  esac

  path="$(_texra_completion_path)"
  case "$path" in
    ${commands.map(commandCaseBlock).join('\n    ')}
    *) subcommands='${rootCommands?.subcommands.join(' ') ?? ''}'; flags='' ;;
  esac

  if [[ "$path" == 'run' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W "$(_texra_agents)" -- "$cur") )
    return
  fi

  if [[ "$path" == 'completion' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W '${CLI_COMPLETION_SHELLS.join(' ')}' -- "$cur") )
    return
  fi

  if [[ "$path" == 'agents show' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W "$(_texra_agents)" -- "$cur") )
    return
  fi

  if [[ "$path" == 'models show' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W "$(_texra_models)" -- "$cur") )
    return
  fi

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$subcommands $flags" -- "$cur") )
  fi
}

complete -F _texra texra
`;
}
