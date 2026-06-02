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
    description: 'Disable all prompts (headless + deny privileged actions)',
  },
};

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

// Derived from `GLOBAL_ARGS` so adding/renaming a global flag in one place
// flows through to `reorderGlobalFlags` automatically.
export const GLOBAL_VALUE_FLAGS = new Set<string>(
  Object.entries(GLOBAL_ARGS)
    .filter(([, def]) => def.type !== 'boolean')
    .map(([name]) => `--${name}`),
);

export const GLOBAL_BOOL_FLAGS = new Set<string>(
  Object.entries(GLOBAL_ARGS).flatMap(([name, def]) => {
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

export function rejectHeadlessOnlyFlags(
  rawArgs: readonly string[],
  commandName: string,
): void {
  const headlessOnly = rawArgs.some(
    (arg) =>
      arg === '--print' ||
      arg === '-p' ||
      arg === '--no-input' ||
      arg === '--output-format' ||
      arg.startsWith('--output-format='),
  );
  if (!headlessOnly) return;

  throw new CliUsageError(
    `texra ${commandName} is interactive and does not support --print, --no-input, or --output-format. For scripting, use \`texra run\` or a concrete non-interactive subcommand.`,
  );
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
      const value = arg.slice(inlineLongPrefix.length).trim();
      if (value) values.push(value);
      continue;
    }

    if (arg === longFlag || arg === shortFlag) {
      const value = rawArgs[i + 1];
      if (value === undefined) {
        throw new CliUsageError(`Missing value for ${arg}`);
      }
      values.push(value);
      i += 1;
    }
  }

  return values;
}
