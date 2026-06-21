import { quote } from 'shell-quote';

import {
  CLI_COMPLETION_SHELLS,
  commandKey,
  completionFlagTokens,
  completionFlagVariants,
  type CompletionCommand,
  type CompletionFlag,
} from './completionCommandTree';

interface FlagValueTokenEntry {
  readonly flag: CompletionFlag;
  readonly token: string;
}

function flagValueTokenEntries(
  commands: readonly CompletionCommand[],
): FlagValueTokenEntry[] {
  const seen = new Set<string>();
  const entries: FlagValueTokenEntry[] = [];
  for (const command of commands) {
    for (const flag of command.flags) {
      if (!flag.takesValue) continue;
      for (const token of completionFlagTokens(flag)) {
        if (seen.has(token)) continue;
        seen.add(token);
        entries.push({ flag, token });
      }
    }
  }
  return entries;
}

function fixedFlagValueCases(commands: readonly CompletionCommand[]): string {
  const cases = new Map<string, string[]>();
  for (const command of commands) {
    for (const flag of command.flags) {
      for (const variant of completionFlagVariants(flag)) {
        if (variant.values.length === 0) continue;
        cases.set(`--${variant.name}`, [...variant.values]);
        for (const alias of variant.aliases) {
          cases.set(`-${alias}`, [...variant.values]);
        }
      }
    }
  }
  return [...cases.entries()]
    .map(
      ([flag, values]) =>
        `${flag}) COMPREPLY=( $(compgen -W ${quote([values.join(' ')])} -- "$cur") ); return ;;`,
    )
    .join('\n    ');
}

const DYNAMIC_VALUE_FLAG_CASES = [
  { tokens: ['--model', '-m'], source: '_texra_models' },
  { tokens: ['--agent'], source: '_texra_tool_use_agents' },
] as const;

function dynamicFlagValueCases(): string {
  return DYNAMIC_VALUE_FLAG_CASES.map(
    (flagCase) =>
      `${flagCase.tokens.join('|')}) COMPREPLY=( $(compgen -W "$(${flagCase.source})" -- "$cur") ); return ;;`,
  ).join('\n    ');
}

function genericFlagValueCases(commands: readonly CompletionCommand[]): string {
  const fixedValueFlags = new Set(
    commands.flatMap((command) =>
      command.flags
        .filter((flag) => flag.values.length > 0)
        .flatMap(completionFlagTokens),
    ),
  );
  const dynamicValueFlags = new Set<string>(
    DYNAMIC_VALUE_FLAG_CASES.flatMap((flagCase) => flagCase.tokens),
  );
  const fileFlags: string[] = [];
  const directoryFlags: string[] = [];
  const genericFlags: string[] = [];

  for (const { flag, token } of flagValueTokenEntries(commands)) {
    if (fixedValueFlags.has(token) || dynamicValueFlags.has(token)) continue;
    if (flag.valueKind === 'directory' || flag.valueKind === 'dir') {
      directoryFlags.push(token);
    } else if (flag.valueKind === 'file' || flag.valueKind === 'path') {
      fileFlags.push(token);
    } else {
      genericFlags.push(token);
    }
  }

  const cases: string[] = [];
  if (fileFlags.length > 0) {
    cases.push(
      `${fileFlags.join('|')}) _texra_compgen_files "$cur"; return ;;`,
    );
  }
  if (directoryFlags.length > 0) {
    cases.push(
      `${directoryFlags.join('|')}) _texra_compgen_dirs "$cur"; return ;;`,
    );
  }
  if (genericFlags.length > 0) {
    cases.push(`${genericFlags.join('|')}) COMPREPLY=(); return ;;`);
  }
  return cases.join('\n    ');
}

function commandCaseBlock(command: CompletionCommand): string {
  const key = commandKey(command.path);
  const commands = command.subcommands.join(' ');
  const flags = command.flags.flatMap(completionFlagTokens).join(' ');
  return `${quote([key])}) subcommands=${quote([commands])}; flags=${quote([flags])} ;;`;
}

export function bashCompletion(commands: readonly CompletionCommand[]): string {
  const root = commands.find((command) => command.path.length === 0);
  const fixedValueCases = fixedFlagValueCases(commands);
  const dynamicValueCases = dynamicFlagValueCases();
  const genericValueCases = genericFlagValueCases(commands);
  const valueFlagPattern =
    flagValueTokenEntries(commands)
      .map((entry) => entry.token)
      .join('|') || '--_texra_no_value_flags_';
  const allCommandPaths = commands
    .map((command) => commandKey(command.path))
    .filter((path) => path.length > 0);
  return `# bash completion for texra
_texra_completion_dynamic() {
  [[ "\${TEXRA_COMPLETION_DYNAMIC:-1}" != "0" ]]
}

_texra_agents() {
  _texra_completion_dynamic || return 0
  texra agents list --quiet 2>/dev/null | awk '{print $2}'
}

_texra_workflow_agents() {
  _texra_completion_dynamic || return 0
  texra agents list --quiet --category workflow 2>/dev/null | awk '{print $2}'
}

_texra_tool_use_agents() {
  _texra_completion_dynamic || return 0
  texra agents list --quiet --category toolUse 2>/dev/null | awk '{print $2}'
}

_texra_models() {
  _texra_completion_dynamic || return 0
  texra models list --quiet 2>/dev/null | awk '{print $1}'
}

_texra_compgen_files() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(compgen -f -- "$1")
  compopt -o filenames 2>/dev/null || true
}

_texra_compgen_dirs() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(compgen -d -- "$1")
  compopt -o filenames 2>/dev/null || true
}

_texra_completion_path() {
  local i=1 path="" token next
  while (( i < COMP_CWORD )); do
    token="\${COMP_WORDS[i]}"
    case "$token" in
      ${valueFlagPattern})
        ((i+=2)); continue ;;
      --*=*|-*) ((i++)); continue ;;
    esac
    next="$token"
    [[ -n "$path" ]] && next="$path $token"
    case " ${allCommandPaths.join(' ')} " in
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
    ${dynamicValueCases}
    ${fixedValueCases}
    ${genericValueCases}
  esac

  path="$(_texra_completion_path)"
  case "$path" in
    ${commands.map(commandCaseBlock).join('\n    ')}
    *) subcommands='${root?.subcommands.join(' ') ?? ''}'; flags='' ;;
  esac

  if [[ "$path" == 'run' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W "$(_texra_workflow_agents)" -- "$cur") )
    return
  fi

  if [[ "$path" == 'agents run' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W "$(_texra_tool_use_agents)" -- "$cur") )
    return
  fi

  if [[ "$path" == 'completion' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W '${CLI_COMPLETION_SHELLS.join(' ')}' -- "$cur") )
    return
  fi

  if [[ "$path" == 'agents show' || "$path" == 'agents inspect' ]] && [[ "$cur" != -* ]]; then
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
