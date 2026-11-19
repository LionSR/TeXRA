// Node imports
import { homedir } from 'node:os';

// Third-party imports
import {
  Effect,
  FileSystem,
  PlatformError,
  Result,
  SemVer,
  SemVerRange,
} from 'effect';

// Local imports
import {
  formatResultCount,
  isModelOptionAvailable,
} from '@texra-ai/harness/schemas';
import { redactDiagnostics } from '@texra-ai/harness/host';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { latexToolchainHealth } from '@latex/latexToolchain';
import {
  USAGE_LOGGING_ENV_OPT_OUT,
  type UsageLoggingOptOut,
} from '@telemetry/UsageLogService';
import { workspaceTexraConfigPath } from '@texra/platform/defaults/nodeStorage';
import {
  installAdvice,
  LATEX_DEPENDENCIES,
} from '@texra/shared/constants/latexToolchain';
import { osPlatformOf } from '@texra/shared/osPlatform';
import {
  TELEMETRY_ENABLED_SETTING,
  TEXRA_SETTINGS,
  USAGE_LOGGING_SENDS,
} from '@texra/shared/settings/texraSettings';

// Local file imports
import { CliExitCode } from './platform/exitCodes';
import { writeCliResult } from '../commands/_helpers/output';
import { cliErrorMessage, writeTextStderr } from './platform/logSinks';
import { createCliStyle } from './terminal/style';
import { TEXRA_CLI_SUPPORTED_NODE_RANGE } from './terminal/terminalRequirements';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { CliContext } from './platform/cliContext';
import type { CliStyle } from './terminal/style';
import type { ModelOptionData } from '@texra/shared/pickerOptions';

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
 * The probes only the CLI root can build: platform init either failed
 * (`degraded`, which skips the checks that need it) or produced the stores
 * and runtime they read (`ready`).
 */
type DoctorInput =
  | { readonly kind: 'degraded'; readonly initError: Error }
  | {
      readonly kind: 'ready';
      readonly modelAccessList: Effect.Effect<
        readonly ModelOptionData[],
        Error
      >;
      readonly usageLoggingOptOut: Effect.Effect<UsageLoggingOptOut>;
    };

type ReadyDoctorInput = Extract<DoctorInput, { kind: 'ready' }>;

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
  return fail(id, name, message, cliErrorMessage(error));
}

const SUPPORTED_NODE_RANGE = SemVerRange.parseUnsafe(
  TEXRA_CLI_SUPPORTED_NODE_RANGE,
);

function checkNode(version: string): DoctorCheck {
  const parsed = SemVer.parse(version);
  if (
    Result.isSuccess(parsed) &&
    SemVerRange.matches(SUPPORTED_NODE_RANGE, parsed.success)
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
          failure,
        ),
      ),
    ),
  );
}

