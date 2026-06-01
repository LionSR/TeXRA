import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { toErrorMessage } from '@common/errors/errorMessage';
import { isNonEmptyString } from '@utils/core/stringCore';

import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../schemas/cliSettings';
import { parseCliApiMode, type CliApiMode } from './apiAccessMode';
import {
  CLI_OUTPUT_FORMATS,
  isKnownCliModel,
  loadWorkspaceCliConfig,
  type CliConfigValues,
  type CliOutputFormat,
} from './cliConfig';
import { resolveCliResourcesPath } from './resourcesPath';

export type CliMode = 'headless' | 'interactive';

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
  readonly apiMode?: CliApiMode;
  readonly quietLogs?: boolean;
  readonly renderRunProgress?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly termIsDumb?: boolean;
  readonly stderrIsTty?: boolean;
  readonly stdoutColorEnabled?: boolean;
  readonly stderrColorEnabled?: boolean;
  readonly colorEnabled: boolean;
  readonly version: string;
  readonly resourcesPath: string;
  readonly cliConfig?: CliConfigValues;
  readonly configFilePath?: string;
  readonly configWarnings?: readonly string[];
  readonly envAgent?: string;
  readonly envModel?: string;
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
  readonly termIsDumb?: boolean;
  readonly stdoutColorEnabled: boolean;
  readonly stderrColorEnabled: boolean;
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
  const colorAllowed = !noColor && !dumbTerm;
  const stdoutColorEnabled = stdoutIsTty && colorAllowed;
  const stderrColorEnabled = stderrIsTty && colorAllowed;
  cachedAmbient = {
    isCi: Boolean(process.env.CI),
    stdinIsTty,
    stdoutIsTty,
    stderrIsTty,
    termIsDumb: dumbTerm,
    stdoutColorEnabled,
    stderrColorEnabled,
    colorEnabled: stderrColorEnabled,
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

/** Path the CLI was invoked as (argv[1]), or '' when unavailable. */
export function readCliEntrypointPath(): string {
  return process.argv[1] ?? '';
}

export function isTexraCliEntrypointPath(entrypointPath: string): boolean {
  const name = path.basename(entrypointPath).toLowerCase();
  return (
    name === 'texra' ||
    name === 'texra-local' ||
    name === 'texra.js' ||
    name === 'texra.mjs' ||
    name === 'texra.ts'
  );
}

interface CliPackageManifest {
  readonly version?: string;
  readonly bugs?: { readonly url?: string };
}

async function readCliPackageManifest(): Promise<
  CliPackageManifest | undefined
> {
  const candidates = [
    new URL('../../package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(
        await readFile(candidate, 'utf8'),
      ) as CliPackageManifest;
      // Source and bundled `dist/bin` layouts both reach the CLI manifest via
      // `../../`; keep the fallback for build layouts that place runtime files
      // one level below the package root.
      if (pkg.version) return pkg;
    } catch {
      // Try the next source/build-layout candidate.
    }
  }
  return undefined;
}

let cachedVersion: Promise<string> | undefined;

export function readCliVersion(): Promise<string> {
  cachedVersion ??= readCliPackageManifest().then(
    (pkg) => pkg?.version ?? 'unknown',
  );
  return cachedVersion;
}

let cachedBugsUrl: Promise<string | undefined> | undefined;

/**
 * The issue-tracker URL declared in the CLI's `package.json` (`bugs.url`), used
 * to point users at the bug tracker on an unexpected crash. Read from the
 * manifest rather than hard-coded so it tracks the published metadata.
 */
export function readCliBugsUrl(): Promise<string | undefined> {
  cachedBugsUrl ??= readCliPackageManifest().then((pkg) => pkg?.bugs?.url);
  return cachedBugsUrl;
}

/**
 * The follow-up line appended to the top-level crash message pointing users at
 * the issue tracker. Returns `undefined` for usage errors (so the exit-2 path
 * stays clean) or when no tracker URL is configured — only an UNEXPECTED crash
 * with a known `bugs.url` gets the report prompt.
 */
export function formatCrashReportLine(
  error: unknown,
  bugsUrl: string | undefined,
): string | undefined {
  if (error instanceof CliUsageError || !bugsUrl) return undefined;
  return `This looks like a bug — please report it at ${bugsUrl} (include the command and the message above).`;
}

export interface CliGlobalArgs {
  readonly print?: boolean;
  readonly quiet?: boolean;
  readonly cwd?: string;
  readonly outputFormat?: CliOutputFormat;
  readonly approvalPolicy?: CliApprovalPolicy;
  readonly apiMode?: string;
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
  readonly env?: Record<string, string | undefined>;
}

function envValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return isNonEmptyString(value) ? value : undefined;
}

function pickEnum<T extends string>(
  candidates: readonly (string | undefined)[],
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
  label: string,
): T {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if ((allowed as readonly string[]).includes(candidate))
      return candidate as T;
    warnings.push(`Ignoring invalid ${label} "${candidate}".`);
  }
  return fallback;
}

function pickEnvModel(
  env: Record<string, string | undefined>,
  warnings: string[],
): string | undefined {
  const model = envValue(env, 'TEXRA_MODEL');
  if (!model) return undefined;
  if (isKnownCliModel(model)) return model;
  warnings.push(`Ignoring invalid TEXRA_MODEL "${model}".`);
  return undefined;
}

function pickCliApiMode(
  candidates: readonly { readonly label: string; readonly value?: string }[],
  warnings: string[],
): CliApiMode | undefined {
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const apiMode = parseCliApiMode(candidate.value);
    if (apiMode) return apiMode;
    warnings.push(`Ignoring invalid ${candidate.label} "${candidate.value}".`);
  }
  return undefined;
}

export async function resolveCliCwd(
  cwdFlag: string | undefined,
): Promise<string> {
  // When the user did not pass `--cwd`, `process.cwd()` is correct by
  // construction (the shell can't put us in a directory that doesn't exist).
  // When `--cwd` IS passed, validate it explicitly: a typo or stale path
  // should fail loudly instead of silently falling back to the resolved-but-
  // nonexistent string and running the agent against the wrong workspace.
  if (!isNonEmptyString(cwdFlag)) {
    return await realpath(process.cwd()).catch(() => process.cwd());
  }
  const requested = path.resolve(cwdFlag.trim());
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(requested);
  } catch (error: unknown) {
    if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
      throw new CliUsageError(`--cwd: path does not exist: ${requested}`);
    }
    throw new CliUsageError(
      `--cwd: cannot access ${requested}: ${toErrorMessage(error)}`,
    );
  }
  if (!info.isDirectory()) {
    throw new CliUsageError(`--cwd: not a directory: ${requested}`);
  }
  return await realpath(requested).catch(() => requested);
}

export async function buildCliContext(
  init: BuildCliContextInit,
): Promise<CliContext> {
  const ambient = init.ambient ?? readCliAmbientState();
  const env = init.env ?? process.env;
  const cwd = await resolveCliCwd(init.globalArgs.cwd);
  const loadedConfig = await loadWorkspaceCliConfig(cwd);
  const configWarnings = [...loadedConfig.warnings];
  const envModel = pickEnvModel(env, configWarnings);
  const apiMode = pickCliApiMode(
    [
      { label: '--api-mode', value: init.globalArgs.apiMode },
      { label: 'TEXRA_API_MODE', value: envValue(env, 'TEXRA_API_MODE') },
    ],
    configWarnings,
  );
  return {
    cwd,
    mode: cliMode(init.globalArgs, ambient),
    outputFormat: pickEnum(
      [
        init.globalArgs.outputFormat,
        envValue(env, 'TEXRA_OUTPUT_FORMAT'),
        loadedConfig.values.outputFormat,
      ],
      CLI_OUTPUT_FORMATS,
      'text',
      configWarnings,
      'TEXRA_OUTPUT_FORMAT',
    ),
    approvalPolicy: pickEnum(
      [
        init.globalArgs.approvalPolicy,
        envValue(env, 'TEXRA_APPROVAL_POLICY'),
        loadedConfig.values.approvalPolicy,
      ],
      CLI_APPROVAL_POLICIES,
      // Default to prompting. The interactive TUI surfaces a prompt; in
      // headless mode `ask` has no TTY to prompt on and falls through to
      // denial (see approvalAdapter), so this is safe for `run` too.
      'ask',
      configWarnings,
      'TEXRA_APPROVAL_POLICY',
    ),
    apiMode,
    quietLogs: init.globalArgs.quiet === true,
    stdoutIsTty: ambient.stdoutIsTty,
    termIsDumb: ambient.termIsDumb === true,
    stderrIsTty: ambient.stderrIsTty,
    stdoutColorEnabled: ambient.stdoutColorEnabled,
    stderrColorEnabled: ambient.stderrColorEnabled,
    colorEnabled: ambient.colorEnabled,
    version: await readCliVersion(),
    resourcesPath: resolveCliResourcesPath(),
    cliConfig: loadedConfig.values,
    configFilePath: loadedConfig.path,
    configWarnings,
    envAgent: envValue(env, 'TEXRA_AGENT'),
    envModel,
  };
}
