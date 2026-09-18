// Node imports
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

// Third-party imports
import { Data, Effect } from 'effect';
import { satisfies as semverSatisfies } from 'semver';

// Local imports
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  probeLatexToolchain,
  type LatexToolchainProbe,
} from '@latex/latexToolchain';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { TELEMETRY_ENABLED_KEY } from '@shared/schemas';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
import type { UsageLoggingOptOut } from '@telemetry/UsageLogService';
import { TEXRA_CLI_SUPPORTED_NODE_RANGE } from '@tools/externalToolDefs';
import { extractErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

// Local file imports
import { CliExitCode } from './exitCodes';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from './logSinks';
import { createCliStyle } from './style';
import type { CliAuthProfile } from './supabaseAuth';
import type { CliContext } from './cliContext';
import type { CliStyle } from './style';
import type { CliModelAccess } from './modelAccess';

type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorCheck {
  readonly id: string;
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly message: string;
  readonly hint?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface DirectoryStat {
  isDirectory(): boolean;
}

/**
 * The failure of a probe this module drives itself: the two Node `fs` reads,
 * the LaTeX toolchain probe and the telemetry consent read. It carries the
 * value the foreign edge threw, so the check that recovers from it renders the
 * same hint it rendered when it caught the rejection. The two probes the CLI
 * root supplies are programs already and keep their own `Error` failure.
 */
class DoctorProbeFailed extends Data.TaggedError('DoctorProbeFailed')<{
  readonly cause: unknown;
}> {}

const probeFailure = (cause: unknown): DoctorProbeFailed =>
  new DoctorProbeFailed({ cause });

interface DoctorDependencies {
  readonly nodeVersion?: string;
  /**
   * The account read the CLI root hands over: the program itself, yielded by
   * the auth check below rather than settled into a Promise first — the same
   * contract as `modelAccessList`.
   */
  readonly authProfile?: Effect.Effect<CliAuthProfile, Error>;
  /**
   * Model availability needs the process stores, which only the CLI root
   * holds, so this is the one probe the caller supplies rather than one this
   * module defaults to. It is absent exactly when platform init failed, and
   * `initError` then skips the model check that would read it.
   */
  readonly modelAccessList?: Effect.Effect<readonly CliModelAccess[], Error>;
  readonly latexToolchain?: Effect.Effect<
    LatexToolchainProbe,
    DoctorProbeFailed
  >;
  readonly pathStat?: (
    filePath: string,
  ) => Effect.Effect<DirectoryStat, DoctorProbeFailed>;
  readonly pathAccess?: (
    filePath: string,
    mode?: number,
  ) => Effect.Effect<void, DoctorProbeFailed>;
  readonly usageLoggingOptOut?: () => UsageLoggingOptOut;
}

type ResolvedDoctorDependencies = Required<DoctorDependencies>;

const EMAIL_LIKE_DIAGNOSTIC_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function maskIdentifierPart(part: string): string {
  return part ? `${part.at(0)}***` : '***';
}

function redactEmailDiagnosticValue(value: string): string {
  const atIndex = value.indexOf('@');
  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  const domainParts = domain.split('.');
  const suffix = domainParts.length > 1 ? domainParts.at(-1) : undefined;
  const domainName = suffix ? domainParts.slice(0, -1).join('.') : domain;
  const maskedDomain = suffix
    ? `${maskIdentifierPart(domainName)}.${suffix}`
    : maskIdentifierPart(domainName);
  return `${maskIdentifierPart(localPart)}@${maskedDomain}`;
}

function redactEmailDiagnostics(text: string): string {
  return text.replaceAll(EMAIL_LIKE_DIAGNOSTIC_PATTERN, (value) =>
    redactEmailDiagnosticValue(value),
  );
}

function formatDoctorMessage(check: DoctorCheck): string {
  return check.id === 'auth'
    ? check.message
    : redactEmailDiagnostics(check.message);
}

function check(
  id: string,
  name: string,
  status: DoctorCheckStatus,
  message: string,
  hint?: string,
): DoctorCheck {
  return { id, name, status, message, hint };
}

function pass(id: string, name: string, message: string): DoctorCheck {
  return check(id, name, 'pass', message);
}

function warn(
  id: string,
  name: string,
  message: string,
  hint?: string,
): DoctorCheck {
  return check(id, name, 'warn', message, hint);
}

function fail(
  id: string,
  name: string,
  message: string,
  hint?: string,
): DoctorCheck {
  return check(id, name, 'fail', message, hint);
}

function skip(
  id: string,
  name: string,
  message: string,
  hint?: string,
): DoctorCheck {
  return check(id, name, 'skip', message, hint);
}

function failFromError(
  id: string,
  name: string,
  message: string,
  error: unknown,
): DoctorCheck {
  return fail(id, name, message, extractErrorMessage(error));
}

function checkNode(version: string): DoctorCheck {
  if (
    semverSatisfies(version, TEXRA_CLI_SUPPORTED_NODE_RANGE, { loose: true })
  ) {
    return pass('node', 'Node.js', `Node ${version}`);
  }
  return fail(
    'node',
    'Node.js',
    `Node ${version || 'unknown'} is outside the supported range.`,
    `Install Node ${TEXRA_CLI_SUPPORTED_NODE_RANGE} before running TeXRA CLI.`,
  );
}

function checkDirectory(
  id: string,
  name: string,
  dir: string,
  deps: ResolvedDoctorDependencies,
): Effect.Effect<DoctorCheck> {
  return Effect.gen(function* () {
    const info = yield* deps.pathStat(dir);
    if (!info.isDirectory()) {
      return fail(id, name, `${dir} exists but is not a directory.`);
    }
    yield* deps.pathAccess(dir, fsConstants.R_OK | fsConstants.W_OK);
    return pass(id, name, dir);
  }).pipe(
    Effect.catch((failure) =>
      Effect.succeed(
        failFromError(
          id,
          name,
          `${dir} is not readable and writable.`,
          failure.cause,
        ),
      ),
    ),
  );
}

function checkAuth(
  deps: ResolvedDoctorDependencies,
): Effect.Effect<DoctorCheck> {
  return deps.authProfile.pipe(
    Effect.map((profile) => {
      if (profile.authenticated) {
        const accountLabel = profile.accountLabel || 'unknown';
        return pass(
          'auth',
          RESEARCHER_ACCESS.label,
          `Signed in as ${accountLabel}.`,
        );
      }
      if (profile.sessionState === 'transient') {
        return warn(
          'auth',
          RESEARCHER_ACCESS.label,
          'The authentication service is temporarily unavailable.',
          'Your stored session is intact; retry once the service is reachable rather than signing in again.',
        );
      }
      return warn(
        'auth',
        RESEARCHER_ACCESS.label,
        'Not signed in.',
        'Run `texra login` for the hosted research-agent catalog, or add a provider API key with `texra setup`.',
      );
    }),
    Effect.catch((error) =>
      Effect.succeed(
        failFromError(
          'auth',
          RESEARCHER_ACCESS.label,
          `Could not read ${RESEARCHER_ACCESS.label} sign-in state.`,
          error,
        ),
      ),
    ),
  );
}

function checkModels(
  deps: ResolvedDoctorDependencies,
): Effect.Effect<DoctorCheck> {
  return deps.modelAccessList.pipe(
    Effect.map((models) => {
      const available = models.filter((entry) => entry.available);
      if (available.length > 0) {
        return pass(
          'models',
          'Models',
          `${formatResultCount(available.length, 'model')} available.`,
        );
      }
      return fail(
        'models',
        'Models',
        'No model is currently available.',
        'Run `texra models list --all` to inspect access, sign in with `texra login`, or add a provider API key with `texra setup`.',
      );
    }),
    Effect.catch((error) =>
      Effect.succeed(
        failFromError(
          'models',
          'Models',
          'Could not compute model availability.',
          error,
        ),
      ),
    ),
  );
}

function checkLatex(
  deps: ResolvedDoctorDependencies,
): Effect.Effect<DoctorCheck[]> {
  return deps.latexToolchain.pipe(
    Effect.map((probe) => {
      const checks: DoctorCheck[] = [];
      if (!probe.hasCompiler) {
        checks.push(
          fail(
            'latex.compiler',
            'LaTeX compiler',
            'No supported LaTeX compiler was found on PATH.',
            'Install latexmk or pdflatex.',
          ),
        );
      }
      checks.push(
        ...probe.tools.map((tool) => {
          if (tool.installed) {
            return pass(
              `latex.${tool.name}`,
              `LaTeX ${tool.name}`,
              tool.purpose,
            );
          }
          const status = tool.required ? fail : warn;
          return status(
            `latex.${tool.name}`,
            `LaTeX ${tool.name}`,
            `${tool.name} was not found on PATH.`,
            `Install ${tool.name} or a TeX distribution that provides it.`,
          );
        }),
      );
      return checks;
    }),
    Effect.catch((failure) =>
      Effect.succeed([
        failFromError(
          'latex',
          'LaTeX toolchain',
          'Could not probe the LaTeX toolchain.',
          failure.cause,
        ),
      ]),
    ),
  );
}

function checkConfig(
  context: CliContext,
  deps: ResolvedDoctorDependencies,
): Effect.Effect<DoctorCheck> {
  // The project file the config provider layers over the user file. Its
  // readability is asked here rather than carried on the context: the provider
  // answers with values, and this check is the one caller that needs the path.
  const filePath = workspaceTexraConfigPath(context.cwd);
  return deps.pathAccess(filePath, fsConstants.R_OK).pipe(
    Effect.as(true),
    // The probe's answer, not a swallowed failure: an unreadable file is
    // exactly the `skip` row below, and it is reported there.
    Effect.catch(() => Effect.succeed(false)),
    Effect.map((readable) => {
      if (context.configWarnings.length > 0) {
        return warn(
          'config',
          'Config',
          `Workspace config has warnings: ${filePath}`,
          context.configWarnings.join(' '),
        );
      }
      if (!readable) {
        return skip(
          'config',
          'Config',
          'No readable workspace CLI config file found.',
          'Optional defaults may be placed in .texra/config.json.',
        );
      }
      return pass('config', 'Config', `Workspace config: ${filePath}`);
    }),
  );
}

/**
 * What TeXRA reports about the user's own usage, and how to stop it.
 *
 * `doctor` is where a user goes to see what the CLI is doing, and usage logging
 * is the one thing it does that leaves the machine without being asked for. The
 * wording states the two facts that decide whether someone cares: what is in a
 * record, and what stays on after opting out.
 */
const USAGE_STILL_RECORDED_NOTE =
  'Rounds that used a subscription are still recorded, because they meter your plan.';

function checkTelemetry(
  deps: ResolvedDoctorDependencies,
): Effect.Effect<DoctorCheck> {
  return Effect.try({
    try: (): UsageLoggingOptOut => deps.usageLoggingOptOut(),
    catch: probeFailure,
  }).pipe(
    Effect.map((optOut) => {
      if (optOut?.source === 'environment') {
        return skip(
          'telemetry',
          'Usage logging',
          `Off (${optOut.envVar} is set).`,
          USAGE_STILL_RECORDED_NOTE,
        );
      }
      if (optOut?.source === 'setting') {
        return skip(
          'telemetry',
          'Usage logging',
          `Off (${TELEMETRY_ENABLED_KEY}).`,
          USAGE_STILL_RECORDED_NOTE,
        );
      }
      return check(
        'telemetry',
        'Usage logging',
        'pass',
        'On: model, token counts, and cost per round, sent while signed in. No prompt or document text.',
        `Turn it off with TEXRA_NO_TELEMETRY=1, or "${TELEMETRY_ENABLED_KEY}": false in .texra/config.json.`,
      );
    }),
    Effect.catch((failure) =>
      Effect.succeed(
        failFromError(
          'telemetry',
          'Usage logging',
          'Could not read the usage-logging setting.',
          failure.cause,
        ),
      ),
    ),
  );
}

/**
 * The foreign edges this module drives itself, each wrapped exactly once: a
 * rejection becomes a {@link DoctorProbeFailed} carrying what was thrown, and
 * the check that recovers from it renders that value as its hint.
 */
const statPath = (
  filePath: string,
): Effect.Effect<DirectoryStat, DoctorProbeFailed> =>
  Effect.tryPromise({ try: () => stat(filePath), catch: probeFailure });

const accessPath = (
  filePath: string,
  mode?: number,
): Effect.Effect<void, DoctorProbeFailed> =>
  Effect.tryPromise({ try: () => access(filePath, mode), catch: probeFailure });

const latexToolchainProbe: Effect.Effect<
  LatexToolchainProbe,
  DoctorProbeFailed
> = Effect.tryPromise({ try: probeLatexToolchain, catch: probeFailure });

/**
 * Stand-in for the one probe this module cannot build for itself. Unreachable:
 * the caller omits `modelAccessList` only when platform init failed, and that
 * sets `initError`, which skips the model check before it is ever called.
 */
const missingModelAccessProbe: Effect.Effect<never, Error> = Effect.fail(
  new Error(
    'Model availability needs the platform stores the CLI root holds; doctor was given neither a model probe nor a platform init error.',
  ),
);

/**
 * Same contract for the account read: the CLI root hands over the account
 * program, or reports a platform init error.
 */
const missingAuthProfileProbe: Effect.Effect<never, Error> = Effect.fail(
  new Error(
    'The account check needs the process runtime the CLI root holds; doctor was given neither an auth probe nor a platform init error.',
  ),
);

/**
 * Same contract for the telemetry consent read: the CLI root passes the
 * opt-out over its platform roots' config, or a platform init error.
 */
const missingUsageLoggingOptOut = (): never => {
  throw new Error(
    'Telemetry consent needs the workspace configuration the CLI root holds; doctor was given neither a consent probe nor a platform init error.',
  );
};

export function buildDoctorReport(
  context: CliContext,
  deps: DoctorDependencies = {},
  initError?: Error,
): Effect.Effect<DoctorReport> {
  const resolved = {
    nodeVersion: deps.nodeVersion ?? process.versions.node,
    authProfile: deps.authProfile ?? missingAuthProfileProbe,
    modelAccessList: deps.modelAccessList ?? missingModelAccessProbe,
    latexToolchain: deps.latexToolchain ?? latexToolchainProbe,
    pathStat: deps.pathStat ?? statPath,
    pathAccess: deps.pathAccess ?? accessPath,
    usageLoggingOptOut: deps.usageLoggingOptOut ?? missingUsageLoggingOptOut,
  };
  return Effect.gen(function* () {
    // A platform-init failure takes out every dependency-based check
    // (auth/models/telemetry), so surface it once here rather than as N
    // unrelated-looking failures. The checks that do not need the platform
    // (node, workspace, resources, LaTeX, config) still run.
    const sessionDependentChecks =
      initError == null
        ? [
            yield* checkAuth(resolved),
            yield* checkModels(resolved),
            yield* checkTelemetry(resolved),
          ]
        : [
            failFromError(
              'platform',
              'Platform init',
              'Could not initialize the TeXRA platform.',
              initError,
            ),
          ];
    const checks: DoctorCheck[] = [
      checkNode(resolved.nodeVersion),
      yield* checkDirectory('workspace', 'Workspace', context.cwd, resolved),
      yield* checkDirectory(
        'resources',
        'Packaged resources',
        context.resourcesPath,
        resolved,
      ),
      ...sessionDependentChecks,
      ...(yield* checkLatex(resolved)),
      yield* checkConfig(context, resolved),
    ];
    return {
      ok: !checks.some((check) => check.status === 'fail'),
      checks,
    };
  });
}

export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? CliExitCode.Success : CliExitCode.ModelOrNetworkError;
}

export function formatDoctorText(
  report: DoctorReport,
  style: CliStyle = createCliStyle(false),
): string {
  const marker: Record<DoctorCheckStatus, string> = {
    pass: style.success('PASS'),
    warn: style.warn('WARN'),
    fail: style.error('FAIL'),
    skip: style.muted('SKIP'),
  };
  return report.checks
    .map((check) => {
      const head = `${marker[check.status]} ${check.name}: ${formatDoctorMessage(check)}`;
      return check.hint
        ? `${head}\n     ${style.muted(redactEmailDiagnostics(check.hint))}`
        : head;
    })
    .join('\n');
}

export function doctorNdjsonRecords(
  report: DoctorReport,
  ts = new Date().toISOString(),
): readonly CliNdjsonRecord[] {
  return [
    ...report.checks.map((check): CliNdjsonRecord => ({
      kind: 'doctor-check',
      ts,
      ...check,
    })),
    { kind: 'doctor-summary', ts, ok: report.ok } satisfies CliNdjsonRecord,
  ];
}

export function writeDoctorReport(
  context: CliContext,
  report: DoctorReport,
): void {
  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(report, null, 2));
    return;
  }
  if (context.outputFormat === 'ndjson') {
    for (const record of doctorNdjsonRecords(report)) {
      writeNdjsonStdout(record);
    }
    return;
  }
  // Gate color on the stream the report is actually written to: a passing
  // report goes to stdout, a failing one to stderr (clig.dev). Using a single
  // stderr-keyed gate leaked ANSI into `doctor | cat` and stripped color from
  // `doctor 2>/dev/null` on a TTY.
  const colorEnabled = report.ok
    ? context.stdoutColorEnabled
    : context.stderrColorEnabled;
  const text = formatDoctorText(report, createCliStyle(colorEnabled));
  if (report.ok) {
    writeTextStdout(text);
  } else {
    writeTextStderr(text);
  }
}
