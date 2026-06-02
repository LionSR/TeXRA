import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

import { gt as semverGt, valid as semverValid } from 'semver';

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
export const CLI_PACKAGE_NAME = '@texra-ai/cli';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 2500;
const POSIX_SIGNAL_EXIT_OFFSET = 128;
const UPDATE_CHECK_SKIP_ENV = 'TEXRA_NO_UPDATE_CHECK';

/** Package manager the running binary was installed with. */
export type InstallMethod = 'npm' | 'pnpm' | 'yarn' | 'bun';

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
 * Guess the package manager from the path the binary runs out of. Global
 * pnpm/yarn/bun installs leave a recognizable segment in the path; npm's global
 * layout has none, so it is the fallback.
 */
export function detectInstallMethod(
  modulePath: string = currentModulePath(),
): InstallMethod {
  const segments = modulePath.toLowerCase().split(/[\\/]+/);
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
 * Once per process: check npm for a newer release and, in an interactive
 * terminal, offer to run the matching global install. Never blocks meaningfully
 * when up to date, offline, or the check is disabled — failures are silent so a
 * flaky network never gets between the user and their session.
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

  const latest = await fetchLatestCliVersion();
  if (!latest || !isNewerVersion(latest, context.version)) return;

  const method = detectInstallMethod();
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
