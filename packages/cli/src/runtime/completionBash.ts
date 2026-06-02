import {
  CLI_COMPLETION_SHELLS,
  commandKey,
  completionFlagTokens,
  completionFlagVariants,
  shellQuote,
  type CompletionCommand,
  type CompletionFlag,
} from './completionCommandTree';

function flagTokens(flags: readonly CompletionFlag[]): string[] {
  return flags.flatMap(completionFlagTokens);
}

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

function flagValueTokens(commands: readonly CompletionCommand[]): string[] {
  return flagValueTokenEntries(commands).map((entry) => entry.token);
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
        `${flag}) COMPREPLY=( $(compgen -W ${shellQuote(values.join(' '))} -- "$cur") ); return ;;`,
    )
    .join('\n    ');
}

const DYNAMIC_VALUE_FLAG_CASES = [
  { tokens: ['--model', '-m'], source: '_texra_models' },
  { tokens: ['--agent'], source: '_texra_agents' },
] as const;

function dynamicFlagValueTokens(): Set<string> {
  return new Set(
    DYNAMIC_VALUE_FLAG_CASES.flatMap((flagCase) => flagCase.tokens),
  );
}

function dynamicFlagValueCases(): string {
  return DYNAMIC_VALUE_FLAG_CASES.map(
    (flagCase) =>
      `${flagCase.tokens.join('|')}) COMPREPLY=( $(compgen -W "$(${flagCase.source})" -- "$cur") ); return ;;`,
  ).join('\n    ');
}

function isFileValueFlag(flag: CompletionFlag): boolean {
  return flag.valueKind === 'file' || flag.valueKind === 'path';
}

function isDirectoryValueFlag(flag: CompletionFlag): boolean {
  return flag.valueKind === 'directory' || flag.valueKind === 'dir';
}

function genericFlagValueCases(commands: readonly CompletionCommand[]): string {
  const fixedValueFlags = new Set(
    commands.flatMap((command) =>
      command.flags
        .filter((flag) => flag.values.length > 0)
        .flatMap(completionFlagTokens),
    ),
  );
  const dynamicValueFlags = dynamicFlagValueTokens();
  const fileFlags: string[] = [];
  const directoryFlags: string[] = [];
  const genericFlags: string[] = [];

  for (const { flag, token } of flagValueTokenEntries(commands)) {
    if (fixedValueFlags.has(token) || dynamicValueFlags.has(token)) continue;
    if (isDirectoryValueFlag(flag)) {
      directoryFlags.push(token);
    } else if (isFileValueFlag(flag)) {
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
  const flags = flagTokens(command.flags).join(' ');
  return `${shellQuote(key)}) subcommands=${shellQuote(commands)}; flags=${shellQuote(flags)} ;;`;
}

export function bashCompletion(commands: readonly CompletionCommand[]): string {
  const root = commands.find((command) => command.path.length === 0);
  const fixedValueCases = fixedFlagValueCases(commands);
  const dynamicValueCases = dynamicFlagValueCases();
  const genericValueCases = genericFlagValueCases(commands);
  const valueFlagPattern =
    flagValueTokens(commands).join('|') || '--_texra_no_value_flags_';
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
