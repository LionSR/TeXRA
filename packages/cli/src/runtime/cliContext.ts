import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect, FileSystem, Result } from 'effect';

import { safeParseJson } from '@common/parsing/safeParseJson';
import type { MinimumLogLevel } from '@logger/effectDiagnostics';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import type { ConfigProvider } from '@platform/interfaces';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  TEXRA_APPROVAL_POLICY_NO_INPUT_DEFAULT,
  parseTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  CLI_OUTPUT_FORMATS,
  CLI_OUTPUT_FORMAT_CONFIG_KEY,
  type CliOutputFormat,
} from '@shared/schemas';
import type { SkillSourceOptions } from '@skills/skillSources';
import { readConfigSettingFrom } from '@utils/config/platformSettings';
import { absentReason } from '@utils/files/fsEntryExists';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { envVar } from '@utils/system/envFlags';
import { isNonEmptyString } from '@utils/text/stringUtils';

import { isCliSupportedModelId, loadCliStartupConfig } from './cliConfig';
import { resolveCliResourcesPath } from './resourcesPath';

type CliMode = 'headless' | 'interactive';

export interface CliPromptRequest {
  readonly kind: 'approval';
  readonly summary: string;
  readonly prompt: string;
}

/** Fully normalized CLI state produced by {@link buildCliContext}. */
export interface CliContext {
  readonly storageRoot?: string;
  readonly cwd: string;
  readonly mode: CliMode;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: TexraApprovalPolicy;
  readonly quietLogs: boolean;
  /**
   * The diagnostics emission threshold this process's runtime builds with,
   * decided once from argv — `--quiet` is `None`, `--verbose` is `Debug`,
   * otherwise `Info` — because a terminal is the one surface with no live
   * level filter of its own. A flag is exactly the kind of fact a
   * layer-build capture is for: it cannot change mid-process.
   */
  readonly minimumLogLevel: MinimumLogLevel;
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
  /**
   * The one config provider of this process, opened before the platform and
   * installed as the workspace roots' config by `initCliPlatform`: every
   * setting read after startup resolves through this same pair of stores.
   */
  readonly config: ConfigProvider;
  readonly configWarnings: readonly string[];
  /** The `configWarnings` that `--quiet` does not hide; see `CliStartupConfig`. */
  readonly configDegradations: readonly string[];
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

/** Fail the command with a usage error. */
export const failUsage = (message: string) =>
  Effect.fail(new CliUsageError(message));

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
    // A candidate that is absent, unreadable or unparsable is the expected
    // answer for the layout this build is not: try the next one. The read's
    // rejection and the parse's throw are recovered separately because a
    // `then` rejection handler does not see a throw from its own fulfillment
    // handler.
    const text = await readFile(candidate, 'utf8').then(
      (value) => value,
      () => undefined,
    );
    if (text === undefined) continue;
    const pkg = Result.getOrUndefined(safeParseJson(text)) as
      CliPackageManifest | undefined;
    // Source and bundled `dist/bin` layouts both reach the CLI manifest via
    // `../../`; keep the fallback for build layouts that place runtime files
    // one level below the package root.
    if (pkg?.version) return pkg;
  }
  return undefined;
}

let cachedManifest: Promise<CliPackageManifest | undefined> | undefined;

/** The one cached read of the CLI's `package.json`; `readCliVersion` and
 *  `readCliBugsUrl` both derive from it instead of each keeping (and
 *  re-reading from disk behind) its own cache. */
function loadCliPackageManifest(): Promise<CliPackageManifest | undefined> {
  cachedManifest ??= readCliPackageManifest();
  return cachedManifest;
}

export function readCliVersion(): Promise<string> {
  return loadCliPackageManifest().then((pkg) => pkg?.version ?? 'unknown');
}

/**
 * The issue-tracker URL declared in the CLI's `package.json` (`bugs.url`), used
 * to point users at the bug tracker on an unexpected crash. Read from the
 * manifest rather than hard-coded so it tracks the published metadata.
 */
export function readCliBugsUrl(): Promise<string | undefined> {
  return loadCliPackageManifest().then((pkg) => pkg?.bugs?.url);
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
  readonly verbose?: boolean;
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
  /**
   * Root of the shared TeXRA storage directory. Production leaves this unset
   * (`~/.texra`); tests point it at a scratch directory so the developer's own
   * user-level config cannot decide an assertion.
   */
  readonly storageRoot?: string;
}

/** One env-tier value from the ambient ConfigProvider, trimmed; blank reads as unset. */
const envTier = (key: string): Effect.Effect<string | undefined> =>
  Effect.map(envVar(key), (raw) => {
    const value = raw?.trim();
    return isNonEmptyString(value) ? value : undefined;
  });

/** An env-tier value through its own parse; an invalid one warns and yields nothing. */
const pickEnv = <T extends string>(
  key: string,
  parse: (candidate: string) => T | undefined,
  warnings: string[],
): Effect.Effect<T | undefined> =>
  Effect.map(envTier(key), (candidate) => {
    if (!candidate) return undefined;
    const parsed = parse(candidate);
    if (parsed === undefined) {
      warnings.push(`Ignoring invalid ${key} "${candidate}".`);
    }
    return parsed;
  });

