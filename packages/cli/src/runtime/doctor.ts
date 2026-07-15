// Standard library imports
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

// Third-party imports
import { satisfies as semverSatisfies } from 'semver';

// Local imports - platform
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';

// Local imports - CLI schemas
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';

// Local imports - LaTeX
import {
  probeLatexToolchain,
  type LatexToolchainProbe,
} from '@latex/latexToolchain';
import {
  TEXRA_CLI_SUPPORTED_NODE_RANGE,
  TEXRA_CLI_SUPPORTED_NODE_RANGE_DISPLAY,
} from '@shared/constants/cliRuntime';
import { extractErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - CLI runtime
import { CliExitCode } from './exitCodes';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from './logSinks';
import { getCliModelAccessList } from './modelAccess';
import { createCliStyle } from './style';
import { getCliAuthProfile } from './supabaseAuth';

// Type imports - CLI runtime
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

interface CliAuthProfile {
  readonly authenticated: boolean;
  readonly accountLabel?: string;
  readonly tier?: string;
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
}

type ResolvedDoctorDependencies = Required<DoctorDependencies>;

const EMAIL_LIKE_DIAGNOSTIC_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function isSupportedNodeVersion(version: string): boolean {
  return semverSatisfies(version, TEXRA_CLI_SUPPORTED_NODE_RANGE, {
    loose: true,
  });
}

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
  if (isSupportedNodeVersion(version)) {
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
      const tier = profile.tier ? `, ${profile.tier}` : '';
      const accountLabel = profile.accountLabel || 'unknown';
      return pass(
        'auth',
        'Included access',
        `Signed in as ${accountLabel}${tier}.`,
      );
    }
    return warn(
      'auth',
      'Included access',
      'Not signed in for included model access.',
      'Run `texra login` for included access, or add a provider API key with `texra setup` before using `--api-mode personal`.',
    );
  } catch (error) {
    return failFromError(
      'auth',
      'Included access',
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

async function checkConfig(context: CliContext): Promise<DoctorCheck> {
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
  const workspaceConfig = workspaceTexraConfigPath(context.cwd);
  try {
    await access(workspaceConfig, fsConstants.R_OK);
    return pass('config', 'Config', `Workspace config: ${workspaceConfig}`);
  } catch {
    return warn(
      'config',
      'Config',
      `Configured path is no longer readable: ${context.configFilePath}`,
    );
  }
}

export async function buildDoctorReport(
  context: CliContext,
  deps: DoctorDependencies = {},
): Promise<DoctorReport> {
  const resolved = {
    nodeVersion: deps.nodeVersion ?? process.versions.node,
    authProfile: deps.authProfile ?? getCliAuthProfile,
    modelAccessList: deps.modelAccessList ?? getCliModelAccessList,
    latexToolchain: deps.latexToolchain ?? probeLatexToolchain,
    pathStat: deps.pathStat ?? stat,
    pathAccess: deps.pathAccess ?? access,
  };
  const checks: DoctorCheck[] = [
    checkNode(resolved.nodeVersion),
    await checkDirectory('workspace', 'Workspace', context.cwd, resolved),
    await checkDirectory(
      'resources',
      'Packaged resources',
      context.resourcesPath,
      resolved,
    ),
    await checkAuth(resolved),
    await checkModels(resolved),
    ...(await checkLatex(resolved)),
    await checkConfig(context),
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
  const stdoutColorEnabled = context.stdoutColorEnabled;
  const stderrColorEnabled = context.stderrColorEnabled;
  const colorEnabled = report.ok ? stdoutColorEnabled : stderrColorEnabled;
  const text = formatDoctorText(report, createCliStyle(colorEnabled));
  if (report.ok) {
    writeTextStdout(text);
  } else {
    writeTextStderr(text);
  }
}
