import { GLOBAL_ARGS, HEADLESS_ONLY_GLOBAL_ARG_NAMES } from '../globalArgs';

import {
  commandArgs,
  resolveDeepestSubCommand,
  type AnyCommand,
  type ResolvedCliCommand,
} from './commandTree';
import { knownGlobalFlagTokenCount } from './argTokens';
import type { ArgDef } from 'citty';

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

function toStringArray(
  value: string | string[] | undefined,
): readonly string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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
  const aliases = toStringArray((def as { alias?: string | string[] }).alias);
  for (const alias of aliases) {
    if (alias.length === 1) {
      specs.short.set(`-${alias}`, spec);
    } else {
      addLongFlag(specs, alias, spec);
    }
  }

  // Accept the negated `--no-<name>` form for booleans that document one:
  // those defaulting to `true` (passed via the negative) and opt-in toggles
  // that advertise a `negativeDescription` (e.g. `--no-websocket`). Otherwise
  // `texra run --no-websocket` is rejected as an unknown flag.
  if (
    def.type === 'boolean' &&
    (def.default === true || 'negativeDescription' in def)
  ) {
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
    (commandName === 'chat' ||
      commandName === 'orchestrate' ||
      commandName === 'setup' ||
      commandName === 'resume')
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

function validateLongFlag(
  specs: CommandFlagSpecs,
  token: string,
): { readonly unknownFlag?: string; readonly skipNext: boolean } {
  const baseFlag = inlineFlagBase(token);
  const spec = specs.long.get(baseFlag);
  if (!spec) return { unknownFlag: baseFlag, skipNext: false };
  return { skipNext: spec.takesValue && baseFlag === token };
}

function validateShortFlag(
  specs: CommandFlagSpecs,
  token: string,
): { readonly unknownFlag?: string; readonly skipNext: boolean } {
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
  for (let i = 0; i < rawArgs.length;) {
    const token = rawArgs[i];
    if (token === undefined || token === '--') break;
    if (token.startsWith('-')) {
      const tokenCount = knownGlobalFlagTokenCount(rawArgs, i);
      if (tokenCount === undefined) break;
      i += tokenCount;
      continue;
    }
    return token === 'help' ? rawArgs.slice(i + 1) : rawArgs;
  }
  return rawArgs;
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