const resolveCliCwd = Effect.fn('cliContext.resolveCliCwd')(function* (
  cwdFlag: string | undefined,
): Effect.fn.Return<string, CliUsageError, FileSystem.FileSystem> {
  // When the user did not pass `--cwd`, `process.cwd()` is correct by
  // construction (the shell can't put us in a directory that doesn't exist).
  // When `--cwd` IS passed, validate it explicitly: a typo or stale path
  // should fail loudly instead of silently falling back to the resolved-but-
  // nonexistent string and running the agent against the wrong workspace.
  if (!isNonEmptyString(cwdFlag)) {
    return canonicalizeWorkspacePath(readCliCwd());
  }
  const requested = path.resolve(cwdFlag);
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(requested)
    .pipe(
      Effect.mapError((error) =>
        absentReason(error)
          ? new CliUsageError(`--cwd: path does not exist: ${requested}`)
          : new CliUsageError(
              `--cwd: cannot access ${requested}: ${toErrorMessage(error.reason.cause ?? error)}`,
            ),
      ),
    );
  if (info.type !== 'Directory') {
    return yield* Effect.fail(
      new CliUsageError(`--cwd: not a directory: ${requested}`),
    );
  }
  return canonicalizeWorkspacePath(requested);
});

export const buildCliContext = Effect.fn('cliContext.buildCliContext')(
  function* (
    init: BuildCliContextInit,
  ): Effect.fn.Return<
    CliContext,
    CliUsageError | Error,
    FileSystem.FileSystem
  > {
    const ambient = init.ambient ?? readCliAmbientState();
    const cwd = yield* resolveCliCwd(init.globalArgs.cwd);
    // The project file over the user file, resolved by the same
    // `JsonConfigProvider` that `roots.config` gives the extension and desktop
    // hosts — and, from `initCliPlatform` on, this host too. This is the
    // pre-runtime open, which is why it goes through `loadCliStartupConfig`
    // rather than the process runtime.
    const { config, warnings, degradations } = yield* loadCliStartupConfig(
      cwd,
      init.storageRoot,
    );
    const configWarnings = [...warnings];
    const envModel = yield* pickEnv(
      'TEXRA_MODEL',
      (model) => (isCliSupportedModelId(model) ? model : undefined),
      configWarnings,
    );
    // `--no-color` is an explicit force-disable: layer it onto the ambient
    // per-stream gates rather than recomputing them, so `NO_COLOR`/
    // `FORCE_COLOR`/TTY precedence stays in one place (`resolveStreamColor`).
    const noColor = init.globalArgs.noColor === true;
    const stdoutColorEnabled = !noColor && ambient.stdoutColorEnabled;
    const stderrColorEnabled = !noColor && ambient.stderrColorEnabled;
    const noInput = init.globalArgs.noInput === true;
    // The flag is validated by citty (`type: 'enum'`) and the config tiers by
    // the catalog row's own schema, which also supplies the value when no tier
    // set one — the environment is the only tier that can still carry an
    // unvalidated string. `--no-input` skips the env and config tiers
    // entirely, so it also skips their warnings.
    const approvalPolicy: TexraApprovalPolicy =
      init.globalArgs.approvalPolicy ??
      (noInput
        ? TEXRA_APPROVAL_POLICY_NO_INPUT_DEFAULT
        : ((yield* pickEnv(
            'TEXRA_APPROVAL_POLICY',
            parseTexraApprovalPolicy,
            configWarnings,
          )) ??
          readConfigSettingFrom<TexraApprovalPolicy>(
            config,
            TEXRA_APPROVAL_POLICY_CONFIG_KEY,
          )));
    const outputFormat: CliOutputFormat =
      init.globalArgs.outputFormat ??
      (yield* pickEnv(
        'TEXRA_OUTPUT_FORMAT',
        (format): CliOutputFormat | undefined =>
          (CLI_OUTPUT_FORMATS as readonly string[]).includes(format)
            ? (format as CliOutputFormat)
            : undefined,
        configWarnings,
      )) ??
      readConfigSettingFrom<CliOutputFormat>(
        config,
        CLI_OUTPUT_FORMAT_CONFIG_KEY,
      );
    let minimumLogLevel: MinimumLogLevel = 'Info';
    if (init.globalArgs.quiet) minimumLogLevel = 'None';
    else if (init.globalArgs.verbose) minimumLogLevel = 'Debug';
    return {
      storageRoot: init.storageRoot,
      cwd,
      mode: cliMode(init.globalArgs, ambient),
      outputFormat,
      approvalPolicy,
      quietLogs: init.globalArgs.quiet === true,
      minimumLogLevel,
      stdoutIsTty: ambient.stdoutIsTty,
      termIsDumb: ambient.termIsDumb === true,
      stderrIsTty: ambient.stderrIsTty,
      stdoutColorEnabled,
      stderrColorEnabled,
      commandName: resolveCliCommandName(readCliEntrypointPath()),
      // `readCliVersion` keeps its Promise face — `bin/texra.ts`, `root.ts`,
      // `version.ts` and the chat TUI read it too — so it is wrapped once
      // here. It answers `unknown` rather than failing.
      version: yield* Effect.promise(readCliVersion),
      resourcesPath: resolveCliResourcesPath(),
      config,
      configWarnings,
      configDegradations: degradations,
      envAgent: yield* envTier('TEXRA_AGENT'),
      envModel,
      skillSourceOptions: {
        includeInterop: init.globalArgs.includeInteropSkills === true,
        additionalPaths: init.globalArgs.skillSourcePaths ?? [],
      },
    };
  },
);
