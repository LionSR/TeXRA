import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  TEXRA_APPROVAL_POLICY_NO_INPUT_DEFAULT,
  parseTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { SkillSourceOptions } from '@skills/skillSources';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isNonEmptyString } from '@utils/text/stringUtils';

import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '../schemas/cliSettings';
import {
  isCliSupportedModelId,
  loadUserApprovalPolicy,
  loadWorkspaceCliConfig,
  type CliConfigValues,
} from './cliConfig';
import { resolveCliResourcesPath } from './resourcesPath';
import type { Stats } from 'node:fs';

type CliMode = 'headless' | 'interactive';

export interface CliPromptRequest {
  readonly kind: 'approval' | 'externalInquiry';
  readonly summary: string;
  readonly prompt: string;
}

/** Fully normalized CLI state produced by {@link buildCliContext}. */
export interface CliContext {
  readonly cwd: string;
  readonly mode: CliMode;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: TexraApprovalPolicy;
  readonly helperModel?: string;
  readonly quietLogs: boolean;
  readonly renderRunProgress?: boolean;
  readonly stdoutIsTty: boolean;
  readonly termIsDumb: boolean;
  readonly stderrIsTty: boolean;
  /** Color allowed when writing to stdout. */
  readonly stdoutColorEnabled: boolean;
  /** Color allowed when writing to stderr. */
  readonly stderrColorEnabled: boolean;
  readonly commandName: string;
  readonly version: string;
  readonly resourcesPath: string;
  readonly cliConfig: CliConfigValues;
  readonly configFilePath?: string;
  readonly configWarnings: readonly string[];
  readonly envAgent?: string;
  readonly envModel?: string;
  readonly skillSourceOptions: SkillSourceOptions;
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
  /** Color is allowed on stdout. */
  readonly stdoutColorEnabled: boolean;
  /** Color is allowed on stderr. */
  readonly stderrColorEnabled: boolean;
}

/**
 * Resolve whether ANSI color may be emitted on a given stream, reusing the
 * conventional override precedence picocolors' own `isColorSupported` honors:
 *
 * - `forceDisable` ⇒ never color.
 * - `NO_COLOR` (any value) or `TERM=dumb` ⇒ never color.
 * - `FORCE_COLOR` nonzero/truthy values ⇒ always color, ignoring TTY
 *   detection; `0`/`false`/`no` disable color; empty is ignored.
 * - otherwise color only when the destination stream is itself a TTY.
 *
 * `buildCliContext` applies `--no-color` after ambient stream detection so
 * injected ambient gates keep their already-resolved stream decisions.
 *
 * We keep our own per-stream TTY check rather than delegating wholesale to
 * picocolors because picocolors only inspects
 * `process.stdout.isTTY` (and treats `win32`/`CI` as color-on), which can't
 * answer "is color OK on *stderr*" — the gate `doctor` and the progress
 * renderer each need for their own destination.
 */
export function resolveStreamColor(
  streamIsTty: boolean,
  options: {
    forceDisable?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  if (options.forceDisable === true) return false;
  if (env.NO_COLOR != null || env.TERM === 'dumb') return false;
  const forceColor = parseForceColor(env.FORCE_COLOR);
  if (forceColor != null) return forceColor;
  return streamIsTty;
}

function parseForceColor(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  return !['0', 'false', 'no'].includes(normalized);
}

let cachedAmbient: CliAmbientState | undefined;

export function readCliAmbientState(): CliAmbientState {
  if (cachedAmbient) return cachedAmbient;
  const stderrIsTty = process.stderr.isTTY === true;
  const stdinIsTty = process.stdin.isTTY === true;
  const stdoutIsTty = process.stdout.isTTY === true;
  const dumbTerm = process.env.TERM === 'dumb';
  const stdoutColorEnabled = resolveStreamColor(stdoutIsTty);
  const stderrColorEnabled = resolveStreamColor(stderrIsTty);
  cachedAmbient = {
    isCi: Boolean(process.env.CI),
    stdinIsTty,
    stdoutIsTty,
    stderrIsTty,
    termIsDumb: dumbTerm,
    stdoutColorEnabled,
    stderrColorEnabled,
  };
  return cachedAmbient;
}

export function cliEnvValue(key: string): string | undefined {
  return process.env[key];
}

export function readCliEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

export async function readCliStdinText(): Promise<string> {
  process.stdin.setEncoding('utf8');
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }
  return chunks.join('');
}

/** Ambient shell cwd for CLI output that will be copied back into that shell. */
export function readCliCwd(): string {
  return process.cwd();
}

/** Raw CLI argv (post `node texra` slice). Allowlisted file for `process.argv`. */
export function readCliArgv(): string[] {
  return process.argv.slice(2);
}

/** Path the CLI was invoked as (argv[1]), or '' when unavailable. */
export function readCliEntrypointPath(): string {
  return process.argv[1] ?? '';
}

const CLI_ENTRYPOINT_NAMES: ReadonlySet<string> = new Set([
  'texra',
  'texra-local',
  'texra.js',
  'texra.mjs',
  'texra.ts',
]);

export function isTexraCliEntrypointPath(entrypointPath: string): boolean {
  return CLI_ENTRYPOINT_NAMES.has(path.basename(entrypointPath).toLowerCase());
}

