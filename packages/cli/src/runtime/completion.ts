// Type imports
import type { ArgDef, ArgsDef, CommandDef, CommandMeta } from 'citty';

export const CLI_COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CliCompletionShell = (typeof CLI_COMPLETION_SHELLS)[number];
type AnyCommand = CommandDef<any>;

interface CompletionCommand {
  readonly path: readonly string[];
  readonly description: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly CompletionFlag[];
  readonly positionals: readonly string[];
}

interface CompletionFlag {
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

async function collectCommands(
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandKey(path: readonly string[]): string {
  return path.join(' ');
}

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

function bashCompletion(commands: readonly CompletionCommand[]): string {
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

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$subcommands $flags" -- "$cur") )
  fi
}

complete -F _texra texra
`;
}

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

function zshCompletion(commands: readonly CompletionCommand[]): string {
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

function fishEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function fishCompleteLine(parts: readonly string[]): string {
  return `complete -c texra ${parts.join(' ')}`;
}

function fishCondition(path: readonly string[]): string {
  if (path.length === 0) return "-n '__fish_use_subcommand'";
  const command = path.at(-1) ?? '';
  return `-n '__fish_seen_subcommand_from ${fishEscape(command)}'`;
}

function fishCompletion(commands: readonly CompletionCommand[]): string {
  const lines = ['# fish completion for texra'];
  const root = commands.find((command) => command.path.length === 0);
  for (const subcommand of root?.subcommands ?? []) {
    lines.push(
      fishCompleteLine([
        "-n '__fish_use_subcommand'",
        `-a '${fishEscape(subcommand)}'`,
      ]),
    );
  }
  for (const command of commands) {
    const condition = fishCondition(command.path);
    for (const flag of command.flags) {
      const base = [condition, `-l '${fishEscape(flag.name)}'`];
      for (const alias of flag.aliases) base.push(`-s '${fishEscape(alias)}'`);
      if (flag.takesValue) base.push('-r');
      if (flag.values.length > 0) {
        base.push(`-a '${fishEscape(flag.values.join(' '))}'`);
      }
      lines.push(fishCompleteLine(base));
    }
    for (const subcommand of command.subcommands) {
      if (command.path.length === 0) continue;
      lines.push(
        fishCompleteLine([condition, `-a '${fishEscape(subcommand)}'`]),
      );
    }
  }
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from completion'",
      `-a '${CLI_COMPLETION_SHELLS.join(' ')}'`,
    ]),
  );
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from run'",
      '-a \'(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra agents list --quiet 2>/dev/null | awk "{print \\$2}")\'',
    ]),
  );
  lines.push(
    fishCompleteLine([
      '-l model',
      '-s m',
      '-r',
      '-a \'(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra models list --quiet 2>/dev/null | awk "{print \\$1}")\'',
    ]),
  );
  lines.push(
    fishCompleteLine([
      '-l agent',
      '-r',
      '-a \'(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra agents list --quiet 2>/dev/null | awk "{print \\$2}")\'',
    ]),
  );
  return `${lines.join('\n')}\n`;
}

export async function generateCompletionScript(
  rootCommand: AnyCommand,
  shell: CliCompletionShell,
): Promise<string> {
  const commands = await collectCommands(rootCommand);
  switch (shell) {
    case 'bash':
      return bashCompletion(commands);
    case 'zsh':
      return zshCompletion(commands);
    case 'fish':
      return fishCompletion(commands);
  }
}
