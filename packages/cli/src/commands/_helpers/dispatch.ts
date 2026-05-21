import { showUsage, type CommandDef } from 'citty';

import { GLOBAL_BOOL_FLAGS, GLOBAL_VALUE_FLAGS } from './globalArgs';

interface LeadingGlobalFlags {
  readonly leadingGlobals: readonly string[];
  readonly restIndex: number;
  readonly stoppedOnUnknownFlag: boolean;
}

export function knownGlobalFlagTokenCount(
  rawArgs: readonly string[],
  index: number,
): number | undefined {
  const arg = rawArgs[index];
  if (arg === undefined || !arg.startsWith('-') || arg === '--') {
    return undefined;
  }

  const inline = arg.includes('=');
  const baseFlag = inline ? arg.slice(0, arg.indexOf('=')) : arg;
  if (GLOBAL_BOOL_FLAGS.has(baseFlag)) {
    return 1;
  }
  if (GLOBAL_VALUE_FLAGS.has(baseFlag)) {
    return inline || rawArgs[index + 1] === undefined ? 1 : 2;
  }
  return undefined;
}

function collectLeadingGlobalFlags(
  rawArgs: readonly string[],
): LeadingGlobalFlags {
  const leadingGlobals: string[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === undefined) break;
    if (!arg.startsWith('-')) break;
    if (arg === '--') break;

    const tokenCount = knownGlobalFlagTokenCount(rawArgs, i);
    if (tokenCount !== undefined) {
      leadingGlobals.push(...rawArgs.slice(i, i + tokenCount));
      i += tokenCount;
      continue;
    }

    return { leadingGlobals, restIndex: i, stoppedOnUnknownFlag: true };
  }
  return { leadingGlobals, restIndex: i, stoppedOnUnknownFlag: false };
}

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

export function normalizeRootShortcuts(rawArgs: readonly string[]): string[] {
  const { leadingGlobals, restIndex } = collectLeadingGlobalFlags(rawArgs);
  const shortcut = rawArgs[restIndex];
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

export function isCliError(error: unknown): error is Error & { code?: string } {
  return (
    error instanceof Error &&
    error.name === 'CLIError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

// Citty's `CommandDef<T>` is invariant in `T` (T appears in both `run` and
// `setup` parameters), so a narrower const-inferred command isn't assignable
// to the parent type. We treat the subcommand tree as `CommandDef<any>` while
// walking it; this matches citty's own `subCommands` shape and lets
// `showUsage` accept either width via cast at the call site.

export type AnyCommand = CommandDef<any>;

async function commandSubCommands(
  cmd: AnyCommand,
): Promise<Record<string, AnyCommand> | undefined> {
  const rawSubs = cmd.subCommands;
  if (!rawSubs) return undefined;
  return typeof rawSubs === 'function'
    ? await (rawSubs as () => Promise<Record<string, AnyCommand>>)()
    : ((await rawSubs) as Record<string, AnyCommand>);
}

/**
 * Walk `rawArgs` positional-by-positional through the subcommand tree to find
 * the deepest matched command. Used to scope `--help` to the subcommand the
 * user typed rather than always showing root-level usage.
 *
 * Stops at the first positional that doesn't match a child subcommand. Returns
 * a tuple of `[matchedCommand, parentCommandOrUndefined]` so `showUsage` can
 * render the same breadcrumb citty's own resolver produces.
 */
export async function resolveDeepestSubCommand(
  cmd: AnyCommand,
  rawArgs: readonly string[],
  parent?: AnyCommand,
): Promise<[AnyCommand, AnyCommand | undefined]> {
  const subCommands = await commandSubCommands(cmd);
  if (!subCommands) return [cmd, parent];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === undefined) break;
    if (token.startsWith('-')) continue;
    const next = subCommands[token];
    if (next) return resolveDeepestSubCommand(next, rawArgs.slice(i + 1), cmd);
    break;
  }
  return [cmd, parent];
}

export interface UnknownCliCommand {
  readonly typedCommand: string;
  readonly helpCommand: string;
}

function isPureSubCommandContainer(
  cmd: AnyCommand,
  subCommands: Record<string, AnyCommand>,
): boolean {
  return (
    Object.keys(subCommands).length > 0 &&
    typeof (cmd as { run?: unknown }).run !== 'function'
  );
}

export async function detectUnknownCliCommand(
  rootCommand: AnyCommand,
  rawArgs: readonly string[],
): Promise<UnknownCliCommand | undefined> {
  let cmd = rootCommand;
  const pathParts = ['texra'];

  for (let i = 0; i < rawArgs.length; ) {
    const token = rawArgs[i];
    if (token === undefined || token === '--') break;

    if (token.startsWith('-')) {
      const tokenCount = knownGlobalFlagTokenCount(rawArgs, i);
      if (tokenCount === undefined) return undefined;
      i += tokenCount;
      continue;
    }

    const subCommands = await commandSubCommands(cmd);
    if (!subCommands) return undefined;

    const next = subCommands[token];
    if (next) {
      cmd = next;
      pathParts.push(token);
      i += 1;
      continue;
    }

    if (isPureSubCommandContainer(cmd, subCommands)) {
      return {
        typedCommand: [...pathParts, token].join(' '),
        helpCommand: pathParts.join(' '),
      };
    }

    return undefined;
  }

  return undefined;
}

export function formatUnknownCliCommand(command: UnknownCliCommand): string {
  return `Unknown command: ${command.typedCommand}. Run \`${command.helpCommand} --help\` for usage.`;
}

export { showUsage };
