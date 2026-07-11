import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gt as semverGt, valid as semverValid } from 'semver';
import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';
import { executeCommand } from '@utils/system/execUtils';

import {
  cliEnvValue,
  readCliAmbientState,
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

/**
 * True when the running binary was installed by a package manager. Two layouts
 * mark a managed install:
 * - a `node_modules` segment — npm/pnpm/yarn/bun globals install the package
 *   under `node_modules/@texra-ai/cli`;
 * - a `cellar` segment — Homebrew's tap formula installs the bundled binary
 *   under `Cellar/texra/<version>/…`, which need not contain a `node_modules`
 *   segment (this mirrors how {@link detectInstallMethod} recognizes brew).
 *
 * A source checkout or `npm link` build runs straight from `packages/cli/dist`
 * and matches neither, so an "update with `npm install -g …`" prompt would be
 * misleading (it cannot update the checkout) — {@link notifyCliUpdate} skips
 * the check for those.
 */
export function isPackageManagerInstall(
  modulePath: string = currentModulePath(),
): boolean {
  const segments = modulePath.toLowerCase().split(/[\\/]+/);
  return segments.includes('node_modules') || segments.includes('cellar');
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
  try {
    const response = await fetchImpl(`${registry}/${CLI_PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
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
  // Runs before platform init (chat/orchestrate startup), so pass an
  // explicit cwd — the wrapper's WorkspaceFS default would throw — and
  // quiet: true so wrapper debug lines can't leak to the console sink.
  const result = await executeCommand([command, ...args], {
    timeout: timeoutMs,
    cwd: process.cwd(),
    quiet: true,
  });
  return result.success ? (result.stdout ?? '') : undefined;
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
  const parsed = parseJsonWith(stdout, HomebrewInfoSchema);
  if (parsed.isErr()) return undefined;
  const entry = parsed.value.formulae?.find((f) => f?.name === formula);
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
    // Needs true stdio:'inherit' — the package manager may print an
    // interactive prompt or password request, which executeCommand's
    // buffered/streamed output cannot forward.
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
 * Announce that the new version installed, then exit. We intentionally do NOT
 * re-exec the freshly installed binary under the user: this process is still
 * the old code, and silently swapping the running program mid-session is more
 * surprising than a one-line hand-off. Asking the user to run `texra` again is
 * the clean boundary — the next invocation runs `latest` from a fresh process.
 *
 * Never returns — it calls `process.exit`.
 */
function announceUpdateInstalled(latest: string, style: CliStyle): never {
  writeTextStderr(
    style.success(`Updated to ${latest}.`) +
      style.muted(' Run ') +
      style.command('texra') +
      style.muted(' again to use it.'),
  );
  process.exit(CliExitCode.Success);
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
  // A source checkout or `npm link` build runs from `packages/cli/dist`, not a
  // node_modules tree; an `npm install -g` prompt can't update it, so skip.
  if (!isPackageManagerInstall()) return;

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

  // The new version is on disk, but THIS process is still the old code. Don't
  // re-exec it under the user — announce success and let them run `texra` again
  // so the next session starts clean on the new version.
  announceUpdateInstalled(latest, style);
}
