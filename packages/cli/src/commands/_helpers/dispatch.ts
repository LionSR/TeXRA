/**
 * Dispatch-time CLI helpers: argv token classification, command-tree
 * walking, flag reordering, unknown-command/-flag suggestions, and usage
 * rendering.
 */
import {
  type ArgDef,
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
  renderUsage,
} from 'citty';
import stripAnsi from 'strip-ansi';
import { writeRawStderr, writeRawStdout } from '@cli/runtime/logSinks';
import { readCliAmbientState } from '@cli/runtime/cliContext';
import { ensureArray } from '@utils/core';
import {
  editDistance,
  typoSuggestionThreshold,
} from '@utils/text/editDistance';
import {
  documentsNegatedBooleanForm,
  GLOBAL_ARGS,
  GLOBAL_BOOL_FLAGS,
  GLOBAL_VALUE_FLAGS,
  HEADLESS_ONLY_GLOBAL_ARG_NAMES,
  INTERACTIVE_COMMAND_NAMES,
} from './globalArgs';

// ---------------------------------------------------------------------------
// cliError
// ---------------------------------------------------------------------------

export function isCliError(error: unknown): error is Error & { code?: string } {
  return (
    error instanceof Error &&
    error.name === 'CLIError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// argTokens
// ---------------------------------------------------------------------------

interface LeadingGlobalFlags {
  readonly leadingGlobals: readonly string[];
  readonly restIndex: number;
  readonly stoppedOnUnknownFlag: boolean;
}

/**
 * How many tokens the known global flag at `index` consumes, or `undefined`
 * when the token is not a recognized global flag. Value flags consume two
 * tokens unless they use inline `=value` form or have no following value.
 */
function knownGlobalFlagTokenCount(
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
    if (arg === undefined || arg === '--' || !arg.startsWith('-')) break;

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
 * Index of the first positional (non-flag) token, skipping known leading
 * global flags. Returns `undefined` when an unknown flag, `--`, or end of args
 * is hit first.
 */
function firstPositionalIndex(rawArgs: readonly string[]): number | undefined {
  const { restIndex, stoppedOnUnknownFlag } =
    collectLeadingGlobalFlags(rawArgs);
  if (stoppedOnUnknownFlag) return undefined;
  const token = rawArgs[restIndex];
  return token === undefined || token === '--' ? undefined : restIndex;
}

// ---------------------------------------------------------------------------
// commandTree
// ---------------------------------------------------------------------------

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

async function resolveCommandMeta(cmd: AnyCommand): Promise<CommandMeta> {
  const meta = cmd.meta;
  if (meta == null) return {};
  return typeof meta === 'function' ? await meta() : await meta;
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

async function commandArgs(cmd: AnyCommand): Promise<ArgsDef> {
  const rawArgs = cmd.args;
  if (!rawArgs) return {};
  return typeof rawArgs === 'function'
    ? await (rawArgs as () => Promise<ArgsDef> | ArgsDef)()
    : ((await rawArgs) as ArgsDef);
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
): Promise<ResolvedCliCommand> {
  return resolveDeepestSubCommandPath({
    cmd,
    rawArgs,
    commandPath: ['texra'],
    parentPath: [],
    rootCommand: cmd,
  });
}

interface ResolveDeepestSubCommandPathInput {
  readonly cmd: AnyCommand;
  readonly rawArgs: readonly string[];
  readonly parent?: AnyCommand;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly rootCommand: AnyCommand;
}

async function resolveDeepestSubCommandPath({
  cmd,
  rawArgs,
  parent,
  commandPath,
  parentPath,
  rootCommand,
}: ResolveDeepestSubCommandPathInput): Promise<ResolvedCliCommand> {
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
      return resolveDeepestSubCommandPath({
        cmd: next,
        rawArgs: rawArgs.slice(i + 1),
        parent: cmd,
        commandPath: [...commandPath, token],
        parentPath: commandPath,
        rootCommand,
      });
    }
    break;
  }
  return { command: cmd, parent, commandPath, parentPath, rootCommand };
}

// ---------------------------------------------------------------------------
// reorderFlags
// ---------------------------------------------------------------------------

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
  // Unknown leading flag, no subcommand, or no leading globals: leave the
  // args intact so runMain can surface `--help`, `--version`, or an
  // unknown-flag error.
  if (
    stoppedOnUnknownFlag ||
    restIndex >= rawArgs.length ||
    leadingGlobals.length === 0
  ) {
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
  const rest = rawArgs.slice(restIndex + 1);
  if (shortcut === '--version' || shortcut === '-v' || shortcut === '-V') {
    return ['version', ...leadingGlobals, ...rest];
  }
  if (shortcut === '--resume') {
    const id = rest[0];
    if (!id || id.startsWith('-')) {
      return ['resume', ...leadingGlobals, ...rest];
    }
    return ['resume', id, ...leadingGlobals, ...rest.slice(1)];
  }
  if (shortcut?.startsWith('--resume=')) {
    const id = shortcut.slice('--resume='.length);
    if (!id) return ['resume', ...leadingGlobals, ...rest];
    return ['resume', id, ...leadingGlobals, ...rest];
  }
  return [...rawArgs];
}

// ---------------------------------------------------------------------------
// unknownCommand
// ---------------------------------------------------------------------------

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

function suggestSubCommand(
  token: string,
  subCommands: Record<string, AnyCommand>,
): string | undefined {
  let best: { readonly name: string; readonly distance: number } | undefined;

  for (const name of Object.keys(subCommands)) {
    const distance = editDistance(token, name);
    if (distance > typoSuggestionThreshold(token, name)) continue;
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

  for (let i = 0; i < rawArgs.length;) {
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

// ---------------------------------------------------------------------------
// unknownFlag
// ---------------------------------------------------------------------------

export interface UnknownCliFlag {
  readonly flag: string;
  readonly helpCommand: string;
}

interface FlagSpec {
  readonly takesValue: boolean;
}

interface CommandFlagSpecs {
  readonly long: Map<string, FlagSpec>;
  readonly short: Map<string, FlagSpec>;
}

function kebabCaseFlagName(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/_+/g, '-')
    .toLowerCase();
}

function addLongFlag(
  specs: CommandFlagSpecs,
  flagName: string,
  spec: FlagSpec,
): void {
  const names = new Set([flagName]);
  if (/[A-Z_]/.test(flagName)) {
    names.add(kebabCaseFlagName(flagName));
  }
  for (const name of names) {
    specs.long.set(`--${name}`, spec);
  }
}

function addFlagSpec(specs: CommandFlagSpecs, name: string, def: ArgDef): void {
  if (def.type === 'positional') return;

  const spec = { takesValue: def.type !== 'boolean' };
  addLongFlag(specs, name, spec);
  const aliasDef = (def as { alias?: string | string[] }).alias;
  const aliases = aliasDef === undefined ? [] : ensureArray(aliasDef);
  for (const alias of aliases) {
    if (alias.length === 1) {
      specs.short.set(`-${alias}`, spec);
    } else {
      addLongFlag(specs, alias, spec);
    }
  }

  if (documentsNegatedBooleanForm(def)) {
    addLongFlag(specs, `no-${name}`, { takesValue: false });
  }
}

function addInteractiveHeadlessOnlyFlags(specs: CommandFlagSpecs): void {
  for (const name of HEADLESS_ONLY_GLOBAL_ARG_NAMES) {
    addFlagSpec(specs, name, GLOBAL_ARGS[name]);
  }
}

async function commandFlagSpecs(
  resolved: ResolvedCliCommand,
): Promise<CommandFlagSpecs> {
  const specs: CommandFlagSpecs = { long: new Map(), short: new Map() };
  const args = await commandArgs(resolved.command);
  for (const [name, def] of Object.entries(args)) {
    addFlagSpec(specs, name, def);
  }

  const commandName = resolved.commandPath.at(-1);
  if (
    resolved.commandPath.length === 2 &&
    commandName !== undefined &&
    INTERACTIVE_COMMAND_NAMES.includes(commandName)
  ) {
    // Keep the existing explicit "interactive command" usage error for these
    // known headless-only global flags instead of downgrading it to "unknown".
    addInteractiveHeadlessOnlyFlags(specs);
  }

  return specs;
}

function inlineFlagBase(token: string): string {
  const equalsIndex = token.indexOf('=');
  return equalsIndex === -1 ? token : token.slice(0, equalsIndex);
}

interface FlagValidation {
  readonly unknownFlag?: string;
  readonly skipNext: boolean;
}

function validateLongFlag(
  specs: CommandFlagSpecs,
  token: string,
): FlagValidation {
  const baseFlag = inlineFlagBase(token);
  const spec = specs.long.get(baseFlag);
  if (!spec) return { unknownFlag: baseFlag, skipNext: false };
  return { skipNext: spec.takesValue && baseFlag === token };
}

function validateShortFlag(
  specs: CommandFlagSpecs,
  token: string,
): FlagValidation {
  for (let i = 1; i < token.length; i += 1) {
    const flag = `-${token[i]}`;
    const spec = specs.short.get(flag);
    if (!spec) return { unknownFlag: flag, skipNext: false };
    if (spec.takesValue) {
      return { skipNext: i === token.length - 1 };
    }
  }
  return { skipNext: false };
}

function helpTargetRawArgs(rawArgs: readonly string[]): readonly string[] {
  const index = firstPositionalIndex(rawArgs);
  if (index === undefined || rawArgs[index] !== 'help') return rawArgs;
  return rawArgs.slice(index + 1);
}

export async function detectUnknownCliFlag(
  rootCommand: AnyCommand,
  rawArgs: readonly string[],
): Promise<UnknownCliFlag | undefined> {
  const targetRawArgs = helpTargetRawArgs(rawArgs);
  const resolved = await resolveDeepestSubCommand(rootCommand, targetRawArgs);
  const specs = await commandFlagSpecs(resolved);

  for (let i = 0; i < targetRawArgs.length; i += 1) {
    const token = targetRawArgs[i];
    if (token === undefined || token === '--') break;
    if (!token.startsWith('-') || token === '-') continue;

    const result = token.startsWith('--')
      ? validateLongFlag(specs, token)
      : validateShortFlag(specs, token);
    if (result.unknownFlag) {
      return {
        flag: result.unknownFlag,
        helpCommand: resolved.commandPath.join(' '),
      };
    }
    if (result.skipNext) i += 1;
  }

  return undefined;
}

export function formatUnknownCliFlag(flag: UnknownCliFlag): string {
  return `Unknown option: ${flag.flag}. Run \`${flag.helpCommand} --help\` for usage.`;
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

export interface UsageSection {
  readonly title: string;
  readonly rows: readonly (readonly [label: string, description: string])[];
}

interface UsageRenderContext {
  readonly parentPath?: readonly string[];
  readonly rootCommand?: AnyCommand;
}

const usageSections = new WeakMap<AnyCommand, readonly UsageSection[]>();

let usageColorOverride: boolean | undefined;

export function hasUsageNoColorFlag(rawArgs: readonly string[]): boolean {
  for (let index = 0; index < rawArgs.length;) {
    const arg = rawArgs[index];
    if (arg === undefined || arg === '--') return false;
    if (arg === '--no-color') return true;

    const tokenCount = knownGlobalFlagTokenCount(rawArgs, index);
    index += tokenCount ?? 1;
  }
  return false;
}

export function setUsageColorOverrideFromRawArgs(
  rawArgs: readonly string[],
): void {
  usageColorOverride = hasUsageNoColorFlag(rawArgs) ? false : undefined;
}

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

function usageColorEnabled(stream: 'stdout' | 'stderr'): boolean | undefined {
  if (usageColorOverride !== undefined) return usageColorOverride;
  const ambient = readCliAmbientState();
  return stream === 'stdout'
    ? ambient.stdoutColorEnabled
    : ambient.stderrColorEnabled;
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

async function renderUsageWithSections(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
  stream: 'stdout' | 'stderr' = 'stdout',
): Promise<string> {
  const usage = await renderUsage(
    cmd,
    await usageParentWithFullPath(parent, context),
  );
  const sections = usageSections.get(cmd);
  const usageWithSections = sections?.length
    ? `${usage}\n${sections.map(formatUsageSection).join('\n\n')}`
    : usage;
  return usageColorEnabled(stream) === false
    ? stripAnsi(usageWithSections)
    : usageWithSections;
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
  writeRawStderr(
    `${await renderUsageWithSections(cmd, parent, context, 'stderr')}\n`,
  );
}

export async function showUsage(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
): Promise<void> {
  writeRawStdout(`${await renderUsageWithSections(cmd, parent, context)}\n\n`);
}
