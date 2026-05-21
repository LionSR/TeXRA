import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '../../runtime/cliConfig';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../../runtime/approvalPolicy';
import { CliUsageError } from '../../runtime/cliContext';

/**
 * Single source of truth for the global flags accepted by every TeXRA
 * subcommand. `as const` + spread would lose literal-type narrowing (citty's
 * `ArgsDef` rejects `readonly string[]`), so each enum's `options` is
 * explicitly typed as a mutable literal tuple — assignable to `string[]` and
 * narrow enough for `defineCommand<const T>` to expose the per-option literal
 * on `ctx.args[...]`. Adding a new global flag is a one-line change here.
 */
export const GLOBAL_ARGS: {
  print: { type: 'boolean'; alias: 'p'; description: string };
  quiet: { type: 'boolean'; alias: 'q'; description: string };
  cwd: { type: 'string'; description: string };
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
} = {
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
    description: 'Working directory the agent runs against (defaults to $PWD)',
  },
  'api-mode': {
    type: 'string',
    description:
      'API access mode: included (TeXRA relay) or personal (your own API keys)',
  },
  'output-format': {
    type: 'enum',
    options: [...CLI_OUTPUT_FORMATS],
    description: 'Output format for headless runs (default: text)',
  },
  'approval-policy': {
    type: 'enum',
    options: [...CLI_APPROVAL_POLICIES],
    description: 'When to ask before privileged tool actions (default: never)',
  },
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
    return alias ? [long, `-${alias}`] : [long];
  }),
);

export function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
