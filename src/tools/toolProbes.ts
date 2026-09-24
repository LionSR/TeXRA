/**
 * The availability-probe primitives the plugin checks in
 * {@link @tools/pluginAvailability} are built from: localhost and SDK/binary
 * probes, the prerequisites bridge
 * that feeds one cached probe result to a plugin's check, badge and detail
 * callbacks, and the install-command picker.
 */

// Third-party imports
import { Cause, Data, Effect } from 'effect';

// Local imports
import {
  causeChain,
  isModuleNotFoundError,
} from '@common/errors/errorPredicates';
import type { ConfigProvider } from '@platform/interfaces';
import type { Secrets, SecretsFailed } from '@platform/secrets';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import type { SetupPlatform } from '@tools/setup/platform';
import { IS_WINDOWS } from '@utils/system/platformPaths';
import { isWSL } from '@utils/system/wslDetect';
import {
  hasPackageManager,
  SYSTEM_PACKAGE_MANAGERS,
  type SystemPackageManager,
} from '@utils/system/toolUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const ZOTERO_PROBE_TIMEOUT_MS = 2000;

/**
 * Why an availability probe in this module could not answer.
 *
 * Read off what the probed surfaces raise: a dynamic `import()` of a CLI's
 * SDK (the package is absent, or it failed for another reason), the native
 * binary lookup that follows it, and the localhost request the Zotero probe
 * makes (refused, or still unanswered at {@link ZOTERO_PROBE_TIMEOUT_MS}). A
 * tool that is simply not installed is `check` answering `false`.
 */
type ToolProbeFailureReason =
  | 'module-not-found'
  | 'sdk-import-failed'
  | 'binary-lookup-failed'
  | 'probe-request-failed';

/**
 * The one failure of this module's probes. `reason` is what a caller reads:
 * the dashboard's "install this package" line is owed to `module-not-found`
 * specifically, which is why that used to be reconstructed from the error's
 * text and is now the probe's own classification.
 */
