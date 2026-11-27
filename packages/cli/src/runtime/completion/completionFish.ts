import {
  CLI_COMPLETION_SHELLS,
  POSITIONAL_COMPLETION_SOURCES,
  completionFlagVariants,
  dynamicValueFlags,
  type CompletionCommand,
  type CompletionSource,
} from './completionCommandTree';

// Dynamic completion sources, gated on TEXRA_COMPLETION_DYNAMIC so scripts can
// opt out of shelling back into texra.
function dynamicListSource(source: CompletionSource): string {
  return `(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra ${source.command} 2>/dev/null | awk "{print \\$1}")`;
}

// Positional model completions, in emission order. Each source-backed
// path resolves its listing source from POSITIONAL_COMPLETION_SOURCES.
const DYNAMIC_POSITIONAL_COMPLETIONS: readonly (readonly [string, string])[] =
  Object.entries(POSITIONAL_COMPLETION_SOURCES).map(([commandPath, source]) => [
    fishCondition(commandPath.split(' ')),
    dynamicListSource(source),
  ]);

// A dynamic-value flag emits one generic `complete` line regardless of which
// command carries it, so a flag added to the dynamic-value sources completes
// in fish without manual special-casing.
function dynamicFlagValueLines(
  commands: readonly CompletionCommand[],
): string[] {
  return dynamicValueFlags(commands).map(({ flag, source }) =>
    fishCompleteLine([
      `-l ${flag.name}`,
      ...flag.aliases.map((alias) => `-s ${alias}`),
      '-r',
      `-a '${dynamicListSource(source)}'`,
    ]),
  );
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
        if (variant.value.kind !== 'none') base.push('-r');
        if (variant.value.kind === 'choice') {
          base.push(`-a '${fishEscape(variant.value.values.join(' '))}'`);
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
