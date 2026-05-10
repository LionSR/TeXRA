// Standard library imports
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local imports - CLI runtime
import {
  parseCliApprovalPolicy,
  type CliApprovalPolicy,
} from './approvalPolicy';
import type { CliOutputFormat } from './runtimeHost';

export type CliMode = 'headless' | 'interactive';

export interface CliContext {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly mode: CliMode;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly version: string;
  readonly resourcesPath: string;
}

const GLOBAL_FLAGS_WITH_VALUE = new Set([
  '--approval-policy',
  '--cwd',
  '--output-format',
]);

export const RUN_FLAGS_WITH_VALUE = new Set([
  '--input',
  '-i',
  '--output',
  '--model',
  '-m',
  '--instruction',
]);

const FLAGS_WITH_VALUE = new Set([
  ...GLOBAL_FLAGS_WITH_VALUE,
  ...RUN_FLAGS_WITH_VALUE,
]);

const GLOBAL_BOOLEAN_FLAGS = new Set(['--print', '-p']);

function isFlagLike(value: string | undefined): boolean {
  return value != null && value.startsWith('-');
}

function isFlagValue(value: string | undefined): value is string {
  return value != null && !value.startsWith('-');
}

export function flagValue(
  args: readonly string[],
  ...names: string[]
): string | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg == null) break;

    if (names.includes(arg)) {
      const value = args[index + 1];
      return isFlagLike(value) ? undefined : value;
    }

    if (FLAGS_WITH_VALUE.has(arg) && isFlagValue(args[index + 1])) {
      index += 2;
      continue;
    }

    index += 1;
  }
  return undefined;
}

function hasBooleanFlag(args: readonly string[], ...names: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg == null) break;

    if (names.includes(arg)) return true;

    if (FLAGS_WITH_VALUE.has(arg) && isFlagValue(args[index + 1])) {
      index += 2;
      continue;
    }

    index += 1;
  }
  return false;
}

function outputFormat(args: readonly string[]): CliOutputFormat {
  const value = flagValue(args, '--output-format') ?? 'text';
  if (value === 'json' || value === 'ndjson') return value;
  return 'text';
}

function approvalPolicy(args: readonly string[]): CliApprovalPolicy {
  return parseCliApprovalPolicy(flagValue(args, '--approval-policy'));
}

function cliMode(args: readonly string[]): CliMode {
  if (hasBooleanFlag(args, '--print', '-p')) return 'headless';
  if (process.env.CI) return 'headless';
  if (!process.stdout.isTTY) return 'headless';
  return 'interactive';
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

    if (GLOBAL_FLAGS_WITH_VALUE.has(arg)) {
      const value = args[index + 1];
      if (!isFlagValue(value)) break;
      globalArgs.push(arg);
      globalArgs.push(value);
      index += 2;
      continue;
    }

    if (!GLOBAL_BOOLEAN_FLAGS.has(arg)) break;
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
    path.resolve(currentDir, '../../../extension/resources'),
    path.resolve(currentDir, '../../extension/resources'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export async function resolveCliContext(
  argv?: readonly string[],
): Promise<CliContext> {
  const resolvedArgv = argv ?? process.argv.slice(2);
  const { globalArgs, commandArgs } = splitGlobalArgs(resolvedArgv);
  const cwd = flagValue(globalArgs, '--cwd') ?? process.cwd();
  return {
    argv: commandArgs,
    cwd,
    mode: cliMode(resolvedArgv),
    outputFormat: outputFormat(globalArgs),
    approvalPolicy: approvalPolicy(globalArgs),
    version: await readCliVersion(),
    resourcesPath: resolveResourcesPath(),
  };
}
