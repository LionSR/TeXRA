import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

import { gt as semverGt, valid as semverValid } from 'semver';
import { z } from 'zod';

import {
  cliEnvValue,
  readCliAmbientState,
  readCliArgv,
  readCliEnv,
  readCliEntrypointPath,
  type CliContext,
} from './cliContext';
import { CliExitCode } from './exitCodes';
import { askCliQuestion, writeTextStderr } from './logSinks';
import { createCliStyle, type CliStyle } from './style';

/** Published package name on npm; the `texra` bin lives here. */
const CLI_PACKAGE_NAME = '@texra-ai/cli';

/**
 * Homebrew formula name (in the `texra-ai/tap` tap). The unqualified name is
 * enough for `brew upgrade` once the tap is installed.
 */
const CLI_HOMEBREW_FORMULA = 'texra';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 2500;
const HOMEBREW_COMMAND_TIMEOUT_MS = 10000;
const POSIX_SIGNAL_EXIT_OFFSET = 128;
const UPDATE_CHECK_SKIP_ENV = 'TEXRA_NO_UPDATE_CHECK';

/** Package manager the running binary was installed with. */
export type InstallMethod = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'brew';

/**
 * True when `latest` is strictly newer than `current`, using full semver
 * precedence (a plain release outranks any prerelease of the same `x.y.z`, and
 * prereleases compare numerically — so `1.2.0-rc.10` correctly beats
 * `1.2.0-rc.2`). Unparseable inputs yield `false` so a malformed registry
 * response can never push a bogus update prompt. The leading `v` some tags
 * carry is tolerated by `semver`.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = semverValid(latest.trim(), { loose: true });
  const b = semverValid(current.trim(), { loose: true });
  if (!a || !b) return false;
  return semverGt(a, b);
}

/**
 * Guess the package manager from the path the binary runs out of. Homebrew and
 * global pnpm/yarn/bun installs each leave a recognizable segment in the path;
 * npm's global layout has none, so it is the fallback.
 *
 * Homebrew's Tier-1 formula installs the npm package into the Cellar, so a brew
 * install must NOT be treated as a plain npm global — `npm install -g` would
 * shadow or clash with the brew-managed copy. Only the `Cellar` segment marks a
 * brew formula install; broader `homebrew` / `linuxbrew` prefixes also contain
 * npm globals when Node itself was installed by Homebrew.
 */
export function detectInstallMethod(
  modulePath: string = currentModulePath(),
): InstallMethod {
  const segments = modulePath.toLowerCase().split(/[\\/]+/);
  if (segments.includes('cellar')) return 'brew';
  if (segments.some((part) => part === 'bun' || part === '.bun')) return 'bun';
  if (segments.some((part) => part === 'pnpm' || part === '.pnpm'))
    return 'pnpm';
  // Yarn Classic's global bin lives under `~/.yarn/bin`, so match the
  // dotted variant too — same as bun/pnpm above.
  if (segments.some((part) => part === 'yarn' || part === '.yarn'))
    return 'yarn';
  return 'npm';
}

function currentModulePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return readCliEntrypointPath();
  }
}

export function buildUpdateCommand(
  method: InstallMethod,
  pkg: string = CLI_PACKAGE_NAME,
): { command: string; args: readonly string[] } {
  const target = `${pkg}@latest`;
  switch (method) {
    case 'pnpm':
      return { command: 'pnpm', args: ['add', '-g', target] };
    case 'yarn':
      return { command: 'yarn', args: ['global', 'add', target] };
    case 'bun':
      return { command: 'bun', args: ['add', '-g', target] };
    case 'brew':
      // Brew prompts are gated on the locally-known formula version, then the
      // tap is refreshed immediately before upgrade. Run via the shell chain
      // (`runCliUpdate` and `formatUpdateCommand` both treat the result as a
      // shell command).
      return {
        command: 'brew',
        args: ['update', '&&', 'brew', 'upgrade', CLI_HOMEBREW_FORMULA],
      };
    case 'npm':
      return { command: 'npm', args: ['install', '-g', target] };
  }
}