function checkModels(deps: ReadyDoctorInput): Effect.Effect<DoctorCheck> {
  return deps.modelAccessList.pipe(
    Effect.map((models) => {
      const available = models.filter(isModelOptionAvailable);
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

function checkLatex(): Effect.Effect<
  DoctorCheck[],
  never,
  ChildProcessSpawner
> {
  const platform = osPlatformOf(process.platform);
  return latexToolchainHealth().pipe(
    Effect.map(({ compiler, tools }) => {
      const checks: DoctorCheck[] = [];
      if (!compiler) {
        const { label, installs } = LATEX_DEPENDENCIES.compiler;
        checks.push(
          fail(
            'latex.compiler',
            'LaTeX compiler',
            'No supported LaTeX compiler was found on PATH.',
            installAdvice(label, installs, platform).guide,
          ),
        );
      }
      checks.push(
        ...tools.map((tool) => {
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
            installAdvice(tool.name, [tool.name], platform).guide,
          );
        }),
      );
      return checks;
    }),
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

/** The setting's key as the config file stores it, under the catalog's
 *  namespace: the line the hint tells the user to paste. */
const TELEMETRY_STORED_KEY = `${TEXRA_SETTINGS.catalog.namespace}.${TELEMETRY_ENABLED_SETTING.key}`;

function checkTelemetry(deps: ReadyDoctorInput): Effect.Effect<DoctorCheck> {
  return deps.usageLoggingOptOut.pipe(
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
          `Off (${TELEMETRY_STORED_KEY}).`,
        );
      }
      return check(
        'telemetry',
        'Usage logging',
        'pass',
        `On. ${USAGE_LOGGING_SENDS}`,
        `Turn it off with ${USAGE_LOGGING_ENV_OPT_OUT}, or "${TELEMETRY_STORED_KEY}": false in ~/.texra/v1/global-storage/config.json.`,
      );
    }),
    // A config store that throws reports as this check's failure.
    Effect.catchDefect((cause) =>
      Effect.succeed(
        failFromError(
          'telemetry',
          'Usage logging',
          'Could not read the usage-logging setting.',
          cause,
        ),
      ),
    ),
  );
}

type DoctorServices = FileSystem.FileSystem | ChildProcessSpawner;

export const buildDoctorReport = Effect.fn('buildDoctorReport')(function* (
  context: CliContext,
  input: DoctorInput,
): Effect.fn.Return<DoctorReport, never, DoctorServices> {
  // A platform-init failure takes out every dependency-based check
  // (models/telemetry), so surface it once here rather than as N
  // unrelated-looking failures. The checks that do not need the platform
  // (node, workspace, resources, LaTeX, config) still run.
  // The checks are independent, so they run at once; the rows keep their
  // order.
  const [workspace, resources, sessionDependentChecks, latex, config] =
    yield* Effect.all(
      [
        checkDirectory('workspace', 'Workspace', context.cwd, 'readwrite'),
        checkDirectory(
          'resources',
          'Packaged resources',
          context.resourcesPath,
          'read',
        ),
        input.kind === 'ready'
          ? Effect.all([checkModels(input), checkTelemetry(input)], {
              concurrency: 'unbounded',
            })
          : Effect.succeed([
              failFromError(
                'platform',
                'Platform init',
                'Could not initialize the TeXRA platform.',
                input.initError,
              ),
            ]),
        checkLatex(),
        checkConfig(context),
      ],
      { concurrency: 'unbounded' },
    );
  const checks: DoctorCheck[] = [
    checkNode(process.versions.node),
    workspace,
    resources,
    ...sessionDependentChecks,
    ...latex,
    config,
  ];
  return {
    ok: !checks.some((check) => check.status === 'fail'),
    checks,
  };
});

export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? CliExitCode.Success : CliExitCode.ModelOrNetworkError;
}

function formatDoctorText(
  report: DoctorReport,
  style: CliStyle,
  redact: (text: string) => string,
): string {
  const marker: Record<DoctorCheckStatus, string> = {
    pass: style.success('PASS'),
    warn: style.warn('WARN'),
    fail: style.error('FAIL'),
    skip: style.muted('SKIP'),
  };
  return report.checks
    .map((check) => {
      const head = `${marker[check.status]} ${check.name}: ${redact(check.message)}`;
      if (!check.hint) return head;
      // Install advice runs over several lines; each sits under the marker
      // column, and a blank line between its steps stays blank.
      const hint = redact(check.hint)
        .split('\n')
        .map((line) => (line ? `     ${style.muted(line)}` : ''))
        .join('\n');
      return `${head}\n${hint}`;
    })
    .join('\n');
}

function doctorNdjsonRecords(report: DoctorReport): readonly CliNdjsonRecord[] {
  return [
    ...report.checks.map((check): CliNdjsonRecord => ({
      kind: 'doctor-check',
      ...check,
    })),
    { kind: 'doctor-summary', ok: report.ok },
  ];
}

export function writeDoctorReport(
  context: CliContext,
  report: DoctorReport,
): void {
  // A failing report's text goes to stderr (clig.dev); each stream's own
  // color gate. One stderr-keyed gate leaked ANSI into `doctor | cat` and
  // stripped color from `doctor 2>/dev/null`.
  // The text report is what gets pasted into a bug report, so it masks what
  // the desktop's log viewer masks.
  const redact = (text: string) =>
    redactDiagnostics(text, { home: homedir(), workspace: context.cwd });
  if (context.outputFormat === 'text' && !report.ok) {
    writeTextStderr(
      formatDoctorText(
        report,
        createCliStyle(context.stderrColorEnabled),
        redact,
      ),
    );
    return;
  }
  writeCliResult(context.outputFormat, {
    json: report,
    ndjson: doctorNdjsonRecords(report),
    text: formatDoctorText(
      report,
      createCliStyle(context.stdoutColorEnabled),
      redact,
    ),
  });
}
