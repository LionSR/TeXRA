import {
  CLI_COMPLETION_SHELLS,
  DYNAMIC_VALUE_FLAG_SOURCES,
  POSITIONAL_COMPLETION_SOURCES,
  completionFlagVariants,
  type CompletionCommand,
  type CompletionFlag,
  type CompletionSource,
} from './completionCommandTree';

// Dynamic completion sources, gated on TEXRA_COMPLETION_DYNAMIC so scripts can
// opt out of shelling back into texra.
function dynamicListSource(source: CompletionSource): string {
  return `(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra ${source.command} 2>/dev/null | awk "{print \\$${source.column}}")`;
}

const TOP_LEVEL_RUN_CONDITION =
  "-n '__fish_seen_subcommand_from run; and not __fish_seen_subcommand_from agents; and not __fish_seen_subcommand_from multi-agent'";

// Positional agent/model completions, in emission order. Each source-backed
// path resolves its listing source from POSITIONAL_COMPLETION_SOURCES.
const DYNAMIC_POSITIONAL_COMPLETIONS: readonly (readonly [string, string])[] =
  Object.entries(POSITIONAL_COMPLETION_SOURCES).map(([commandPath, source]) => [
    commandPath === 'run'
      ? TOP_LEVEL_RUN_CONDITION
      : fishCondition(commandPath.split(' ')),
    dynamicListSource(source),
  ]);

// A dynamic-value flag emits one generic `complete` line regardless of which
// command carries it, so a flag added to DYNAMIC_VALUE_FLAG_SOURCES completes
// in fish without manual special-casing.
function dynamicFlagValueLines(
  commands: readonly CompletionCommand[],
): string[] {
  const flagsByName = new Map<string, CompletionFlag>();
  for (const command of commands) {
    for (const flag of command.flags) {
      if (
        flag.name in DYNAMIC_VALUE_FLAG_SOURCES &&
        !flagsByName.has(flag.name)
      ) {
        flagsByName.set(flag.name, flag);
      }
    }
  }
  return Object.keys(DYNAMIC_VALUE_FLAG_SOURCES)
    .filter((name) => flagsByName.has(name))
    .map((name) => {
      const flag = flagsByName.get(name)!;
      const base = [`-l ${flag.name}`];
      for (const alias of flag.aliases) base.push(`-s ${alias}`);
      base.push(
        '-r',
        `-a '${dynamicListSource(DYNAMIC_VALUE_FLAG_SOURCES[name])}'`,
      );
      return fishCompleteLine(base);
    });
}

function fishEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function fishCompleteLine(parts: readonly string[]): string {
  return `complete -c texra ${parts.join(' ')}`;
}

function fishDescription(description: string): string[] {
  return description ? [`-d '${fishEscape(description)}'`] : [];
}

function fishCondition(path: readonly string[]): string {
  if (path.length === 0) return "-n '__fish_use_subcommand'";
  const pathCondition = path
    .map((command) => `__fish_seen_subcommand_from ${fishEscape(command)}`)
    .join('; and ');
  return `-n '${pathCondition}'`;
}

export function fishCompletion(commands: readonly CompletionCommand[]): string {
  const lines = ['# fish completion for texra'];
  const root = commands.find((command) => command.path.length === 0);
  const commandDescriptions = new Map(
    commands.map((command) => [command.path.join(' '), command.description]),
  );
  const subcommandDescription = (
    parentPath: readonly string[],
    subcommand: string,
  ): string =>
    commandDescriptions.get([...parentPath, subcommand].join(' ')) ?? '';

  for (const subcommand of root?.subcommands ?? []) {
    lines.push(
      fishCompleteLine([
        "-n '__fish_use_subcommand'",
        `-a '${fishEscape(subcommand)}'`,
        ...fishDescription(subcommandDescription([], subcommand)),
      ]),
    );
  }
  for (const command of commands) {
    const condition = fishCondition(command.path);
    for (const flag of command.flags) {
      for (const variant of completionFlagVariants(flag)) {
        const base = [condition, `-l '${fishEscape(variant.name)}'`];
        for (const alias of variant.aliases) {
          base.push(`-s '${fishEscape(alias)}'`);
        }
        if (variant.takesValue) base.push('-r');
        if (variant.values.length > 0) {
          base.push(`-a '${fishEscape(variant.values.join(' '))}'`);
        }
        base.push(...fishDescription(variant.description));
        lines.push(fishCompleteLine(base));
      }
    }
    for (const subcommand of command.subcommands) {
      if (command.path.length === 0) continue;
      lines.push(
        fishCompleteLine([
          condition,
          `-a '${fishEscape(subcommand)}'`,
          ...fishDescription(subcommandDescription(command.path, subcommand)),
        ]),
      );
    }
  }
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from completion'",
      `-a '${CLI_COMPLETION_SHELLS.join(' ')}'`,
    ]),
  );
  for (const [condition, source] of DYNAMIC_POSITIONAL_COMPLETIONS) {
    lines.push(fishCompleteLine([condition, `-a '${source}'`]));
  }
  for (const line of dynamicFlagValueLines(commands)) {
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}