export function formatUpdateCommand(method: InstallMethod): string {
  const { command, args } = buildUpdateCommand(method);
  return [command, ...args].join(' ');
}

/** Fetch the `latest` dist-tag version from the npm registry, or undefined. */
export async function fetchLatestCliVersion(options?: {
  registry?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const registry = options?.registry ?? DEFAULT_REGISTRY;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(`${registry}/${CLI_PACKAGE_NAME}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | undefined>;

async function readCommandStdout(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? stdout : undefined));
  });
}

/**
 * Shape of `brew info --json=v2` that we read. Tolerant by design: a single
 * malformed formula entry degrades to `null` (skipped) rather than failing the
 * whole parse, matching the previous per-entry type guards.
 */
const HomebrewInfoSchema = z.object({
  formulae: z
    .array(
      z
        .object({
          name: z.string(),
          versions: z.object({ stable: z.string().nullish() }).nullish(),
        })
        .nullable()
        .catch(null),
    )
    .nullish(),
});

function parseHomebrewFormulaVersion(
  stdout: string,
  formula = CLI_HOMEBREW_FORMULA,
): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const parsed = HomebrewInfoSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const entry = parsed.data.formulae?.find((f) => f?.name === formula);
  return entry?.versions?.stable ?? undefined;
}

/**
 * Attempt to refresh Homebrew tap metadata and fetch the latest formula
 * version, or undefined. Without the explicit update, `brew info` can report
 * stale local metadata and hide an available upgrade until the user runs
 * `brew update` manually. If the refresh fails, still read `brew info`: local
 * metadata may already be fresh enough to offer the right prompt.
 */
export async function fetchLatestHomebrewFormulaVersion(options?: {
  formula?: string;
  timeoutMs?: number;
  runCommand?: CommandRunner;
}): Promise<string | undefined> {
  const formula = options?.formula ?? CLI_HOMEBREW_FORMULA;
  const runCommand = options?.runCommand ?? readCommandStdout;
  const timeoutMs = options?.timeoutMs ?? HOMEBREW_COMMAND_TIMEOUT_MS;
  await runCommand('brew', ['update', '--quiet'], timeoutMs);
  const stdout = await runCommand(
    'brew',
    ['info', '--json=v2', formula],
    timeoutMs,
  );
  return stdout == null
    ? undefined
    : parseHomebrewFormulaVersion(stdout, formula);
}

function runCliUpdate(method: InstallMethod): Promise<boolean> {
  const { command, args } = buildUpdateCommand(method);
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function affirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === '' || normalized === 'y' || normalized === 'yes';
}

/**
 * Build the argv to re-exec the just-installed binary in place, preserving the
 * user's own arguments. We launch through `execPath` (the running Node) rather
 * than the bin's shebang so it works regardless of how the entrypoint is
 * marked executable. Returns `undefined` when there is no entrypoint to
 * re-exec — caller falls back to asking the user to restart by hand.
 */
export function buildRelaunchCommand(
  entrypoint: string,
  argv: readonly string[],
  execPath: string = process.execPath,
): { command: string; args: string[] } | undefined {
  if (!entrypoint.trim()) return undefined;
  return { command: execPath, args: [entrypoint, ...argv] };
}

/** Env for the fresh process, skipping the redundant post-update check once. */
export function buildRelaunchEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, [UPDATE_CHECK_SKIP_ENV]: '1' };
}

export function exitCodeForRelaunchClose(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code != null) return code;
  if (!signal) return CliExitCode.Success;

  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === 'number'
    ? POSIX_SIGNAL_EXIT_OFFSET + signalNumber
    : CliExitCode.Terminated;
}

/**
 * Replace this now-stale process with a fresh one running the just-installed
 * binary, carrying the same argv. Inherits stdio so the child owns the terminal
 * and mirrors the child's exit code, making the in-session update seamless: the
 * launcher/session the user lands in actually runs `latest` instead of silently
 * continuing on the old code (which would keep reporting the previous version
 * in the header, `/status`, and the launcher).
 *
 * Never returns on success — it calls `process.exit`. If the child can't be
 * spawned, or there is nothing to re-exec, it prints the restart hint and exits
 * cleanly so we never carry on executing the stale build.
 */
async function relaunchAfterUpdate(
  latest: string,
  style: CliStyle,
): Promise<never> {
  const invocation = buildRelaunchCommand(
    readCliEntrypointPath(),
    readCliArgv(),
  );
  if (!invocation) {
    writeTextStderr(
      style.success(
        `Updated to ${latest}. Restart texra to use the new version.`,
      ),
    );
    process.exit(CliExitCode.Success);
  }

  writeTextStderr(style.success(`Updated to ${latest}. Restarting…`));
  await new Promise<never>(() => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'inherit',
      // The relaunched process just verified it is current, so suppress its own
      // startup check: it would otherwise re-hit the registry (and could even
      // re-prompt) on every auto-update. This only skips that single
      // once-per-process check; there are no later in-session checks to lose.
      env: buildRelaunchEnv(readCliEnv()),
    });
    child.on('error', () => {
      writeTextStderr(
        style.muted('Could not restart automatically — ') +
          style.success(`run texra again to use ${latest}.`),
      );
      process.exit(CliExitCode.Success);
    });
    child.on('close', (code, signal) => {
      process.exit(exitCodeForRelaunchClose(code, signal));
    });
  });
  // Unreachable: every branch above ends the process via `process.exit`.
  throw new Error('unreachable: relaunchAfterUpdate did not exit');
}

let notified = false;

/**
 * Once per process: check the package source for a newer release and, in an
 * interactive terminal, offer to run the matching global install. npm-like
 * installs read the npm registry; Homebrew installs refresh local tap metadata
 * before reading the formula version. Failures are silent so a flaky network
 * never gets between the user and their session.
 *
 * Disable entirely with `TEXRA_NO_UPDATE_CHECK=1`.
 */
export async function notifyCliUpdate(context: CliContext): Promise<void> {
  if (notified) return;
  notified = true;

  const ambient = readCliAmbientState();
  if (cliEnvValue(UPDATE_CHECK_SKIP_ENV)) return;
  if (ambient.isCi) return;
  // Require all three standard streams to be a TTY. stdout matters even though
  // the prompt uses stdin/stderr: a half-redirected invocation like
  // `texra chat > out` is an interactive-mode usage error the command rejects
  // later, and we must not prompt for (or run) a self-update before it does.
  if (!ambient.stdinIsTty || !ambient.stdoutIsTty || !ambient.stderrIsTty)
    return;
  if (context.outputFormat === 'ndjson' || context.quietLogs === true) return;

  const method = detectInstallMethod();
  const latest =
    method === 'brew'
      ? await fetchLatestHomebrewFormulaVersion()
      : await fetchLatestCliVersion();
  if (!latest || !isNewerVersion(latest, context.version)) return;

  const updateCmd = formatUpdateCommand(method);
  const style = createCliStyle(context.colorEnabled);
  writeTextStderr(
    `A new version of texra is available: ${context.version} → ${style.emphasis(style.success(latest))}`,
  );

  let answer: string;
  try {
    answer = await askCliQuestion(
      `Update now with \`${style.command(updateCmd)}\`? [Y/n] `,
    );
  } catch {
    return;
  }
  if (!affirmative(answer)) {
    writeTextStderr(
      style.muted('Skipped. Update later with: ') + style.command(updateCmd),
    );
    return;
  }

  writeTextStderr(style.muted(`Updating via ${method}…`));
  const ok = await runCliUpdate(method);
  if (!ok) {
    writeTextStderr(
      `${style.error('Update failed.')} Run manually: ${style.command(updateCmd)}`,
    );
    return;
  }

  // The new version is on disk, but THIS process is still the old code. Re-exec
  // the freshly installed binary so the session that follows actually runs the
  // update; otherwise it silently does nothing until a manual relaunch.
  await relaunchAfterUpdate(latest, style);
}
