import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '@cli/runtime/cliConfig';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '@cli/schemas/cliSettings';
import { CliUsageError } from '@cli/runtime/cliContext';

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
  'api-mode': { type: 'string'; description: string };
  'output-format': {
    type: 'enum';
    options: CliOutputFormat[];
    description: string;
  };
  'approval-policy': {
    type: 'enum';
    options: CliApprovalPolicy[];
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
  'skill-source': {
    type: 'string';
    alias: 'S';
    valueHint: string;
    description: string;
  };
};

export const GLOBAL_ARGS: CliGlobalArgsDef = {
  print: {
    type: 'boolean',
    alias: 'p',
    description: 'Run non-interactively and print the result to stdout',
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
  'api-mode': {
    type: 'string',
    description:
      'API access mode: included (TeXRA relay) or personal (your own API keys); also accepts relay/byok',
  },
  'output-format': {
    type: 'enum',
    options: [...CLI_OUTPUT_FORMATS],
    description: 'Output format for headless runs (default: text)',
  },
  'approval-policy': {
    type: 'enum',
    options: [...CLI_APPROVAL_POLICIES],
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
      'Disable prompts and run headlessly (defaults approvals to never)',
  },
};

export const SKILL_SOURCE_ARGS: CliSkillSourceArgsDef = {
  'include-interop': {
    type: 'boolean',
    description:
      'Also import .claude/skills, .codex/skills, and .gemini/skills from the workspace and home directory',
  },
  'skill-source': {
    type: 'string',
    alias: 'S',
    valueHint: 'directory',
    description:
      'Additional skill root to import into agent prompts; may be repeated and is resolved relative to --cwd',
  },
};

export const AGENT_RUN_GLOBAL_ARGS = {
  ...GLOBAL_ARGS,
  ...SKILL_SOURCE_ARGS,
} as const;

export const ROOT_ROUTING_ARGS = AGENT_RUN_GLOBAL_ARGS;

/**
 * Flags that are meaningful for commands which necessarily own the terminal.
 * In particular, `chat` and `orchestrate` cannot honor `--print`,
 * `--output-format`, or `--no-input` (which forces headless); scripts should use
 * a concrete headless command instead. `--no-color` still applies — a terminal
 * session may legitimately want plain output.
 */
export const INTERACTIVE_GLOBAL_ARGS: Omit<
  CliGlobalArgsDef,
  'print' | 'output-format' | 'no-input'
> = {
  quiet: GLOBAL_ARGS.quiet,
  cwd: GLOBAL_ARGS.cwd,
  'api-mode': GLOBAL_ARGS['api-mode'],
  'approval-policy': GLOBAL_ARGS['approval-policy'],
  color: GLOBAL_ARGS.color,
};

export const INTERACTIVE_AGENT_GLOBAL_ARGS = {
  ...INTERACTIVE_GLOBAL_ARGS,
  ...SKILL_SOURCE_ARGS,
} as const;

// Derived from `ROOT_ROUTING_ARGS` so adding/renaming a leading-routable flag
// in one place flows through to `reorderGlobalFlags` automatically. Commands
// still choose which routed flags they accept through their own args objects.
export const GLOBAL_VALUE_FLAGS = new Set<string>(
  Object.entries(ROOT_ROUTING_ARGS)
    .filter(([, def]) => def.type !== 'boolean')
    .map(([name]) => `--${name}`),
);

export const GLOBAL_BOOL_FLAGS = new Set<string>(
  Object.entries(ROOT_ROUTING_ARGS).flatMap(([name, def]) => {
    if (def.type !== 'boolean') return [];
    const long = `--${name}`;
    const alias = 'alias' in def ? def.alias : undefined;
    const flags = alias ? [long, `-${alias}`] : [long];
    // Booleans defaulting to `true` are passed by their negated form
    // (`--no-color`); citty rewrites those to `<name>: false`.
    // Register the negated spelling so leading-flag reordering and unknown-
    // command detection recognize `texra --no-color agents list`.
    if ('default' in def && def.default === true) flags.push(`--no-${name}`);
    return flags;
  }),
);

export function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isHeadlessOnlyFlag(arg: string): boolean {
  return (
    arg === '--print' ||
    arg.startsWith('--print=') ||
    arg === '-p' ||
    arg === '--no-input' ||
    arg.startsWith('--no-input=') ||
    arg === '--output-format' ||
    arg.startsWith('--output-format=')
  );
}

export function rejectHeadlessOnlyFlags(
  rawArgs: readonly string[],
  commandName: string,
): void {
  if (!rawArgs.some(isHeadlessOnlyFlag)) return;

  throw new CliUsageError(
    `texra ${commandName} is interactive and does not support --print, --no-input, or --output-format. For scripting, use \`texra run\` or a concrete non-interactive subcommand.`,
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

export function optionalStringFlagValue(
  rawArgs: readonly string[],
  longName: string,
): string | undefined {
  const longFlag = `--${longName}`;
  const inlineLongPrefix = `${longFlag}=`;
  let value: string | undefined;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === undefined || arg === '--') break;

    if (arg.startsWith(inlineLongPrefix)) {
      value = requireInlineStringFlagValue(
        longFlag,
        arg.slice(inlineLongPrefix.length),
      );
      continue;
    }

    if (arg === longFlag) {
      value = requireSeparateStringFlagValue(longFlag, rawArgs[i + 1]);
      i += 1;
    }
  }

  return value;
}

export function collectStringFlagValues(
  rawArgs: readonly string[],
  longName: string,
  shortName: string,
): string[] {
  const longFlag = `--${longName}`;
  const inlineLongPrefix = `${longFlag}=`;
  const shortFlag = `-${shortName}`;
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
