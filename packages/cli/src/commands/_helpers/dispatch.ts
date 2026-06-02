import { renderUsage, type CommandDef, type CommandMeta } from 'citty';

import { writeRawStderr, writeRawStdout } from '@cli/runtime/logSinks';

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

export interface ResolvedCliCommand {
  readonly command: AnyCommand;
  readonly parent?: AnyCommand;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly rootCommand: AnyCommand;
}

export interface UsageSection {
  readonly title: string;
  readonly rows: readonly (readonly [label: string, description: string])[];
}

const usageSections = new WeakMap<AnyCommand, readonly UsageSection[]>();

export function withUsageSections<T extends AnyCommand>(
  command: T,
  sections: readonly UsageSection[],
): T {
  usageSections.set(command, sections);
  return command;
}

function formatUsageSection(section: UsageSection): string {
  if (section.rows.length === 0) return section.title;
  const labelWidth = Math.max(...section.rows.map(([label]) => label.length));
  return [
    section.title,
    '',
    ...section.rows.map(
      ([label, description]) => `  ${label.padEnd(labelWidth)}  ${description}`,
    ),
  ].join('\n');
}

async function renderUsageWithSections(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
): Promise<string> {
  const usage = await renderUsage(
    cmd,
    await usageParentWithFullPath(parent, context),
  );
  const sections = usageSections.get(cmd);
  if (!sections?.length) return usage;
  return `${usage}\n${sections.map(formatUsageSection).join('\n\n')}`;
}

interface UsageRenderContext {
  readonly parentPath?: readonly string[];
  readonly rootCommand?: AnyCommand;
}

async function resolveCommandMeta(cmd: AnyCommand): Promise<CommandMeta> {
  const meta = cmd.meta;
  if (meta == null) return {};
  return typeof meta === 'function' ? await meta() : await meta;
}

async function usageParentWithFullPath(
  parent: AnyCommand | undefined,
  context: UsageRenderContext | undefined,
): Promise<AnyCommand | undefined> {
  if (!parent || !context?.parentPath || context.parentPath.length <= 1) {
    return parent;
  }

  const [parentMeta, rootMeta] = await Promise.all([
    resolveCommandMeta(parent),
    context.rootCommand ? resolveCommandMeta(context.rootCommand) : undefined,
  ]);
  return {
    ...parent,
    meta: {
      ...parentMeta,
      name: context.parentPath.join(' '),
      version: parentMeta.version ?? rootMeta?.version,
    },
  };
}

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
 * the matched command, immediate parent, and the full command path so usage can
 * render `texra multi-agent run` rather than citty's immediate-parent fallback
 * of `multi-agent run`.
 */
export async function resolveDeepestSubCommand(
  cmd: AnyCommand,
  rawArgs: readonly string[],
  parent?: AnyCommand,
  commandPath: readonly string[] = ['texra'],
  parentPath: readonly string[] = [],
  rootCommand: AnyCommand = cmd,
): Promise<ResolvedCliCommand> {
  const subCommands = await commandSubCommands(cmd);
  if (!subCommands) {
    return { command: cmd, parent, commandPath, parentPath, rootCommand };
  }
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === undefined) break;
    if (token.startsWith('-')) continue;
    const next = subCommands[token];
    if (next) {
      return resolveDeepestSubCommand(
        next,
        rawArgs.slice(i + 1),
        cmd,
        [...commandPath, token],
        commandPath,
        rootCommand,
      );
    }
    break;
  }
  return { command: cmd, parent, commandPath, parentPath, rootCommand };
}

export interface UnknownCliCommand {
  readonly typedCommand: string;
  readonly helpCommand: string;
  readonly suggestedCommand?: string;
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

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function suggestionThreshold(token: string, candidate: string): number {
  return Math.max(1, Math.floor(Math.max(token.length, candidate.length) / 3));
}

function suggestSubCommand(
  token: string,
  subCommands: Record<string, AnyCommand>,
): string | undefined {
  let best: { readonly name: string; readonly distance: number } | undefined;

  for (const name of Object.keys(subCommands)) {
    const distance = editDistance(token, name);
    if (distance > suggestionThreshold(token, name)) continue;
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && name < best.name)
    ) {
      best = { name, distance };
    }
  }

  return best?.name;
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
      const suggestedName = suggestSubCommand(token, subCommands);
      return {
        typedCommand: [...pathParts, token].join(' '),
        helpCommand: pathParts.join(' '),
        suggestedCommand:
          suggestedName == null
            ? undefined
            : [...pathParts, suggestedName].join(' '),
      };
    }

    return undefined;
  }

  return undefined;
}

export function formatUnknownCliCommand(command: UnknownCliCommand): string {
  const suggestion =
    command.suggestedCommand == null
      ? ''
      : ` Did you mean \`${command.suggestedCommand}\`?`;
  return `Unknown command: ${command.typedCommand}.${suggestion} Run \`${command.helpCommand} --help\` for usage.`;
}

/**
 * Render usage text to STDERR (the diagnostic stream) instead of citty's
 * `showUsage`, which prints to STDOUT via `consola.log`. Usage shown because of
 * a usage error must not pollute STDOUT — otherwise `--output-format json|ndjson`
 * stops being machine-parseable (`texra run ... --output-format json | jq`).
 *
 * `renderUsage` is citty's string-returning primitive (it does not write
 * anywhere), so we own the destination. Explicit `--help` keeps using
 * `showUsage` (STDOUT) per Unix convention.
 */
export async function showUsageStderr(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
): Promise<void> {
  writeRawStderr(`${await renderUsageWithSections(cmd, parent, context)}\n`);
}

export async function showUsage(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
): Promise<void> {
  writeRawStdout(`${await renderUsageWithSections(cmd, parent, context)}\n\n`);
}
