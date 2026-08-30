import { quote } from 'shell-quote';

import {
  CLI_COMPLETION_SHELLS,
  DYNAMIC_VALUE_FLAG_SOURCES,
  POSITIONAL_COMPLETION_SOURCES,
  allCompletionSources,
  commandKey,
  completionFlagTokens,
  completionFlagVariants,
  completionSourceListing,
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

/** The dynamic-value flag tokens present in the tree, grouped per flag name. */
function dynamicValueFlagTokens(
  commands: readonly CompletionCommand[],
): Map<string, string[]> {
  const byFlagName = new Map<string, string[]>();
  for (const command of commands) {
    for (const flag of command.flags) {
      if (!(flag.name in DYNAMIC_VALUE_FLAG_SOURCES)) continue;
      if (!byFlagName.has(flag.name)) {
        byFlagName.set(flag.name, completionFlagTokens(flag));
      }
    }
  }
  return byFlagName;
}

function dynamicFlagValueCases(commands: readonly CompletionCommand[]): string {
  const byFlagName = dynamicValueFlagTokens(commands);
  return Object.keys(DYNAMIC_VALUE_FLAG_SOURCES)
    .filter((name) => byFlagName.has(name))
    .map((name) => {
      const shellFunction = DYNAMIC_VALUE_FLAG_SOURCES[name].shellFunction;
      return `${byFlagName.get(name)?.join('|')}) COMPREPLY=( $(compgen -W "$(${shellFunction})" -- "$cur") ); return ;;`;
    })
    .join('\n    ');
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
    [...dynamicValueFlagTokens(commands).values()].flat(),
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

// Positional completions keyed by command path, with the `compgen -W` word list
// each one offers. Derived from POSITIONAL_COMPLETION_SOURCES so a new
// source-backed path completes here the moment it lands in the shared map (as
// it already does for zsh and fish); `completion` offers the fixed shell list.
// The emitted blocks are mutually exclusive `$path` equality tests, so their
// order carries no meaning.
const POSITIONAL_COMPLETIONS: readonly {
  readonly commandPath: string;
  readonly words: string;
}[] = [
  ...Object.entries(POSITIONAL_COMPLETION_SOURCES).map(
    ([commandPath, source]) => ({
      commandPath,
      words: `"$(${source.shellFunction})"`,
    }),
  ),
  { commandPath: 'completion', words: `'${CLI_COMPLETION_SHELLS.join(' ')}'` },
];

function positionalCompletionBlocks(): string {
  return POSITIONAL_COMPLETIONS.map(
    ({ commandPath, words }) =>
      `  if [[ "$path" == '${commandPath}' && "$cur" != -* ]]; then
    COMPREPLY=( $(compgen -W ${words} -- "$cur") )
    return
  fi`,
  ).join('\n\n');
}

function dynamicSourceFunctions(): string {
  return allCompletionSources()
    .map(
      (source) =>
        `${source.shellFunction}() {
  _texra_completion_dynamic || return 0
  ${completionSourceListing(source)}
}`,
    )
    .join('\n\n');
}

function commandCaseBlock(command: CompletionCommand): string {
  const key = commandKey(command.path);
  const subcommands = command.subcommands.join(' ');
  const flags = command.flags.flatMap(completionFlagTokens).join(' ');
  return `${quote([key])}) subcommands=${quote([subcommands])}; flags=${quote([flags])} ;;`;
}

export function bashCompletion(commands: readonly CompletionCommand[]): string {
  const fixedValueCases = fixedFlagValueCases(commands);
  const dynamicValueCases = dynamicFlagValueCases(commands);
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

${dynamicSourceFunctions()}

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
  esac

${positionalCompletionBlocks()}

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$subcommands $flags" -- "$cur") )
  fi
}

complete -F _texra texra
`;
}
