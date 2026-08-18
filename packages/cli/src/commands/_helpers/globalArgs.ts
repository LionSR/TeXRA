import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '@cli/schemas/cliSettings';
import { CliUsageError } from '@cli/runtime/cliContext';
import {
  TEXRA_APPROVAL_POLICIES,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { INTEROP_SKILL_DIRS } from '@skills/skillSources';
import { unique } from '@utils/core';

/**
 * Single source of truth for the global flags accepted by every TeXRA
 * subcommand. `as const` + spread would lose literal-type narrowing (citty's
 * `ArgsDef` rejects `readonly string[]`), so each enum's `options` is
 * explicitly typed as a mutable literal tuple — assignable to `string[]` and
 * narrow enough for `defineCommand<const T>` to expose the per-option literal
 * on `ctx.args[...]`. Adding a new global flag is a one-line change here.
 */
type CliGlobalArgsDef = {
  print: { type: 'boolean'; alias: 'p'; description: string };
  quiet: { type: 'boolean'; alias: 'q'; description: string };
  cwd: { type: 'string'; valueHint: string; description: string };
  'output-format': {
    type: 'enum';
    options: CliOutputFormat[];
    description: string;
  };
  'approval-policy': {
    type: 'enum';
    options: TexraApprovalPolicy[];
    description: string;
  };
  // Positively-named boolean defaulting to `true`: citty parses `--no-color`
  // into `color: false` and renders the negative variant in usage from
  // `negativeDescription` (see citty's `parseRawArgs`).
  color: {
    type: 'boolean';
    default: true;
    negativeDescription: string;
    description: string;
  };
  'no-input': {
    type: 'boolean';
    description: string;
  };
};

type CliSkillSourceArgsDef = {
  'include-interop': { type: 'boolean'; description: string };
  source: {
    type: 'string';
    alias: 's';
    valueHint: string;
    description: string;
  };
};

function formatCommaList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export const GLOBAL_ARGS: CliGlobalArgsDef = {
  print: {
    type: 'boolean',
    alias: 'p',
    description:
      'For headless commands, run non-interactively and print the result to stdout',
  },
  quiet: {
    type: 'boolean',
    alias: 'q',
    description: 'Suppress progress output and informational logs',
  },
  cwd: {
    type: 'string',
    valueHint: 'directory',
    description: 'Working directory the agent runs against (defaults to $PWD)',
  },
  'output-format': {
    type: 'enum',
    options: [...CLI_OUTPUT_FORMATS],
    description: 'Output format for headless commands (default: text)',
  },
  'approval-policy': {
    type: 'enum',
    options: [...TEXRA_APPROVAL_POLICIES],
    description:
      'Privileged tool actions: never (deny all), ask (prompt; default), or yolo (auto-approve)',
  },
  color: {
    type: 'boolean',
    default: true,
    description: 'Emit ANSI color (also honors NO_COLOR / FORCE_COLOR / TERM)',
    negativeDescription: 'Disable ANSI color on every stream',
  },
  'no-input': {
    type: 'boolean',
    description:
      'For headless commands, disable prompts and default approvals to never',
  },
};

export const SKILL_SOURCE_ARGS: CliSkillSourceArgsDef = {
  'include-interop': {
    type: 'boolean',
    description: `Also include ${formatCommaList(
      INTEROP_SKILL_DIRS.map((dir) => `${dir}/skills`),
    )} from the workspace and home directory`,
  },
  source: {
    type: 'string',
    alias: 's',
    valueHint: 'directory',
    description:
      'Additional skill root; may be repeated and is resolved relative to --cwd',
  },
};

export const AGENT_RUN_GLOBAL_ARGS = {
  ...GLOBAL_ARGS,
  ...SKILL_SOURCE_ARGS,
} as const;

export const HEADLESS_ONLY_GLOBAL_ARG_NAMES = [
  'print',
  'output-format',
  'no-input',
] as const;
type HeadlessOnlyGlobalArgName =
  (typeof HEADLESS_ONLY_GLOBAL_ARG_NAMES)[number];

/**
 * Flags that are meaningful for commands which necessarily own the terminal.
 * In particular, `chat` and `orchestrate` cannot honor the headless-only
 * globals above; scripts should use a concrete headless command instead.
 * `--no-color` still applies — a terminal session may legitimately want plain
 * output.
 */
export const INTERACTIVE_GLOBAL_ARGS: Omit<
  CliGlobalArgsDef,
  HeadlessOnlyGlobalArgName
> = {
  quiet: GLOBAL_ARGS.quiet,
  cwd: GLOBAL_ARGS.cwd,
  'approval-policy': GLOBAL_ARGS['approval-policy'],
  color: GLOBAL_ARGS.color,
};

export const INTERACTIVE_AGENT_GLOBAL_ARGS = {
  ...INTERACTIVE_GLOBAL_ARGS,
  ...SKILL_SOURCE_ARGS,
} as const;

/**
 * Commands that necessarily own the terminal and therefore reject the
 * headless-only globals with the explicit "interactive command" usage error
 * (see {@link rejectHeadlessOnlyFlags} and dispatch's flag-spec handling)
 * instead of reporting them as unknown flags.
 */
export const INTERACTIVE_COMMAND_NAMES: readonly string[] = [
  'chat',
  'orchestrate',
  'setup',
  'resume',
];

// The long flag plus any single-character alias for a routable global flag.
function flagSpellings(
  name: string,
  def: { type: string; alias?: string },
): string[] {
  const long = `--${name}`;
  return def.alias ? [long, `-${def.alias}`] : [long];
}

// Derived from `AGENT_RUN_GLOBAL_ARGS` so adding/renaming a leading-routable flag
// in one place flows through to `reorderGlobalFlags` automatically. Commands
// still choose which routed flags they accept through their own args objects.
export const GLOBAL_VALUE_FLAGS = new Set<string>(
  Object.entries(AGENT_RUN_GLOBAL_ARGS).flatMap(([name, def]) =>
    def.type === 'boolean' ? [] : flagSpellings(name, def),
  ),
);

/**
 * Whether a boolean arg documents a negated `--no-<name>` spelling: those
 * defaulting to `true`, which the user necessarily passes via the negative
 * (`--no-color`, `--no-pr`). citty rewrites `--no-<name>` to `<name>: false`;
 * both leading-flag reordering and unknown-flag detection register the spelling
 * so `texra --no-color agents list` parses.
 */
export function documentsNegatedBooleanForm(def: {
  readonly type?: string;
  readonly default?: boolean | number | string;
}): boolean {
  return def.type === 'boolean' && def.default === true;
}

export const GLOBAL_BOOL_FLAGS = new Set<string>(
  Object.entries(AGENT_RUN_GLOBAL_ARGS).flatMap(([name, def]) => {
    if (def.type !== 'boolean') return [];
    const flags = flagSpellings(name, def);
    if (documentsNegatedBooleanForm(def)) flags.push(`--no-${name}`);
    return flags;
  }),
);

export function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function camelCaseFlagName(name: string): string {
  return name.replaceAll(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

/**
 * Read a boolean flag from citty's parsed args under every spelling citty can
 * produce: the declared hyphenated key, the camelCase alias, and — for a
 * `no-`-prefixed flag — the positive key set to `false` (citty rewrites
 * `--no-browser` into `browser: false`).
 */
export function booleanArg(args: object, name: string): boolean {
  const record = args as Record<string, unknown>;
  if (record[name] === true || record[camelCaseFlagName(name)] === true) {
    return true;
  }
  return name.startsWith('no-') && record[name.slice(3)] === false;
}

export interface CommonAgentRunFlags {
  inputFiles: string[];
  contextFiles: string[];
  instruction: string;
  instructionFile: string | undefined;
}

/**
 * The `--input/-i`, `--context/-c`, `--instruction`, and `--instruction-file`
 * flags shared by the `agents run`, `multi-agent`, and `workflow run` commands.
 * Spread the result into the command's run options.
 */
export function collectCommonAgentRunFlags(
  rawArgs: readonly string[],
  instruction: unknown,
): CommonAgentRunFlags {
  return {
    inputFiles: collectStringFlagValues(rawArgs, 'input', 'i'),
    contextFiles: collectStringFlagValues(rawArgs, 'context', 'c'),
    instruction: optString(instruction) ?? '',
    instructionFile: optionalStringFlagValue(rawArgs, 'instruction-file'),
  };
}

function headlessOnlyFlagLabel(arg: string): string | undefined {
  for (const name of HEADLESS_ONLY_GLOBAL_ARG_NAMES) {
    for (const spelling of flagSpellings(name, GLOBAL_ARGS[name])) {
      if (arg === spelling) return `--${name}`;
      if (spelling.startsWith('--') && arg.startsWith(`${spelling}=`)) {
        return spelling;
      }
    }
  }
  return undefined;
}

export function rejectHeadlessOnlyFlags(
  rawArgs: readonly string[],
  commandName: string,
): void {
  const labels = unique(
    rawArgs
      .map(headlessOnlyFlagLabel)
      .filter((label): label is string => label !== undefined),
  );
  if (labels.length === 0) return;

  throw new CliUsageError(
    `texra ${commandName} is interactive and does not support ${formatCommaList(labels)}. For scripting, use \`texra run\` or a concrete non-interactive subcommand.`,
  );
}

function requireInlineStringFlagValue(flag: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return trimmed;
}

function requireSeparateStringFlagValue(
  flag: string,
  value: string | undefined,
): string {
  if (
    value === undefined ||
    value === '--' ||
    (value !== '-' && value.startsWith('-'))
  ) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return value;
}

// Single-valued flag: the last occurrence wins.
export function optionalStringFlagValue(
  rawArgs: readonly string[],
  longName: string,
): string | undefined {
  return collectStringFlagValues(rawArgs, longName).at(-1);
}

export function collectStringFlagValues(
  rawArgs: readonly string[],
  longName: string,
  shortName?: string,
): string[] {
  const longFlag = `--${longName}`;
  const inlineLongPrefix = `${longFlag}=`;
  const shortFlag = shortName === undefined ? undefined : `-${shortName}`;
  const values: string[] = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === undefined || arg === '--') break;

    if (arg.startsWith(inlineLongPrefix)) {
      values.push(
        requireInlineStringFlagValue(
          longFlag,
          arg.slice(inlineLongPrefix.length),
        ),
      );
      continue;
    }

    if (arg === longFlag || arg === shortFlag) {
      values.push(requireSeparateStringFlagValue(arg, rawArgs[i + 1]));
      i += 1;
    }
  }

  return values;
}
