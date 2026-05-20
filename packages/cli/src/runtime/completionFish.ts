import {
  CLI_COMPLETION_SHELLS,
  type CompletionCommand,
} from './completionCommandTree';

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

export function fishCompletion(commands: readonly CompletionCommand[]): string {
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
