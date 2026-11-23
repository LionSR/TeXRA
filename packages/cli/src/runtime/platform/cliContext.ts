import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Context,
  Effect,
  FileSystem,
  Config,
  Option,
  Schema,
  Semaphore,
  type LogLevel,
} from 'effect';

import {
  DatabaseOpenFailed,
  type SkillSourceOptions,
} from '@texra-ai/worldline';
import { Settings, type ConfigProvider } from '@texra-ai/worldline/plugins';
import { modelConfig } from '@texra-ai/llm';
import {
  meansAbsent,
  approvalPolicyEnv,
  canonicalizeWorkspaceRoot,
} from '@texra-ai/worldline/node';
import {
  APPROVAL_POLICY_SETTING,
  parseApprovalPolicy,
  launchPolicy,
  type ApprovalPolicy,
  type LaunchApproval,
  toErrorMessage,
} from '@texra-ai/worldline/schemas';
import { checkResourcesPath } from '@texra/controllers/texraProcessLayer';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import {
  CliOutputFormatSchema,
  type CliOutputFormat,
} from '@texra/shared/cliOutputFormat';
import { approvalPolicyLabel } from '@ui/copy/approvalPolicy';

import { loadCliStartupConfig } from './cliConfig';
import { interactiveTerminalFailure } from '../terminal/terminalRequirements';
import {
  CLI_OUTPUT_FORMAT_SETTING,
  TEXRA_SETTINGS,
} from '@texra/shared/settings/texraSettings';

type CliMode = 'headless' | 'interactive';

/** Fully normalized CLI state produced by {@link buildCliContext}. */
export interface CliContext {
  /** Root of the shared TeXRA storage directory, decided once at build. */
  readonly storageRoot: string;
  readonly cwd: string;
  readonly mode: CliMode;
  readonly outputFormat: CliOutputFormat;
  /** The policy this invocation's launches decide privileged actions
   *  under (`launchPolicy` over the configured one and
   *  `launchApproval({@link requestedApprovalPolicy})`); what the CLI's
   *  headless guards and resume hints read. */
  readonly approvalPolicy: ApprovalPolicy;
  /** The policy this invocation asked for itself (`--approval-policy`,
   *  `TEXRA_APPROVAL_POLICY`), absent when it follows the config: what a
   *  service launch sends to narrow its own task. */
  readonly requestedApprovalPolicy?: ApprovalPolicy;
  /**
   * The diagnostics emission threshold this process's runtime builds with,
   * decided once from argv — `--quiet` is `None`, `--verbose` is `Debug`,
   * otherwise `Warn` — because a terminal is the one surface with no live
   * level filter of its own. The process's diagnostic sink applies the same
   * level (`stderrDiagnosticSink`). A flag is exactly the kind of fact a
   * layer-build capture is for: it cannot change mid-process.
   */
  readonly minimumLogLevel: LogLevel.LogLevel;
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
   * installed as the workspace roots' config by `CliPlatform`: every
   * setting read after startup resolves through this same pair of stores.
   */
  readonly config: ConfigProvider;
  readonly configWarnings: readonly string[];
  /** The config problems `--quiet` does not hide; see `CliStartupConfig`. */
  readonly configDegradations: readonly string[];
  readonly envModel?: string;
  readonly skillSourceOptions: SkillSourceOptions;
}

/** Whether `--quiet` silenced this invocation's notes and warnings: its
 *  diagnostics threshold is `None`. */
export const isQuiet = (context: Pick<CliContext, 'minimumLogLevel'>) =>
  context.minimumLogLevel === 'None';

/**
 * The invocation a command's program runs for: its context, decided once
 * from argv, and the one prompt lane over this process's stdin.
 * `cliCommand` provides it, so the helpers that print a result or ask
 * the operator read it here instead of taking the context as a parameter.
 */
