import { GLOBAL_BOOL_FLAGS, GLOBAL_VALUE_FLAGS } from '../globalArgs';

export interface LeadingGlobalFlags {
  readonly leadingGlobals: readonly string[];
  readonly restIndex: number;
  readonly stoppedOnUnknownFlag: boolean;
}

/**
 * How many tokens the known global flag at `index` consumes, or `undefined`
 * when the token is not a recognized global flag. Value flags consume two
 * tokens unless they use inline `=value` form or have no following value.
 */
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

export function collectLeadingGlobalFlags(
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
 * Index of the first positional (non-flag) token, skipping known leading
 * global flags. Returns `undefined` when an unknown flag, `--`, or end of args
 * is hit first.
 */
export function firstPositionalIndex(
  rawArgs: readonly string[],
): number | undefined {
  for (let i = 0; i < rawArgs.length;) {
    const arg = rawArgs[i];
    if (arg === undefined || arg === '--') return undefined;
    if (!arg.startsWith('-')) return i;

    const tokenCount = knownGlobalFlagTokenCount(rawArgs, i);
    if (tokenCount === undefined) return undefined;
    i += tokenCount;
  }
  return undefined;
}
