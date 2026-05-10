// Standard library imports
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

export function flagValue(
  args: readonly string[],
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];
  }
  return undefined;
}

function outputFormat(args: readonly string[]): CliOutputFormat {
  const value = flagValue(args, '-o', '--output-format') ?? 'text';
  if (value === 'json' || value === 'ndjson') return value;
  return 'text';
}

function approvalPolicy(args: readonly string[]): CliApprovalPolicy {
  return parseCliApprovalPolicy(flagValue(args, '--approval-policy'));
}

function cliMode(args: readonly string[]): CliMode {
  if (args.includes('--print') || args.includes('-p')) return 'headless';
  if (process.env.CI) return 'headless';
  if (!process.stdout.isTTY) return 'headless';
  return 'interactive';
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
  return candidates[0];
}

export async function resolveCliContext(
  argv?: readonly string[],
): Promise<CliContext> {
  const resolvedArgv = argv ?? process.argv.slice(2);
  const cwd = flagValue(resolvedArgv, '--cwd') ?? process.cwd();
  return {
    argv: resolvedArgv,
    cwd,
    mode: cliMode(resolvedArgv),
    outputFormat: outputFormat(resolvedArgv),
    approvalPolicy: approvalPolicy(resolvedArgv),
    version: await readCliVersion(),
    resourcesPath: resolveResourcesPath(),
  };
}