export class CliInvocation extends Context.Service<
  CliInvocation,
  {
    readonly context: CliContext;
    /** Run a prompt alone on stdin, so two prompts never read it at once. */
    readonly onPromptLane: <A, E, R>(
      self: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()('@texra-ai/cli/CliInvocation') {}

/** Run `self` as one invocation of `context`. */
export const provideCliInvocation = (context: CliContext) =>
  Effect.provideService(CliInvocation, {
    context,
    onPromptLane: Semaphore.makeUnsafe(1).withPermit,
  });

export class CliUsageError extends Schema.TaggedError<CliUsageError>()(
  'CliUsageError',
  { message: Schema.String },
) {}

/** Fail the command with a usage error. */
export const failUsage = (message: string) =>
  Effect.fail(new CliUsageError({ message }));

interface CliAmbientState {
  readonly isCi: boolean;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
  readonly termIsDumb: boolean;
  readonly stdoutColorEnabled: boolean;
  readonly stderrColorEnabled: boolean;
}

/**
 * Resolve whether ANSI color may be emitted on a given stream, reusing the
 * conventional override precedence picocolors' own `isColorSupported` honors:
 *
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
function resolveStreamColor(streamIsTty: boolean): boolean {
  const env = process.env;
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
  const stdoutColorEnabled = resolveStreamColor(stdoutIsTty);
  const stderrColorEnabled = resolveStreamColor(stderrIsTty);
  cachedAmbient = {
    isCi: Boolean(process.env.CI),
    stdinIsTty,
    stdoutIsTty,
    stderrIsTty,
    termIsDumb: process.env.TERM === 'dumb',
    stdoutColorEnabled,
    stderrColorEnabled,
  };
  return cachedAmbient;
}

export function cliEnvValue(key: string): string | undefined {
  return process.env[key];
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

const CliPackageManifest = Schema.Struct({
  version: Schema.NonEmptyString,
  bugs: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.String) })),
});
type CliPackageManifest = typeof CliPackageManifest.Type;

const decodeCliPackageManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(CliPackageManifest),
);

/**
 * The CLI's `package.json` facts, read once and synchronously: needed before
 * any runtime exists (`--version`, the process-runtime build, the crash
 * report), so it has no Promise or Effect face to keep in step with. Every
 * bundle carries them, stamped by `scripts/build-bundle.mjs`; a source run
 * reads the package's own manifest, three directories above this module. A
 * manifest that does not decode is a broken build or checkout, and throws.
 */
let cachedManifest: CliPackageManifest | undefined;
function loadCliPackageManifest(): CliPackageManifest {
  cachedManifest ??= decodeCliPackageManifest(
    process.env.TEXRA_CLI_MANIFEST ??
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  return cachedManifest;
}

export function readCliVersion(): string {
  return loadCliPackageManifest().version;
}

/**
 * This build's resources directory. Every bundle `scripts/build-bundle.mjs`
 * writes sits one directory below its `resources/` (`dist/bin/` beside
 * `dist/resources/`, the service's `serve/` beside the extension's and the
 * desktop app's `resources/`), and the build stamps that location; a source
 * run reads the extension package's own tree, four directories above this
 * module. Fails by its path when it holds no bundled plugin resources
 * ({@link checkResourcesPath}).
 */
export const resolveCliResourcesPath = Effect.fn(
  'cliContext.resolveCliResourcesPath',
)(function* () {
  const resources = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    process.env.TEXRA_CLI_RESOURCES ?? '../../../../extension/resources',
  );
  return yield* checkResourcesPath(resources);
});

/**
 * The follow-up line appended to the top-level crash message pointing users at
 * the issue tracker, the `bugs.url` the CLI's `package.json` declares (read
 * from the manifest rather than hard-coded so it tracks the published
 * metadata). Returns `undefined` for usage errors (so the exit-2 path stays
 * clean), for a store this process could not open (a remote mount, a store a
 * newer build wrote: the message says what to do), or when no tracker URL is
 * configured — only an UNEXPECTED crash with a known `bugs.url` gets the
 * report prompt. It runs in the last-resort crash handler, so it never
 * throws: a manifest that does not decode is the crash being reported (its
 * message is already on stderr), and the report line is left off.
 */
export function formatCrashReportLine(error: unknown): string | undefined {
  let bugsUrl: string | undefined;
  try {
    bugsUrl = loadCliPackageManifest().bugs?.url;
  } catch {
    return undefined;
  }
  if (
    error instanceof CliUsageError ||
    error instanceof DatabaseOpenFailed ||
    !bugsUrl
  ) {
    return undefined;
  }
  return `This looks like a bug — please report it at ${bugsUrl} (include the command and the message above).`;
}

export interface CliGlobalArgs {
  readonly print?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  readonly cwd?: string;
  readonly outputFormat?: CliOutputFormat;
  readonly approvalPolicy?: ApprovalPolicy;
  /** `--no-color`: force-disable ANSI color on every stream. */
  readonly noColor?: boolean;
  /**
   * `--no-input`: the conventional "disable all prompts" switch. Forces
   * headless mode, where nothing prompts; the approval policy is decided as
   * for any other invocation.
   */
  readonly noInput?: boolean;
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

/**
 * Whether this invocation can run an interactive terminal session: the
 * mode `cliMode` decides, and the terminal checks `texra chat` refuses on.
 * Bare `texra` routes by this, so it never starts a chat that would refuse.
 */
export function isInteractiveCli(
  globalArgs: CliGlobalArgs,
  ambient: CliAmbientState,
): boolean {
  return (
    interactiveTerminalFailure({
      mode: cliMode(globalArgs, ambient),
      stdoutIsTty: ambient.stdoutIsTty,
      termIsDumb: ambient.termIsDumb,
    }) === undefined
  );
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
  Effect.map(Config.String(key).pipe(Config.option, Effect.orDie), (raw) => {
    const value = Option.getOrUndefined(raw)?.trim();
    return value === '' ? undefined : value;
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
  if (typeof cwdFlag !== 'string' || cwdFlag.trim() === '') {
    return canonicalizeWorkspaceRoot(readCliCwd());
  }
  const requested = path.resolve(cwdFlag);
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(requested).pipe(
    Effect.mapError((error) =>
      meansAbsent(error)
        ? new CliUsageError({
            message: `--cwd: path does not exist: ${requested}`,
          })
        : new CliUsageError({
            message: `--cwd: cannot access ${requested}: ${toErrorMessage(error)}`,
          }),
    ),
  );
  if (info.type !== 'Directory') {
    return yield* new CliUsageError({
      message: `--cwd: not a directory: ${requested}`,
    });
  }
  return canonicalizeWorkspaceRoot(requested);
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
    const storageRoot = init.storageRoot ?? defaultNodeStorageRoot();
    // The project file over the user file, resolved by the same
    // `JsonConfigProvider` that `roots.config` gives the extension and desktop
    // hosts — and, from `CliPlatform` on, this host too. This is the
    // pre-runtime open, which is why it goes through `loadCliStartupConfig`
    // rather than the process runtime.
    const { config, warnings, degradations } = yield* loadCliStartupConfig(
      cwd,
      storageRoot,
    );
    const configWarnings = [...warnings];
    const envModel = yield* pickEnv(
      'TEXRA_MODEL',
      (model) => (modelConfig(model) ? model : undefined),
      configWarnings,
    );
    // `--no-color` is an explicit force-disable: layer it onto the ambient
    // per-stream gates rather than recomputing them, so `NO_COLOR`/
    // `FORCE_COLOR`/TTY precedence stays in one place (`resolveStreamColor`).
    const noColor = init.globalArgs.noColor === true;
    const stdoutColorEnabled = !noColor && ambient.stdoutColorEnabled;
    const stderrColorEnabled = !noColor && ambient.stderrColorEnabled;
    // The flag is validated by its parse (`Flag.Literals`) and the config tiers by
    // the catalog row's own schema, which also supplies the value when no tier
    // set one — the environment is the only tier that can still carry an
    // unvalidated string.
    const requestedApprovalPolicy: ApprovalPolicy | undefined =
      init.globalArgs.approvalPolicy ??
      (yield* pickEnv(
        approvalPolicyEnv(TEXRA_SETTINGS.catalog.namespace),
        parseApprovalPolicy,
        configWarnings,
      ));
    const approvalPolicy = effectiveApprovalPolicy(
      requestedApprovalPolicy,
      projectApprovalPolicy(config),
    );
    const outputFormat: CliOutputFormat =
      init.globalArgs.outputFormat ??
      (yield* pickEnv(
        'TEXRA_OUTPUT_FORMAT',
        (format) =>
          Schema.is(CliOutputFormatSchema)(format) ? format : undefined,
        configWarnings,
      )) ??
      Settings.getConfig(config, CLI_OUTPUT_FORMAT_SETTING);
    let minimumLogLevel: LogLevel.LogLevel = 'Warn';
    if (init.globalArgs.quiet) minimumLogLevel = 'None';
    else if (init.globalArgs.verbose) minimumLogLevel = 'Debug';
    return {
      storageRoot,
      cwd,
      mode: cliMode(init.globalArgs, ambient),
      outputFormat,
      approvalPolicy,
      ...(requestedApprovalPolicy !== undefined && { requestedApprovalPolicy }),
      minimumLogLevel,
      stdoutIsTty: ambient.stdoutIsTty,
      termIsDumb: ambient.termIsDumb,
      stderrIsTty: ambient.stderrIsTty,
      stdoutColorEnabled,
      stderrColorEnabled,
      commandName:
        path.basename(readCliEntrypointPath()).toLowerCase() === 'texra-local'
          ? 'texra-local'
          : 'texra',
      version: readCliVersion(),
      resourcesPath: yield* resolveCliResourcesPath(),
      config,
      configWarnings,
      configDegradations: degradations,
      envModel,
      skillSourceOptions: {
        additionalPaths: init.globalArgs.skillSourcePaths ?? [],
      },
    };
  },
);

/**
 * What a launch asks for with the policy this invocation requested
 * explicitly (its flag, `TEXRA_APPROVAL_POLICY`, a chat's `/approval`); none
 * follows the project's. An explicit Auto-approve is an
 * Auto-approve launch; any other policy is the limit the launch narrows its
 * run to. Local and service launches alike.
 */
export function launchApproval(
  requested: ApprovalPolicy | undefined,
): LaunchApproval | undefined {
  return requested === 'yolo' ? 'autoApprove' : requested;
}

/** The project's persisted approval policy, as the session reads it at each
 *  decision. */
export function projectApprovalPolicy(config: ConfigProvider): ApprovalPolicy {
  return Settings.getConfig(config, APPROVAL_POLICY_SETTING);
}

/** The policy a launch decides privileged actions under: the harness's
 *  rule (`launchPolicy`) over what this invocation asked for. */
export function effectiveApprovalPolicy(
  requested: ApprovalPolicy | undefined,
  configured: ApprovalPolicy,
): ApprovalPolicy {
  return launchPolicy(configured, launchApproval(requested));
}

/** Why a request is not what a launch decides privileged actions under: one
 *  more permissive than the project's policy cannot widen it, and
 *  Auto-approve, which widens its own task, cannot override Block. */
export function launchApprovalNotice(
  requested: ApprovalPolicy | undefined,
  configured: ApprovalPolicy,
): string | undefined {
  if (
    requested === undefined ||
    effectiveApprovalPolicy(requested, configured) === requested
  )
    return undefined;
  const change =
    'Change the project policy with /config in `texra chat` or in Settings.';
  return requested === 'yolo'
    ? `Auto-approve cannot override the project's Block policy. ${change}`
    : `Using project policy (${approvalPolicyLabel(configured)}) instead of ${approvalPolicyLabel(requested)} — per-command flags can only tighten it. ${change}`;
}
