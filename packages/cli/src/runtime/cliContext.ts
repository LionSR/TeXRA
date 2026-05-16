import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNonEmptyString } from '@utils/core/stringCore';

import { type CliApprovalPolicy } from './approvalPolicy';

export type CliMode = 'headless' | 'interactive';

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

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

let cachedAmbient: CliAmbientState | undefined;

export function readCliAmbientState(): CliAmbientState {
  if (cachedAmbient) return cachedAmbient;
  const stderrIsTty = process.stderr.isTTY === true;
  const stdinIsTty = process.stdin.isTTY === true;
  const stdoutIsTty = process.stdout.isTTY === true;
  const noColor = process.env.NO_COLOR != null;
  const dumbTerm = process.env.TERM === 'dumb';
  cachedAmbient = {
    isCi: Boolean(process.env.CI),
    stdinIsTty,
    stdoutIsTty,
    stderrIsTty,
    colorEnabled: stderrIsTty && !noColor && !dumbTerm,
  };
  return cachedAmbient;
}

export function cliEnvValue(key: string): string | undefined {
  return process.env[key];
}

/** Raw CLI argv (post `node texra` slice). Allowlisted file for `process.argv`. */
export function readCliArgv(): string[] {
  return process.argv.slice(2);
}

let cachedVersion: Promise<string> | undefined;

export function readCliVersion(): Promise<string> {
  cachedVersion ??= resolveCliVersion();
  return cachedVersion;
}

async function resolveCliVersion(): Promise<string> {
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
      // Try the next source/build-layout candidate.
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
  // Headless trigger: explicit --print/-p, CI=1, or stdin non-TTY. Piping
  // stdout/stderr alone doesn't force headless here — `texra chat` hard-errors
  // on its own TTY-stdout check (see `chat/tui/runChatTui.tsx`), and `texra
  // run` is happy with piped output.
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
  const cwdFlag = init.globalArgs.cwd;
  return {
    cwd: isNonEmptyString(cwdFlag)
      ? path.resolve(cwdFlag.trim())
      : process.cwd(),
    mode: cliMode(init.globalArgs, ambient),
    outputFormat: init.globalArgs.outputFormat,
    approvalPolicy: init.globalArgs.approvalPolicy,
    colorEnabled: ambient.colorEnabled,
    version: await readCliVersion(),
    resourcesPath: resolveResourcesPath(),
  };
}
