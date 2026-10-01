// Third-party imports
import { Data, Effect, FileSystem, PlatformError } from 'effect';
import { satisfies as semverSatisfies } from 'semver';

// Local imports
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  probeLatexToolchain,
  type LatexToolchainProbe,
} from '@latex/latexToolchain';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { TELEMETRY_ENABLED_KEY } from '@shared/schemas';
import type { UsageLoggingOptOut } from '@telemetry/UsageLogService';
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
import { TEXRA_CLI_SUPPORTED_NODE_RANGE } from './terminalRequirements';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
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

/**
 * The failure of a probe this module drives itself: the LaTeX toolchain probe
 * and the telemetry consent read. It carries the value the foreign edge threw,
 * so the check that recovers from it renders the same hint it rendered when it
 * caught the rejection. The two probes the CLI root supplies are programs
 * already and keep their own `Error` failure.
 */
class DoctorProbeFailed extends Data.TaggedError('DoctorProbeFailed')<{
  readonly cause: unknown;
}> {}

const probeFailure = (cause: unknown): DoctorProbeFailed =>
  new DoctorProbeFailed({ cause });

/** The two probes a test overrides; both default to the real ones. */
interface DoctorEnvironment {
  readonly nodeVersion?: string;
  readonly latexToolchain?: Effect.Effect<
    LatexToolchainProbe,
    DoctorProbeFailed,
    ChildProcessSpawner
  >;
}

/**
 * The probes only the CLI root can build: platform init either failed
 * (`degraded`, which skips the checks that need it) or produced the stores
 * and runtime they read (`ready`).
 */
type DoctorInput = DoctorEnvironment &
  (
    | { readonly kind: 'degraded'; readonly initError: Error }
    | {
        readonly kind: 'ready';
        readonly modelAccessList: Effect.Effect<
          readonly CliModelAccess[],
          Error
        >;
        readonly usageLoggingOptOut: () => UsageLoggingOptOut;
      }
  );

type ReadyDoctorInput = Extract<DoctorInput, { kind: 'ready' }>;

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

/**
 * `read` is for directories the CLI only loads from: the packaged resources
 * root is root-owned after `sudo npm install -g`, the norm on Linux and WSL
 * with a system-wide Node prefix, so demanding write access fails a healthy
 * install.
 */
type DirectoryAccess = 'read' | 'readwrite';

function checkDirectory(
  id: string,
  name: string,
  dir: string,
  access: DirectoryAccess,
): Effect.Effect<DoctorCheck, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(dir);
    if (info.type !== 'Directory') {
      return fail(id, name, `${dir} exists but is not a directory.`);
    }
    yield* fs.access(dir, {
      readable: true,
      writable: access === 'readwrite',
    });
    return pass(id, name, dir);
  }).pipe(
    Effect.catch((failure: PlatformError.PlatformError) =>
      Effect.succeed(
        failFromError(
          id,
          name,
          access === 'readwrite'
            ? `${dir} is not readable and writable.`
            : `${dir} is not readable.`,
          failure.reason.cause ?? failure,
        ),
      ),
    ),
  );
}

function checkModels(deps: ReadyDoctorInput): Effect.Effect<DoctorCheck> {
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
        'Run `texra models list --all` to inspect access, sign in with `texra auth chatgpt login`, or add a provider API key with `texra setup`.',
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
  latexToolchain: NonNullable<DoctorEnvironment['latexToolchain']>,
): Effect.Effect<DoctorCheck[], never, ChildProcessSpawner> {
  return latexToolchain.pipe(
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
    Effect.catch((failure: DoctorProbeFailed) =>
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
): Effect.Effect<DoctorCheck, never, FileSystem.FileSystem> {
  // The project file the config provider layers over the user file. Its
  // readability is asked here rather than carried on the context: the provider
  // answers with values, and this check is the one caller that needs the path.
  const filePath = workspaceTexraConfigPath(context.cwd);
  return FileSystem.FileSystem.use((fs) =>
    fs.access(filePath, { readable: true }),
  ).pipe(
    Effect.as(true),
    // The probe's answer, not a swallowed failure: an unreadable file is
    // exactly the `skip` row below, and it is reported there.
    Effect.catch((_: PlatformError.PlatformError) => Effect.succeed(false)),
    Effect.map((readable) => {
      const warnings = [
        ...context.configDegradations,
        ...context.configWarnings,
      ];
      if (warnings.length > 0) {
        return warn(
          'config',
          'Config',
          `Workspace config has warnings: ${filePath}`,
          warnings.join(' '),
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
 * wording states what is in a record and how to switch it off.
 */

function checkTelemetry(deps: ReadyDoctorInput): Effect.Effect<DoctorCheck> {
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
        );
      }
      if (optOut?.source === 'setting') {
        return skip(
          'telemetry',
          'Usage logging',
          `Off (${TELEMETRY_ENABLED_KEY}).`,
        );
      }
      return check(
        'telemetry',
        'Usage logging',
        'pass',
        'On: anonymous model, agent, token counts and duration per round, with a random install ID (no account). No prompt, path or document text.',
        `Turn it off with TEXRA_NO_TELEMETRY=1 or DO_NOT_TRACK=1, or "${TELEMETRY_ENABLED_KEY}": false in ~/.texra/v1/global-storage/config.json.`,
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

type DoctorServices = FileSystem.FileSystem | ChildProcessSpawner;

export function buildDoctorReport(
  context: CliContext,
  input: DoctorInput,
): Effect.Effect<DoctorReport, never, DoctorServices> {
  return Effect.gen(function* () {
    // A platform-init failure takes out every dependency-based check
    // (models/telemetry), so surface it once here rather than as N
    // unrelated-looking failures. The checks that do not need the platform
    // (node, workspace, resources, LaTeX, config) still run.
    const sessionDependentChecks =
      input.kind === 'ready'
        ? [yield* checkModels(input), yield* checkTelemetry(input)]
        : [
            failFromError(
              'platform',
              'Platform init',
              'Could not initialize the TeXRA platform.',
              input.initError,
            ),
          ];
    const checks: DoctorCheck[] = [
      checkNode(input.nodeVersion ?? process.versions.node),
      yield* checkDirectory('workspace', 'Workspace', context.cwd, 'readwrite'),
      yield* checkDirectory(
        'resources',
        'Packaged resources',
        context.resourcesPath,
        'read',
      ),
      ...sessionDependentChecks,
      ...(yield* checkLatex(input.latexToolchain ?? probeLatexToolchain())),
      yield* checkConfig(context),
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

function formatDoctorText(
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
      const head = `${marker[check.status]} ${check.name}: ${redactEmailDiagnostics(check.message)}`;
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
  // Gate color on the stream the report is written to: a passing report goes
  // to stdout, a failing one to stderr (clig.dev). One stderr-keyed gate leaked
  // ANSI into `doctor | cat` and stripped color from `doctor 2>/dev/null`.
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
