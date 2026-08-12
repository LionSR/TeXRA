import { quote } from 'shell-quote';

import {
  CLI_COMPLETION_SHELLS,
  DYNAMIC_VALUE_FLAG_SOURCES,
  POSITIONAL_COMPLETION_SOURCES,
  allCompletionSources,
  commandKey,
  completionFlagVariants,
  completionSourceListing,
  type CompletionCommand,
  type CompletionFlag,
  type CompletionFlagVariant,
} from './completionCommandTree';

function zshFlagValueSuffix(
  flag: CompletionFlag,
  variant: CompletionFlagVariant,
): string {
  if (variant.values.length > 0) return `: :(${variant.values.join(' ')})`;
  if (!variant.takesValue) return '';
  const dynamicSource = DYNAMIC_VALUE_FLAG_SOURCES[flag.name];
  if (dynamicSource) return `:${flag.name}:($(${dynamicSource.shellFunction}))`;
  return `:${variant.valueKind ?? 'value'}:`;
}

/** Positional specs for the source-backed paths, plus the fixed shell list. */
function positionalSpecs(): Readonly<Record<string, string>> {
  const specs: Record<string, string> = {
    completion: `1:shell:(${CLI_COMPLETION_SHELLS.join(' ')})`,
  };
  for (const [commandPath, source] of Object.entries(
    POSITIONAL_COMPLETION_SOURCES,
  )) {
    const tag = commandPath === 'models show' ? 'model' : 'agent';
    specs[commandPath] = `1:${tag}:($(${source.shellFunction}))`;
  }
  return specs;
}

function dynamicSourceFunctions(): string {
  return allCompletionSources()
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
  const specsByPath = positionalSpecs();
  const pathCases = commands
    .filter((command) => command.path.length > 0)
    .map((command) => {
      const key = commandKey(command.path);
      const subs = command.subcommands.length
        ? `_values 'subcommands' ${quote(command.subcommands)}`
        : 'true';
      const positionalSpec = specsByPath[key];
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
