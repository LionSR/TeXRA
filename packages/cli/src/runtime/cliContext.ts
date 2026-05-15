// Standard library imports
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local imports - CLI runtime
import { type CliApprovalPolicy } from './approvalPolicy';

export type CliMode = 'headless' | 'interactive';
export type CliOutputFormat = 'text' | 'json' | 'ndjson';

export interface CliPromptRequest {
  readonly kind: 'approval' | 'externalInquiry';
  readonly summary: string;
  readonly prompt: string;
}

export interface CliContext {
  readonly cwd: string;
  readonly mode: CliMode;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly helperModel?: string;
  readonly quietLogs?: boolean;
  readonly colorEnabled: boolean;
  readonly stdin: CliAmbientState;
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

export interface CliAmbientState {
  readonly isCi: boolean;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
  readonly colorEnabled: boolean;
}

export function readCliAmbientState(): CliAmbientState {
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

export function cliEnvValue(key: string): string | undefined {
  return process.env[key];
}

/** Raw CLI argv (post `node texra` slice). Allowlisted file for `process.argv`. */
export function readCliArgv(): string[] {
  return process.argv.slice(2);
}

function resolveCwdFlag(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0
    ? path.resolve(value.trim())
    : fallback;
}

export async function readCliVersion(): Promise<string> {
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

export interface CliGlobalArgs {
  readonly print?: boolean;
  readonly cwd?: string;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: CliApprovalPolicy;
}

function cliMode(globalArgs: CliGlobalArgs, ambient: CliAmbientState): CliMode {
  // Headless gate (narrowed per PRD 13): --print/-p, CI, or stdin non-TTY.
  // Piping stdout or stderr alone no longer forces headless.
  const headless =
    globalArgs.print === true || ambient.isCi || !ambient.stdinIsTty;
  return headless ? 'headless' : 'interactive';
}

export interface BuildCliContextInit {
  readonly globalArgs: CliGlobalArgs;
  readonly ambient?: CliAmbientState;
}

export async function buildCliContext(
  init: BuildCliContextInit,
): Promise<CliContext> {
  const ambient = init.ambient ?? readCliAmbientState();
  return {
    cwd: resolveCwdFlag(init.globalArgs.cwd, process.cwd()),
    mode: cliMode(init.globalArgs, ambient),
    outputFormat: init.globalArgs.outputFormat,
    approvalPolicy: init.globalArgs.approvalPolicy,
    colorEnabled: ambient.colorEnabled,
    stdin: ambient,
    version: await readCliVersion(),
    resourcesPath: resolveResourcesPath(),
  };
}
