import {
  CLI_COMPLETION_SHELLS,
  completionFlagVariants,
  type CompletionCommand,
} from './completionCommandTree';

// Dynamic completion sources, gated on TEXRA_COMPLETION_DYNAMIC so scripts can
// opt out of shelling back into texra.
const AGENTS_LIST_SOURCE =
  '(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra agents list --quiet 2>/dev/null | awk "{print \\$2}")';
const WORKFLOW_AGENTS_LIST_SOURCE =
  '(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra agents list --quiet --all --category workflow 2>/dev/null | awk "{print \\$2}")';
const TOOL_USE_AGENTS_LIST_SOURCE =
  '(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra agents list --quiet --all --category toolUse 2>/dev/null | awk "{print \\$2}")';
const MODELS_LIST_SOURCE =
  '(test "$TEXRA_COMPLETION_DYNAMIC" != 0; and texra models list --quiet 2>/dev/null | awk "{print \\$1}")';
const TOP_LEVEL_RUN_CONDITION =
  "-n '__fish_seen_subcommand_from run; and not __fish_seen_subcommand_from agents; and not __fish_seen_subcommand_from multi-agent'";

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
  lines.push(
    fishCompleteLine([
      TOP_LEVEL_RUN_CONDITION,
      `-a '${WORKFLOW_AGENTS_LIST_SOURCE}'`,
    ]),
  );
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from agents; and __fish_seen_subcommand_from run'",
      `-a '${TOOL_USE_AGENTS_LIST_SOURCE}'`,
    ]),
  );
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from agents; and __fish_seen_subcommand_from show'",
      `-a '${AGENTS_LIST_SOURCE}'`,
    ]),
  );
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from agents; and __fish_seen_subcommand_from inspect'",
      `-a '${AGENTS_LIST_SOURCE}'`,
    ]),
  );
  lines.push(
    fishCompleteLine([
      "-n '__fish_seen_subcommand_from models; and __fish_seen_subcommand_from show'",
      `-a '${MODELS_LIST_SOURCE}'`,
    ]),
  );
  lines.push(
    fishCompleteLine(['-l model', '-s m', '-r', `-a '${MODELS_LIST_SOURCE}'`]),
  );
  lines.push(
    fishCompleteLine(['-l agent', '-r', `-a '${TOOL_USE_AGENTS_LIST_SOURCE}'`]),
  );
  return `${lines.join('\n')}\n`;
}
