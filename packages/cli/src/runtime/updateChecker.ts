import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readCliAmbientState, type CliContext } from './cliContext';
import { askCliQuestion, writeTextStderr } from './logSinks';

/** Published package name on npm; the `texra` bin lives here. */
export const CLI_PACKAGE_NAME = '@texra-ai/cli';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 2500;

/** Package manager the running binary was installed with. */
export type InstallMethod = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Empty when the version is a plain release (no `-rc.1` suffix). */
  readonly prerelease: string;
}

export function parseSemver(version: string): ParsedSemver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    version.trim(),
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

/**
 * True when `latest` is strictly newer than `current`. A plain release ranks
 * above any prerelease of the same `x.y.z` (so `1.2.0` beats `1.2.0-rc.1`); two
 * prereleases compare lexically, which is enough for an update *hint* without
 * pulling in a full semver dependency.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  if (a.prerelease === b.prerelease) return false;
  if (a.prerelease === '') return true; // release > any prerelease
  if (b.prerelease === '') return false; // prerelease !> release
  return a.prerelease > b.prerelease;
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
  if (segments.includes('.bun') || segments.includes('bun')) return 'bun';
  if (segments.some((part) => part === 'pnpm' || part === '.pnpm'))
    return 'pnpm';
  if (segments.includes('yarn')) return 'yarn';
  return 'npm';
}

function currentModulePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] ?? '';
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
    const child = spawn(command, [...args], { stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function affirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === '' || normalized === 'y' || normalized === 'yes';
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
  if (process.env.TEXRA_NO_UPDATE_CHECK) return;
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
  writeTextStderr(
    `A new version of texra is available: ${context.version} → ${latest}`,
  );

  let answer: string;
  try {
    answer = await askCliQuestion(
      `Update now with \`${formatUpdateCommand(method)}\`? [Y/n] `,
    );
  } catch {
    return;
  }
  if (!affirmative(answer)) {
    writeTextStderr(
      `Skipped. Update later with: ${formatUpdateCommand(method)}`,
    );
    return;
  }

  writeTextStderr(`Updating via ${method}…`);
  const ok = await runCliUpdate(method);
  writeTextStderr(
    ok
      ? `Updated to ${latest}. Restart texra to use the new version.`
      : `Update failed. Run manually: ${formatUpdateCommand(method)}`,
  );
}

/** Test-only: reset the once-per-process guard. */
export function resetUpdateNotifierForTests(): void {
  notified = false;
}
