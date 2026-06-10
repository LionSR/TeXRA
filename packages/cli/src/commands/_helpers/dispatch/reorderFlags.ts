import { collectLeadingGlobalFlags, firstPositionalIndex } from './argTokens';

/**
 * Citty's runCommand consumes args at the root and passes only `rawArgs.slice(
 * subCommandIndex + 1)` to the matched subcommand. That means global flags
 * appearing before the subcommand name (`texra --output-format ndjson agents
 * list`) never reach the subcommand's parser. We sidestep that by lifting
 * leading global flags to the end of rawArgs so they live inside the
 * subcommand's slice. No-op when there is no subcommand or no leading globals.
 */
export function reorderGlobalFlags(rawArgs: readonly string[]): string[] {
  const { leadingGlobals, restIndex, stoppedOnUnknownFlag } =
    collectLeadingGlobalFlags(rawArgs);
  if (stoppedOnUnknownFlag) {
    // Unknown leading flag: leave the rest intact so runMain can surface
    // `--help`, `--version`, or an unknown-flag error.
    return [...rawArgs];
  }
  if (restIndex >= rawArgs.length || leadingGlobals.length === 0) {
    return [...rawArgs];
  }
  return [...rawArgs.slice(restIndex), ...leadingGlobals];
}

export interface NestedGlobalFlagGroup {
  readonly command: string;
  readonly subCommands: readonly string[];
}

/**
 * Citty repeats the same routing behavior at nested command groups: parent
 * args before an explicit child help find the child but are not forwarded to
 * the child parser. Move known global flags from `texra auth --output-format
 * json status`-style positions to `texra auth status --output-format json`,
 * while leaving default subcommands untouched.
 */
export function reorderNestedGlobalFlags(
  rawArgs: readonly string[],
  group: NestedGlobalFlagGroup,
): string[] {
  const commandIndex = firstPositionalIndex(rawArgs);
  if (commandIndex === undefined || rawArgs[commandIndex] !== group.command) {
    return [...rawArgs];
  }

  const afterCommand = rawArgs.slice(commandIndex + 1);
  const { leadingGlobals, restIndex, stoppedOnUnknownFlag } =
    collectLeadingGlobalFlags(afterCommand);
  if (
    stoppedOnUnknownFlag ||
    leadingGlobals.length === 0 ||
    restIndex >= afterCommand.length
  ) {
    return [...rawArgs];
  }

  const explicitSubCommand = afterCommand[restIndex];
  if (
    explicitSubCommand === undefined ||
    !group.subCommands.includes(explicitSubCommand)
  ) {
    return [...rawArgs];
  }

  return [
    ...rawArgs.slice(0, commandIndex + 1),
    explicitSubCommand,
    ...leadingGlobals,
    ...afterCommand.slice(restIndex + 1),
  ];
}

export function normalizeRootShortcuts(rawArgs: readonly string[]): string[] {
  const { leadingGlobals, restIndex } = collectLeadingGlobalFlags(rawArgs);
  const shortcut = rawArgs[restIndex];
  if (shortcut === '--version' || shortcut === '-v' || shortcut === '-V') {
    return ['version', ...leadingGlobals, ...rawArgs.slice(restIndex + 1)];
  }
  if (shortcut === '--logout') {
    return ['logout', ...leadingGlobals, ...rawArgs.slice(restIndex + 1)];
  }
  if (shortcut === '--resume') {
    const id = rawArgs[restIndex + 1];
    if (!id || id.startsWith('-')) {
      return ['resume', ...leadingGlobals, ...rawArgs.slice(restIndex + 1)];
    }
    return ['resume', id, ...leadingGlobals, ...rawArgs.slice(restIndex + 2)];
  }
  if (shortcut?.startsWith('--resume=')) {
    const id = shortcut.slice('--resume='.length);
    if (!id) {
      return ['resume', ...leadingGlobals, ...rawArgs.slice(restIndex + 1)];
    }
    return ['resume', id, ...leadingGlobals, ...rawArgs.slice(restIndex + 1)];
  }
  return [...rawArgs];
}
