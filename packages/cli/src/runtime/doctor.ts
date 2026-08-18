// Node imports
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

// Third-party imports
import { satisfies as semverSatisfies } from 'semver';

// Local imports
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  probeLatexToolchain,
  type LatexToolchainProbe,
} from '@latex/latexToolchain';
import {
  TELEMETRY_ENABLED_KEY,
  usageLoggingOptOut,
  type UsageLoggingOptOut,
} from '@telemetry/UsageLogService';
import {
  TEXRA_CLI_SUPPORTED_NODE_RANGE,
  TEXRA_CLI_SUPPORTED_NODE_RANGE_DISPLAY,
} from '@tools/externalToolDefs';
import { extractErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

// Local file imports
import { CliExitCode } from './exitCodes';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from './logSinks';
import { getCliModelAccessList } from './modelAccess';
import { createCliStyle } from './style';
import { getCliAuthProfile, type CliAuthProfile } from './supabaseAuth';
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

interface DoctorDependencies {
  readonly nodeVersion?: string;
  readonly authProfile?: () => Promise<CliAuthProfile>;
  readonly modelAccessList?: () => Promise<readonly CliModelAccess[]>;
  readonly latexToolchain?: () => Promise<LatexToolchainProbe>;
  readonly pathStat?: (filePath: string) => Promise<DirectoryStat>;
  readonly pathAccess?: (filePath: string, mode?: number) => Promise<void>;
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
    `Install Node ${TEXRA_CLI_SUPPORTED_NODE_RANGE_DISPLAY} before running TeXRA CLI.`,
  );
}

async function checkDirectory(
  id: string,
  name: string,
  dir: string,
  deps: ResolvedDoctorDependencies,
): Promise<DoctorCheck> {
  try {
    const info = await deps.pathStat(dir);
    if (!info.isDirectory()) {
      return fail(id, name, `${dir} exists but is not a directory.`);
    }
    await deps.pathAccess(dir, fsConstants.R_OK | fsConstants.W_OK);
    return pass(id, name, dir);
  } catch (error) {
    return failFromError(
      id,
      name,
      `${dir} is not readable and writable.`,
      error,
    );
  }
}

async function checkAuth(
  deps: ResolvedDoctorDependencies,
): Promise<DoctorCheck> {
  try {
    const profile = await deps.authProfile();
    if (profile.authenticated) {
      const accountLabel = profile.accountLabel || 'unknown';
      return pass('auth', 'TeXRA account', `Signed in as ${accountLabel}.`);
    }
    if (profile.sessionState === 'transient') {
      return warn(
        'auth',
        'TeXRA account',
        'The authentication service is temporarily unavailable.',
        'Your stored session is intact; retry once the service is reachable rather than signing in again.',
      );
    }
    return warn(
      'auth',
      'TeXRA account',
      'Not signed in.',
      'Run `texra login` for the hosted research-agent catalog, or add a provider API key with `texra setup`.',
    );
  } catch (error) {
    return failFromError(
      'auth',
      'TeXRA account',
      'Could not read TeXRA sign-in state.',
      error,
    );
  }
}

async function checkModels(
  deps: ResolvedDoctorDependencies,
): Promise<DoctorCheck> {
  try {
    const models = await deps.modelAccessList();
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
  } catch (error) {
    return failFromError(
      'models',
      'Models',
      'Could not compute model availability.',
      error,
    );
  }
}

async function checkLatex(
  deps: ResolvedDoctorDependencies,
): Promise<DoctorCheck[]> {
  try {
    const probe = await deps.latexToolchain();
    const checks: DoctorCheck[] = [];
    if (!probe.hasCompiler) {
      checks.push(
        fail(
          'latex.compiler',
          'LaTeX compiler',
          'No supported LaTeX compiler was found on PATH.',
          'Install latexmk, pdflatex, xelatex, or lualatex.',
        ),
      );
    }
    checks.push(
      ...probe.tools.map((tool) => {
        if (tool.installed) {
          return pass(`latex.${tool.name}`, `LaTeX ${tool.name}`, tool.purpose);
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
  } catch (error) {
    return [
      failFromError(
        'latex',
        'LaTeX toolchain',
        'Could not probe the LaTeX toolchain.',
        error,
      ),
    ];
  }
}

async function checkConfig(
  context: CliContext,
  deps: ResolvedDoctorDependencies,
): Promise<DoctorCheck> {
  if (!context.configFilePath) {
    return skip(
      'config',
      'Config',
      'No workspace CLI config file found.',
      'Optional defaults may be placed in .texra/config.json.',
    );
  }
  if (context.configWarnings.length > 0) {
    return warn(
      'config',
      'Config',
      `Workspace config has warnings: ${context.configFilePath}`,
      context.configWarnings.join(' '),
    );
  }
  try {
    await deps.pathAccess(context.configFilePath, fsConstants.R_OK);
    return pass(
      'config',
      'Config',
      `Workspace config: ${context.configFilePath}`,
    );
  } catch {
    return warn(
      'config',
      'Config',
      `Configured path is no longer readable: ${context.configFilePath}`,
    );
  }
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

function checkTelemetry(deps: ResolvedDoctorDependencies): DoctorCheck {
  let optOut: UsageLoggingOptOut;
  try {
    optOut = deps.usageLoggingOptOut();
  } catch (error) {
    return failFromError(
      'telemetry',
      'Usage logging',
      'Could not read the usage-logging setting.',
      error,
    );
  }

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
}

export async function buildDoctorReport(
  context: CliContext,
  deps: DoctorDependencies = {},
  initError?: unknown,
): Promise<DoctorReport> {
  const resolved = {
    nodeVersion: deps.nodeVersion ?? process.versions.node,
    authProfile: deps.authProfile ?? getCliAuthProfile,
    modelAccessList: deps.modelAccessList ?? getCliModelAccessList,
    latexToolchain: deps.latexToolchain ?? probeLatexToolchain,
    pathStat: deps.pathStat ?? stat,
    pathAccess: deps.pathAccess ?? access,
    usageLoggingOptOut: deps.usageLoggingOptOut ?? usageLoggingOptOut,
  };
  // A platform-init failure takes out every dependency-based check
  // (auth/models/telemetry), so surface it once here rather than as N
  // unrelated-looking failures. The checks that do not need the platform
  // (node, workspace, resources, LaTeX, config) still run.
  const sessionDependentChecks =
    initError == null
      ? [
          await checkAuth(resolved),
          await checkModels(resolved),
          checkTelemetry(resolved),
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
    await checkDirectory('workspace', 'Workspace', context.cwd, resolved),
    await checkDirectory(
      'resources',
      'Packaged resources',
      context.resourcesPath,
      resolved,
    ),
    ...sessionDependentChecks,
    ...(await checkLatex(resolved)),
    await checkConfig(context, resolved),
  ];
  return {
    ok: !checks.some((check) => check.status === 'fail'),
    checks,
  };
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
