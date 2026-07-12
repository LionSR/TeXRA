import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gt as semverGt, valid as semverValid } from 'semver';
import { z } from 'zod';

import { JsonStore } from '@platform/defaults/jsonStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { executeCommand } from '@utils/system/execUtils';

import {
  cliEnvValue,
  readCliAmbientState,
  readCliEntrypointPath,
  resolveCliCwd,
  type CliContext,
} from './cliContext';
import { CliExitCode } from './exitCodes';
import { askCliQuestion, writeTextStderr } from './logSinks';
import { createCliStyle, type CliStyle } from './style';
import type { StateStore } from '@platform/interfaces';

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
/**
 * Check for a new release at most once per day, matching the desktop update
 * checker's cadence (see `desktopUpdateChecker.ts`'s `CHECK_INTERVAL_MS`).
 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  cwd?: string,
) => Promise<string | undefined>;

async function readCommandStdout(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string,
): Promise<string | undefined> {
  // Runs before platform init (chat/orchestrate startup), so pass an
  // explicit cwd — the wrapper's WorkspaceFS default would throw — and
  // quiet: true so wrapper debug lines can't leak to the console sink.
  const result = await executeCommand([command, ...args], {
    timeout: timeoutMs,
    cwd: cwd ?? (await resolveCliCwd(undefined)),
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

/** Result of one fetch attempt against the package source. */
export interface CliUpdateFetchResult {
  /** Latest published version, when one could be read (possibly stale). */
  version: string | undefined;
  /**
   * True when the version reflects a live consultation of the source — an npm
   * registry response, or `brew info` after a successful tap refresh. False
   * when only stale local metadata was readable (failed `brew update`): still
   * usable for a prompt, but the attempt must retry next launch instead of
   * being stamped for a full throttle window.
   */
  refreshed: boolean;
}

/**
 * Attempt to refresh Homebrew tap metadata and fetch the latest formula
 * version. Without the explicit update, `brew info` can report stale local
 * metadata and hide an available upgrade until the user runs `brew update`
 * manually. If the refresh fails, still read `brew info` — local metadata may
 * already be fresh enough to offer the right prompt — but report
 * `refreshed: false` so the caller knows the version may be stale.
 */
export async function fetchLatestHomebrewFormulaVersion(options?: {
  formula?: string;
  timeoutMs?: number;
  cwd?: string;
  runCommand?: CommandRunner;
}): Promise<CliUpdateFetchResult> {
  const formula = options?.formula ?? CLI_HOMEBREW_FORMULA;
  const runCommand = options?.runCommand ?? readCommandStdout;
  const timeoutMs = options?.timeoutMs ?? HOMEBREW_COMMAND_TIMEOUT_MS;
  const refreshStdout = await runCommand(
    'brew',
    ['update', '--quiet'],
    timeoutMs,
    options?.cwd,
  );
  const stdout = await runCommand(
    'brew',
    ['info', '--json=v2', formula],
    timeoutMs,
    options?.cwd,
  );
  return {
    version:
      stdout == null ? undefined : parseHomebrewFormulaVersion(stdout, formula),
    refreshed: refreshStdout != null,
  };
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

export interface CheckCliUpdateAvailableOptions {
  currentVersion: string;
  globalState: StateStore;
  /** Fetch the latest published version plus whether the source was live. */
  fetchLatest: () => Promise<CliUpdateFetchResult>;
  /**
   * Present a newer version to the user (notice + prompt). Called only when a
   * strictly newer version was fetched, and always before the daily stamp is
   * persisted — a throw (e.g. stdin closing mid-prompt) aborts the attempt
   * un-stamped so the next launch re-checks instead of going silent for the
   * full throttle window.
   */
  notify: (latest: string) => Promise<void>;
  now?: () => number;
}

/**
 * At most once per day (persisted in global state), fetch the latest
 * published version and report it when newer than `currentVersion`. Mirrors
 * the desktop update checker's throttle (see `checkForDesktopUpdate` in
 * `desktopUpdateChecker.ts`), but this is the single owner of the daily
 * stamp: it is written in exactly one place, only once every outcome of the
 * attempt is known — the source was genuinely consulted (`refreshed`, not a
 * stale brew cache behind a failed tap refresh) and, when an update was
 * available, `notify` resolved (the user actually saw it). Any other outcome
 * (offline, registry hiccup, failed tap refresh, killed prompt) leaves the
 * stamp unwritten so the next launch retries instead of being suppressed for
 * a full day.
 */
export async function checkCliUpdateAvailable({
  currentVersion,
  globalState,
  fetchLatest,
  notify,
  now = Date.now,
}: CheckCliUpdateAvailableOptions): Promise<string | undefined> {
  const lastCheckedAt = globalState.get<number>(
    GlobalStateKey.CLI_UPDATE_CHECK_LAST_CHECKED_AT,
    0,
  );
  const nowMs = now();
  if (nowMs - lastCheckedAt < CHECK_INTERVAL_MS) return undefined;

  const { version, refreshed } = await fetchLatest();
  const latest =
    version !== undefined && isNewerVersion(version, currentVersion)
      ? version
      : undefined;
  if (latest !== undefined) await notify(latest);
  if (version && refreshed) {
    await globalState.update(
      GlobalStateKey.CLI_UPDATE_CHECK_LAST_CHECKED_AT,
      nowMs,
    );
  }
  return latest;
}

let notified = false;

/**
 * Once per process: check the package source for a newer release (at most
 * once per day — see {@link checkCliUpdateAvailable}) and, in an interactive
 * terminal, offer to run the matching global install. npm-like installs read
 * the npm registry; Homebrew installs refresh local tap metadata before
 * reading the formula version. Failures are silent so a flaky network never
 * gets between the user and their session.
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
  const updateCmd = formatUpdateCommand(method);
  const style = createCliStyle(context.colorEnabled);
  // Runs before `initInteractiveCliPlatform`, so `platform()` isn't up yet —
  // open the same global `state.json` that `createCliStateStores` opens later
  // directly (see `cliStateStores.ts`). Failures here (e.g. an unreadable or
  // unwritable global-storage directory, or stdin closing mid-prompt) must
  // stay as silent as a network failure: this whole check is best-effort and
  // must never block `chat` / `orchestrate` startup.
  let latest: string | undefined;
  let confirmed = false;
  try {
    const globalState = await JsonStore.open(
      path.join(
        createNodeStorageProvider().getGlobalStoragePath(),
        'state.json',
      ),
    );
    latest = await checkCliUpdateAvailable({
      currentVersion: context.version,
      globalState,
      fetchLatest: async () => {
        if (method === 'brew') {
          return fetchLatestHomebrewFormulaVersion({ cwd: context.cwd });
        }
        const version = await fetchLatestCliVersion();
        return { version, refreshed: version !== undefined };
      },
      notify: async (latestVersion) => {
        writeTextStderr(
          `A new version of texra is available: ${context.version} → ${style.emphasis(style.success(latestVersion))}`,
        );
        const answer = await askCliQuestion(
          `Update now with \`${style.command(updateCmd)}\`? [Y/n] `,
        );
        confirmed = affirmative(answer);
      },
    });
  } catch {
    return;
  }
  if (!latest) return;
  if (!confirmed) {
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