export function resolveCliCommandName(entrypointPath: string): string {
  return path.basename(entrypointPath).toLowerCase() === 'texra-local'
    ? 'texra-local'
    : 'texra';
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
  readonly approvalPolicy?: TexraApprovalPolicy;
  /** `--no-color`: force-disable ANSI color on every stream. */
  readonly noColor?: boolean;
  /**
   * `--no-input`: the conventional "disable all prompts" switch. Forces
   * headless mode and defaults approval-gated actions to `never` unless the
   * user explicitly selects another approval policy.
   */
  readonly noInput?: boolean;
  readonly includeInteropSkills?: boolean;
  readonly skillSourcePaths?: readonly string[];
}

function cliMode(globalArgs: CliGlobalArgs, ambient: CliAmbientState): CliMode {
  // Headless trigger: explicit --print/-p, --no-input, CI=1, or stdin non-TTY.
  // Piping stdout/stderr alone doesn't force headless here — `texra chat`
  // hard-errors on its own TTY-stdout check (see `chat/tui/runChatTui.tsx`),
  // and `texra run` is happy with piped output. `--no-input` is the canonical
  // "disable all prompts" switch, so it forces headless like `--print`.
  const headless =
    globalArgs.print === true ||
    globalArgs.noInput === true ||
    ambient.isCi ||
    !ambient.stdinIsTty;
  return headless ? 'headless' : 'interactive';
}

export interface BuildCliContextInit {
  readonly globalArgs: CliGlobalArgs;
  readonly ambient?: CliAmbientState;
  readonly env?: Record<string, string | undefined>;
  /**
   * Root of the shared TeXRA storage directory. Production leaves this unset
   * (`~/.texra`); tests point it at a scratch directory so the developer's own
   * user-level config cannot decide an assertion.
   */
  readonly storageRoot?: string;
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
  if (isCliSupportedModelId(model)) return model;
  warnings.push(`Ignoring invalid TEXRA_MODEL "${model}".`);
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
    return canonicalizeWorkspacePath(readCliCwd());
  }
  const requested = path.resolve(cwdFlag);
  let info: Stats;
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
  return canonicalizeWorkspacePath(requested);
}

export async function buildCliContext(
  init: BuildCliContextInit,
): Promise<CliContext> {
  const ambient = init.ambient ?? readCliAmbientState();
  const env = init.env ?? process.env;
  const cwd = await resolveCliCwd(init.globalArgs.cwd);
  // Workspace file first, user file second — the same order
  // `platform().config` gives the extension and desktop hosts.
  const [loadedConfig, userApprovalPolicy] = await Promise.all([
    loadWorkspaceCliConfig(cwd),
    loadUserApprovalPolicy(init.storageRoot),
  ]);
  const configWarnings = [
    ...loadedConfig.warnings,
    ...userApprovalPolicy.warnings,
  ];
  const envModel = pickEnvModel(env, configWarnings);
  // `--no-color` is an explicit force-disable: layer it onto the ambient
  // per-stream gates rather than recomputing them, so `NO_COLOR`/`FORCE_COLOR`/
  // TTY precedence stays in one place (`resolveStreamColor`).
  const noColor = init.globalArgs.noColor === true;
  const stdoutColorEnabled = !noColor && ambient.stdoutColorEnabled;
  const stderrColorEnabled = !noColor && ambient.stderrColorEnabled;
  const noInput = init.globalArgs.noInput === true;
  const approvalPolicyFallback = noInput
    ? TEXRA_APPROVAL_POLICY_NO_INPUT_DEFAULT
    : TEXRA_APPROVAL_POLICY_DEFAULT;
  const approvalPolicyCandidates = noInput
    ? [init.globalArgs.approvalPolicy]
    : [
        init.globalArgs.approvalPolicy,
        envValue(env, 'TEXRA_APPROVAL_POLICY'),
        loadedConfig.values.approvalPolicy,
        userApprovalPolicy.value,
      ];
  let approvalPolicy = approvalPolicyFallback;
  for (const candidate of approvalPolicyCandidates) {
    if (!candidate) continue;
    const parsed = parseTexraApprovalPolicy(candidate);
    if (parsed) {
      approvalPolicy = parsed;
      break;
    }
    configWarnings.push(
      `Ignoring invalid TEXRA_APPROVAL_POLICY "${candidate}".`,
    );
  }
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
    approvalPolicy,
    quietLogs: init.globalArgs.quiet === true,
    stdoutIsTty: ambient.stdoutIsTty,
    termIsDumb: ambient.termIsDumb === true,
    stderrIsTty: ambient.stderrIsTty,
    stdoutColorEnabled,
    stderrColorEnabled,
    commandName: resolveCliCommandName(readCliEntrypointPath()),
    version: await readCliVersion(),
    resourcesPath: resolveCliResourcesPath(),
    cliConfig: loadedConfig.values,
    configFilePath: loadedConfig.path,
    configWarnings,
    envAgent: envValue(env, 'TEXRA_AGENT'),
    envModel,
    skillSourceOptions: {
      includeInterop: init.globalArgs.includeInteropSkills === true,
      additionalPaths: init.globalArgs.skillSourcePaths ?? [],
    },
  };
}
