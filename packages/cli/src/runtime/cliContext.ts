// Standard library imports
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local imports - CLI runtime
import {
  CLI_APPROVAL_POLICIES,
  parseCliApprovalPolicy,
  type CliApprovalPolicy,
} from './approvalPolicy';
import {
  CLI_BOOLEAN_FLAGS,
  FLAGS_WITH_VALUE,
  GLOBAL_BOOLEAN_FLAGS,
  GLOBAL_FLAGS_WITH_VALUE,
  cliFlagName,
} from './cliFlags';

export type CliMode = 'headless' | 'interactive';
export type CliOutputFormat = 'text' | 'json' | 'ndjson';

export interface CliPromptRequest {
  readonly kind: 'approval' | 'externalInquiry';
  readonly summary: string;
  readonly prompt: string;
}

export interface CliContext {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly mode: CliMode;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly helperModel?: string;
  readonly quietLogs?: boolean;
  readonly colorEnabled: boolean;
  readonly version: string;
  readonly resourcesPath: string;
  readonly approvalPrompt?: (request: CliPromptRequest) => Promise<string>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

interface CliAmbientState {
  readonly isCi: boolean;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
  readonly colorEnabled: boolean;
}

function readCliAmbientState(): CliAmbientState {
  const stderrIsTty = process.stderr.isTTY === true;
  return {
    isCi: Boolean(process.env.CI),
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    stderrIsTty,
    colorEnabled:
      stderrIsTty &&
      process.env.NO_COLOR == null &&
      process.env.TERM !== 'dumb',
  };
}

function inlineFlagValue(arg: string, ...names: string[]): string | undefined {
  for (const name of names) {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function nonEmptyFlagValue(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

export function flagValue(
  args: readonly string[],
  ...names: string[]
): string | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg == null) break;

    const inlineValue = inlineFlagValue(arg, ...names);
    if (inlineValue !== undefined) return nonEmptyFlagValue(inlineValue);

    if (names.includes(arg)) {
      return nonEmptyFlagValue(args[index + 1]);
    }

    const flagName = cliFlagName(arg);
    if (FLAGS_WITH_VALUE.has(flagName)) {
      index += arg.includes('=') || args[index + 1] == null ? 1 : 2;
      continue;
    }

    if (CLI_BOOLEAN_FLAGS.has(flagName)) {
      index += 1;
      continue;
    }

    index += 1;
  }
  return undefined;
}

export function cliEnvValue(key: string): string | undefined {
  return process.env[key];
}

function hasBooleanFlag(args: readonly string[], ...names: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg == null) break;

    const flagName = cliFlagName(arg);
    if (names.includes(flagName)) return true;

    if (FLAGS_WITH_VALUE.has(flagName)) {
      index += arg.includes('=') || args[index + 1] == null ? 1 : 2;
      continue;
    }

    if (CLI_BOOLEAN_FLAGS.has(flagName)) {
      index += 1;
      continue;
    }

    index += 1;
  }
  return false;
}

function outputFormat(args: readonly string[]): CliOutputFormat {
  const value = flagValue(args, '--output-format');
  if (value == null) return 'text';
  if (value === 'text' || value === 'json' || value === 'ndjson') {
    return value;
  }
  throw new CliUsageError(
    `Unsupported --output-format: ${value}. Expected text, json, or ndjson.`,
  );
}

function approvalPolicy(args: readonly string[]): CliApprovalPolicy {
  const value = flagValue(args, '--approval-policy');
  if (value == null) return 'never';
  const parsed = parseCliApprovalPolicy(value);
  if (parsed) return parsed;
  throw new CliUsageError(
    `Unsupported --approval-policy: ${value}. Expected ${CLI_APPROVAL_POLICIES.join(', ')}.`,
  );
}

function resolveCwdFlag(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0
    ? path.resolve(value.trim())
    : fallback;
}

export function applyCliGlobalArgs(
  context: CliContext,
  args: readonly string[],
): CliContext {
  return {
    ...context,
    cwd: resolveCwdFlag(flagValue(args, '--cwd'), context.cwd),
    mode: hasBooleanFlag(args, '--print', '-p') ? 'headless' : context.mode,
    outputFormat:
      flagValue(args, '--output-format') == null
        ? context.outputFormat
        : outputFormat(args),
    approvalPolicy:
      flagValue(args, '--approval-policy') == null
        ? context.approvalPolicy
        : approvalPolicy(args),
  };
}

function cliMode(args: readonly string[], ambient: CliAmbientState): CliMode {
  const headless =
    hasBooleanFlag(args, '--print', '-p') ||
    ambient.isCi ||
    !ambient.stdinIsTty ||
    !ambient.stdoutIsTty ||
    !ambient.stderrIsTty;
  return headless ? 'headless' : 'interactive';
}

function splitGlobalArgs(args: readonly string[]): {
  globalArgs: readonly string[];
  commandArgs: readonly string[];
} {
  const globalArgs: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (
      arg == null ||
      !arg.startsWith('-') ||
      arg === '--help' ||
      arg === '-h' ||
      arg === '--version' ||
      arg === '-v'
    ) {
      break;
    }

    const flagName = cliFlagName(arg);
    if (GLOBAL_FLAGS_WITH_VALUE.has(flagName)) {
      if (arg.includes('=')) {
        globalArgs.push(arg);
        index += 1;
        continue;
      }
      const value = args[index + 1];
      if (value == null) break;
      globalArgs.push(arg);
      globalArgs.push(value);
      index += 2;
      continue;
    }

    if (!GLOBAL_BOOLEAN_FLAGS.has(flagName)) break;
    globalArgs.push(arg);
    index += 1;
  }

  return {
    globalArgs,
    commandArgs: args.slice(index),
  };
}

async function readCliVersion(): Promise<string> {
  const candidates = [
    new URL('../../package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await readFile(candidate, 'utf8')) as {
        version?: string;
      };
      if (pkg.version) return pkg.version;
    } catch {
      // Try the next source/build layout candidate.
    }
  }

  return 'unknown';
}

function resolveResourcesPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const candidates = [
    path.resolve(currentDir, '../resources'),
    path.resolve(currentDir, '../../../extension/resources'),
    path.resolve(currentDir, '../../extension/resources'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export async function resolveCliContext(
  argv?: readonly string[],
): Promise<CliContext> {
  const ambient = readCliAmbientState();
  const resolvedArgv = argv ?? process.argv.slice(2);
  const { globalArgs, commandArgs } = splitGlobalArgs(resolvedArgv);
  const cwdFlag = flagValue(globalArgs, '--cwd');
  const cwd = resolveCwdFlag(cwdFlag, process.cwd());
  return {
    argv: commandArgs,
    cwd,
    mode: cliMode(globalArgs, ambient),
    outputFormat: outputFormat(globalArgs),
    approvalPolicy: approvalPolicy(globalArgs),
    colorEnabled: ambient.colorEnabled,
    version: await readCliVersion(),
    resourcesPath: resolveResourcesPath(),
  };
}