class ToolProbeFailed extends Data.TaggedError('ToolProbeFailed')<{
  readonly reason: ToolProbeFailureReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** What a plugin's availability callbacks may fail with. */
export type ToolProbeError = ToolProbeFailed | SecretsFailed;

// ============================================================
// Type
// ============================================================

/**
 * The process services a plugin's availability callbacks read: provider
 * credentials, the host's setup capabilities for the one plugin whose
 * availability depends on the editor host (Lean 4's VS Code extension), and
 * that host's Lean port, which owns the roster of running servers the same
 * plugin reports. All three are `ProcessServices` arms, so every caller of the
 * availability surface already holds them.
 */
export type ToolProbeServices = Secrets | SetupPlatform | LeanLanguageServices;

/**
 * The asking workspace, carried into a plugin's probe as data rather than read
 * from an ambient scope: the folder the GitHub plugin asks whether it is a git
 * repository, and the configuration the Zotero plugin reads its port from. Every
 * caller of the availability surface already holds both on the roots it opened.
 */
export interface ToolProbeInputs {
  readonly workspaceRoot: string | undefined;
  readonly config: ConfigProvider;
}

/**
 * How a plugin with an external dependency answers "is it available": an
 * optional shared `probe` whose result the availability layer caches and
 * hands back to `check` (availability), `statusLabel` (dashboard badge) and
 * `detailCheck` (the line below the description).
 */
export interface ToolAvailabilityChecks {
  /**
   * Optional shared probe result passed to check/status/detail callbacks.
   * Takes the asking workspace as data — the GitHub plugin's probe asks whether
   * that folder is a git repository (#12421), the Zotero plugin's reads its port
   * out of that workspace's configuration.
   */
  readonly probe?: (
    inputs: ToolProbeInputs,
  ) => Effect.Effect<unknown, ToolProbeError, ToolProbeServices>;
  /** Returns true if the external dependency is available. */
  readonly check: (
    probeResult?: unknown,
  ) => Effect.Effect<boolean, ToolProbeError, ToolProbeServices>;
  /** Optional detailed status string resolved at check time (shown below description). */
  readonly detailCheck?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, ToolProbeError, ToolProbeServices>;
  /** Optional short status label for the dashboard badge. */
  readonly statusLabel?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, ToolProbeError, ToolProbeServices>;
  /**
   * The secret-store keys this plugin's answer reads. A committed write to any
   * of them (`credentialChanged`) re-probes every open workspace, so a plugin
   * gated on a credential declares it here instead of each host naming it.
   */
  readonly reprobeOnSecrets?: readonly string[];
}

// ============================================================
// Zotero probe helpers
// ============================================================

function fetchLocalhost(
  url: string,
  timeoutMs = ZOTERO_PROBE_TIMEOUT_MS,
): Effect.Effect<
  Pick<Response, 'ok' | 'status'>,
  ToolProbeFailed | Cause.TimeoutError
> {
  // The deadline sits on the request itself, which stays interruptible. A
  // bracket would not do: its acquire phase is uninterruptible, so a timeout
  // around one cannot cut a connection that never returns headers. The fiber's
  // signal is the request's, so both the deadline and a caller interrupting
  // the probe abort the socket rather than abandon it.
  return Effect.tryPromise({
    try: (signal) => fetch(url, { signal }),
    catch: (cause) =>
      new ToolProbeFailed({
        reason: 'probe-request-failed',
        message: `Probe request to ${url} failed: ${toErrorMessage(cause)}`,
        cause,
      }),
  }).pipe(
    // A deadline that expires fails as `TimeoutError`: both callers fold
    // every failure of this probe to `false`, so re-minting it as a
    // `ToolProbeFailed` told nobody anything.
    Effect.timeout(timeoutMs),
    // Status is read off the response before anything can suspend; cancelling
    // the body then frees the socket, since the probe never reads it, and a
    // cancel that itself fails says nothing about availability. An interrupt
    // here instead aborts the request's signal, tearing the same socket down.
    Effect.flatMap((response) =>
      Effect.ignore(
        Effect.tryPromise({
          try: () => response.body?.cancel() ?? Promise.resolve(),
          catch: ensureError,
        }),
      ).pipe(Effect.as({ ok: response.ok, status: response.status })),
    ),
  );
}

/** Probe the Zotero connector endpoint (responds if Zotero is running). */
export function probeZoteroConnector(port: number): Effect.Effect<boolean> {
  return fetchLocalhost(`http://127.0.0.1:${port}/connector/ping`).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

/**
 * The port the Zotero plugin's own `probe` resolved. The availability layer
 * types a cached probe result `unknown` because the plugins are heterogeneous;
 * this one's only ever originates from that probe, and a plugin that declares
 * one reaches `check`/`detailCheck` only once it has produced a value — the
 * bridge `prerequisitesChecks` makes for entries with pure callbacks.
 */
export function zoteroProbePort(probeResult: unknown): number {
  return probeResult as number;
}

/** Probe the Better BibTeX JSON-RPC endpoint. */
export function probeZoteroBbt(port: number): Effect.Effect<boolean> {
  return fetchLocalhost(`http://127.0.0.1:${port}/better-bibtex/json-rpc`).pipe(
    Effect.map((response) => response.ok || response.status === 405),
    Effect.catch(() => Effect.succeed(false)),
  );
}

/**
 * Import a CLI's SDK as a classified probe. The importers re-raise a missing
 * package as their own install-guidance error with the original attached as
 * `cause`, so "the package isn't installed" is read off the cause chain's
 * error code rather than off the message text.
 */
function importProbedSdk(
  importSdk: () => Effect.Effect<unknown, Error>,
): Effect.Effect<unknown, ToolProbeFailed> {
  return Effect.suspend(importSdk).pipe(
    Effect.mapError(
      (cause) =>
        new ToolProbeFailed({
          reason: causeChain(cause).some(isModuleNotFoundError)
            ? 'module-not-found'
            : 'sdk-import-failed',
          message: toErrorMessage(cause),
          cause,
        }),
    ),
  );
}

/** Resolve a CLI's native binary as a classified probe. */
function findProbedBinary(
  findBinary: () => Effect.Effect<string | undefined, Error>,
): Effect.Effect<string | undefined, ToolProbeFailed> {
  return Effect.mapError(
    findBinary(),
    (cause) =>
      new ToolProbeFailed({
        reason: 'binary-lookup-failed',
        message: toErrorMessage(cause),
        cause,
      }),
  );
}

/** Appended to install hints when running under WSL, where side matters. */
function wslInstallHint(): string {
  return isWSL ? ' (run this inside WSL, not on the Windows side)' : '';
}

/**
 * Availability check shared by the SDK-backed CLI integrations (Codex, Claude
 * Code): present when its SDK imports and the native binary resolves.
 */
export function probeSdkBinaryAvailable(
  importSdk: () => Effect.Effect<unknown, Error>,
  findBinary: () => Effect.Effect<string | undefined, Error>,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    yield* importProbedSdk(importSdk);
    return (yield* findProbedBinary(findBinary)) != null;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

/** Resolved status of an SDK-backed CLI integration for the dashboard. */
type SdkBinaryStatus =
  { ok: false; message: string } | { ok: true; binaryPath: string };

/**
 * Human-readable probe shared by the SDK-backed CLI integrations (Codex,
 * Claude Code): import the SDK (classifying a missing package specially), then
 * resolve the native binary (appending {@link wslInstallHint} when it is
 * absent). Callers own only the final "ready" line.
 */
export function probeSdkBinaryStatus(config: {
  importSdk: () => Effect.Effect<unknown, Error>;
  findBinary: () => Effect.Effect<string | undefined, Error>;
  missingPackageMessage: string;
  importFailedLabel: string;
  binaryNotFoundMessage: string;
  classifyImportError?: (msg: string) => string | undefined;
}): Effect.Effect<SdkBinaryStatus, ToolProbeFailed> {
  return Effect.gen(function* () {
    // Only the import is classified into a message; a binary-resolution
    // failure stays on the error channel.
    const importFailure = yield* importProbedSdk(config.importSdk).pipe(
      Effect.as(undefined),
      Effect.catchTag('ToolProbeFailed', (failure) => {
        if (failure.reason === 'module-not-found') {
          return Effect.succeed(config.missingPackageMessage);
        }
        const classified = config.classifyImportError?.(failure.message);
        if (classified != null) return Effect.succeed(classified);
        return Effect.succeed(
          `${config.importFailedLabel}: ${failure.message}`,
        );
      }),
    );
    if (importFailure !== undefined) {
      return { ok: false as const, message: importFailure };
    }

    const binaryPath = yield* findProbedBinary(config.findBinary);
    if (!binaryPath) {
      return {
        ok: false as const,
        message: config.binaryNotFoundMessage + wslInstallHint(),
      };
    }
    return { ok: true as const, binaryPath };
  });
}

/**
 * Wire a prerequisites-style availability entry. `probe` runs once and its
 * result is cached by the availability layer, then handed back to every
 * callback as `probeResult`, typed `unknown` at the `ToolAvailabilityChecks` boundary
 * because the dashboard's entries are heterogeneous — each plugin has its own
 * prerequisites shape `T`. Bridging that cached `unknown` back to `T` happens
 * once, here, in `resolve`: a cache miss re-derives it via the entry's own
 * `fallback`, and a hit is cast back to `T`, safe because the value only ever
 * originated from this entry's own `probe`. `check`/`statusLabel`/`detailCheck`
 * then receive the resolved `T` directly and stay pure functions of it.
 */
export function prerequisitesChecks<T>(config: {
  probe: (
    inputs: ToolProbeInputs,
  ) => Effect.Effect<T, ToolProbeError, ToolProbeServices>;
  /**
   * Re-derives `T` on a cache miss, which the callbacks reach carrying no
   * probe inputs — so each entry says here what it answers without a workspace.
   */
  fallback: () => Effect.Effect<T, ToolProbeError, ToolProbeServices>;
  check: (prereqs: T) => boolean;
  statusLabel: (prereqs: T) => string | undefined;
  detailCheck: (prereqs: T) => string | undefined;
}): ToolAvailabilityChecks {
  const { probe, fallback, check, statusLabel, detailCheck } = config;
  const resolve = (
    probeResult: unknown,
  ): Effect.Effect<T, ToolProbeError, ToolProbeServices> =>
    probeResult === undefined ? fallback() : Effect.succeed(probeResult as T);
  return {
    probe,
    check: (probeResult) => Effect.map(resolve(probeResult), check),
    statusLabel: (probeResult) => Effect.map(resolve(probeResult), statusLabel),
    detailCheck: (probeResult) => Effect.map(resolve(probeResult), detailCheck),
  };
}

/**
 * Pick the install command to offer for a CLI on this machine.
 *
 * `npm install -g` assumes Node is on PATH, which desktop-app users who
 * installed TeXRA from a .dmg or .exe often do not have. When the system
 * package manager also ships the CLI, offer that command instead.
 *
 * `win32` takes precedence over any package manager: a global npm install
 * leaves only shell shims on Windows, which TeXRA cannot spawn (see
 * support/externalBinaryUtils.ts), so a CLI with a Windows installer uses it.
 *
 * Only managers this command map names are probed, so a Linux box with both
 * apt and Linuxbrew still gets the brew command rather than npm.
 *
 * Definitions call this from an `installCommand` getter so the probe stays
 * lazy — `hasPackageManager()` probes once per manager and caches, so reading
 * the property repeatedly costs nothing after the first access.
 */
export function preferredInstallCommand(
  commands: Partial<Record<SystemPackageManager | 'win32', string>> & {
    default: string;
  },
): string {
  if (commands.win32 != null && IS_WINDOWS) return commands.win32;
  for (const manager of SYSTEM_PACKAGE_MANAGERS) {
    const command = commands[manager];
    if (command != null && hasPackageManager(manager)) return command;
  }
  return commands.default;
}
