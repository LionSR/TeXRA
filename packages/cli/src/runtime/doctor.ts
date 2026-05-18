// Standard library imports
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

// Local imports - LaTeX
import {
  probeLatexToolchain,
  type LatexToolchainProbe,
} from '@latex/latexToolchain';

// Local imports - CLI runtime
import { workspaceCliConfigPath } from './cliConfig';
import { CliExitCode } from './exitCodes';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from './logSinks';
import { getCliModelAccessList } from './modelAccess';
import { getCliStoredAuthProfile } from './supabaseAuth';

// Type imports - CLI runtime
import type { CliContext } from './cliContext';
import type { CliModelAccess } from './modelAccess';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
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

const MIN_NODE_MAJOR = 22;

function pass(id: string, name: string, message: string): DoctorCheck {
  return { id, name, status: 'pass', message };
}

function warn(
  id: string,
  name: string,
  message: string,
  hint?: string,
): DoctorCheck {
  return { id, name, status: 'warn', message, hint };
}

function fail(
  id: string,
  name: string,
  message: string,
  hint?: string,
): DoctorCheck {
  return { id, name, status: 'fail', message, hint };
}

function skip(
  id: string,
  name: string,
  message: string,
  hint?: string,
): DoctorCheck {
  return { id, name, status: 'skip', message, hint };
}

function checkNode(version: string): DoctorCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return pass('node', 'Node.js', `Node ${version}`);
  }
  return fail(
    'node',
    'Node.js',
    `Node ${version || 'unknown'} is below the supported version.`,
    `Install Node ${MIN_NODE_MAJOR} or newer.`,
  );
}

async function checkDirectory(
  id: string,
  name: string,
  dir: string,
  deps: Required<Pick<DoctorDependencies, 'pathStat' | 'pathAccess'>>,
): Promise<DoctorCheck> {
  try {
    const info = await deps.pathStat(dir);
    if (!info.isDirectory()) {
      return fail(id, name, `${dir} exists but is not a directory.`);
    }
    await deps.pathAccess(dir, fsConstants.R_OK | fsConstants.W_OK);
    return pass(id, name, dir);
  } catch (error) {
    return fail(
      id,
      name,
      `${dir} is not readable and writable.`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

async function checkAuth(
  deps: Required<Pick<DoctorDependencies, 'authProfile'>>,
): Promise<DoctorCheck> {
  try {
    const profile = await deps.authProfile();
    if (profile.authenticated) {
      const tier = profile.tier ? `, ${profile.tier}` : '';
      return pass(
        'auth',
        'Included access',
        `Stored sign-in found for ${profile.accountLabel ?? 'unknown'}${tier}.`,
      );
    }
    return warn(
      'auth',
      'Included access',
      'Not signed in for included model access.',
      'Run `texra login`, or use `/api personal` in the chat TUI to use your own API keys.',
    );
  } catch (error) {
    return fail(
      'auth',
      'Included access',
      'Could not read TeXRA sign-in state.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

async function checkModels(
  deps: Required<Pick<DoctorDependencies, 'modelAccessList'>>,
): Promise<DoctorCheck> {
  try {
    const models = await deps.modelAccessList();
    const available = models.filter((entry) => entry.available);
    if (available.length > 0) {
      return pass(
        'models',
        'Models',
        `${available.length} model${available.length === 1 ? '' : 's'} available.`,
      );
    }
    return fail(
      'models',
      'Models',
      'No model is currently available.',
      'Run `texra models list`, sign in with `texra login`, or use `/api personal` in the chat TUI.',
    );
  } catch (error) {
    return fail(
      'models',
      'Models',
      'Could not compute model availability.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

async function checkLatex(
  deps: Required<Pick<DoctorDependencies, 'latexToolchain'>>,
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
      fail(
        'latex',
        'LaTeX toolchain',
        'Could not probe the LaTeX toolchain.',
        error instanceof Error ? error.message : undefined,
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
  if ((context.configWarnings ?? []).length > 0) {
    return warn(
      'config',
      'Config',
      `Workspace config has warnings: ${context.configFilePath}`,
      context.configWarnings?.join(' '),
    );
  }
  const workspaceConfig = workspaceCliConfigPath(context.cwd);
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
    authProfile: deps.authProfile ?? getCliStoredAuthProfile,
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

export function formatDoctorText(report: DoctorReport): string {
  const marker: Record<DoctorCheckStatus, string> = {
    pass: 'PASS',
    warn: 'WARN',
    fail: 'FAIL',
    skip: 'SKIP',
  };
  return report.checks
    .map((check) => {
      const head = `${marker[check.status]} ${check.name}: ${check.message}`;
      return check.hint ? `${head}\n     ${check.hint}` : head;
    })
    .join('\n');
}

export function doctorNdjsonRecords(
  report: DoctorReport,
  ts = new Date().toISOString(),
): readonly object[] {
  return [
    ...report.checks.map((check) => ({
      kind: 'doctor-check',
      ts,
      ...check,
    })),
    { kind: 'doctor-summary', ts, ok: report.ok },
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
  const text = formatDoctorText(report);
  if (report.ok) {
    writeTextStdout(text);
  } else {
    writeTextStderr(text);
  }
}
