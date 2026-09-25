/**
 * External tool availability checks with caching.
 *
 * Runs every group's checks concurrently — one shared `probe` per group feeds
 * its `check` (availability), `statusLabel` (badge), and `detailCheck`
 * (human-readable detail) — caches the results, and broadcasts
 * `toolAvailabilityChanged` when inputs change so subscribed UIs refresh
 * without re-probing. What to check is each plugin's `availability` in
 * {@link @tools/plugins}.
 *
 * Used by:
 *   - Tool dashboard — runs fresh checks via `runExternalToolChecks()`
 *   - Agent tool resolver — reads the last results via
 *     `getUnavailableToolNamesCached()`
 *
 * The cache is keyed by workspace root: the probes read the workspace (the
 * GitHub group asks whether it is a git repository, Zotero reads its
 * configuration), so on a multi-project host one workspace's results must
 * not answer for another's.
 */

// Third-party imports
import { Cause, Duration, Effect } from 'effect';

// Local imports
import { emitAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { TOOL_PLUGINS, type ToolPlugin } from '@tools/plugins';
import type {
  ToolAvailabilityChecks,
  ToolProbeError,
  ToolProbeInputs,
  ToolProbeServices,
} from '@tools/toolProbes';
import { SharedAttempt } from '@utils/core/sharedAttempt';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'toolAvailability';

/**
 * Deadline on one group's probe and check. The probe runs detached from its
 * callers ({@link SharedAttempt}), so no caller's interrupt can end a stalled
 * child-process lookup or SDK import: without this bound one hung group would
 * hold the shared slot, and every caller joining it, indefinitely. A group
 * that misses it reports `unknown`, like any other probe failure.
 */
const GROUP_PROBE_TIMEOUT_MS = 20_000;

// ============================================================
// Result type
// ============================================================

/** Result of running a single external tool check. */
export interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly string[];
  readonly name: string;
  readonly status: 'available' | 'not-found' | 'unknown';
  /** Short status label for the dashboard badge, when the default is too generic. */
  readonly statusLabel?: string;
  /** Human-readable status detail from the group's `detailCheck`, if any. */
  readonly statusDetail?: string;
}

// ============================================================
// Check execution + cache
// ============================================================

/** A plugin with an external dependency to probe. */
type ProbedToolPlugin = ToolPlugin & {
  readonly availability: ToolAvailabilityChecks;
};

/** The plugins the availability layer probes, in manifest order. */
const PROBED_PLUGINS = TOOL_PLUGINS.filter(
  (plugin): plugin is ProbedToolPlugin => plugin.availability !== undefined,
);

/**
 * Seed the disabled-tool list for first-time users only, on any host.
 *
 * Every plugin flagged `toggleable: true` in TOOL_PLUGINS is treated as
 * opt-in and seeded as disabled on a fresh install. Callers pass
 * the global state store they already hold. DISABLED_TOOLS is its own
 * fresh-install signal, because this seed is the only thing that writes it
 * before the user does: an absent value means neither the seed nor the user
 * has ever set the list, and a present one (an empty list included) means the
 * user's choices are already recorded, so re-seeding would silently disable
 * tools they had enabled.
 */
export const seedDisabledToolDefaults = Effect.fn('seedDisabledToolDefaults')(
  function* (state: StateStore) {
    const disabledTools = yield* state.get<string[]>(
      GlobalStateKey.DISABLED_TOOLS,
    );
    if (disabledTools !== undefined) return;

    const defaults = TOOL_PLUGINS.filter((plugin) => plugin.toggleable).map(
      (plugin) => plugin.id,
    );
    yield* state.update(GlobalStateKey.DISABLED_TOOLS, defaults);
    yield* Effect.logInfo(
      `First install: default-disabled toggleable tools: ${defaults.join(', ')}`,
    ).pipe(withLogChannel(CHANNEL));
  },
);

/**
 * Coalescing cache of one workspace's last probe results — the only source
 * for its availability answers. Encapsulated as a class, not bare module-level
 * `let`s, per AGENTS.md "No bare module-level mutable singletons in tested
 * code"; same shape as `AnnotationFetchBudget` in
 * `@tools/github/annotationFetchBudget`.
 */
class ToolAvailabilityCache {
  private lastResults: ExternalToolCheckResult[] | null = null;
  private readonly probes = new SharedAttempt<
    ExternalToolCheckResult[],
    never
  >();
  private pendingRerun = false;

  /**
   * Run all external tool checks in parallel. See {@link runExternalToolChecks}
   * for the full coalescing contract this implements.
   */
  runChecks(
    inputs: ToolProbeInputs,
  ): Effect.Effect<ExternalToolCheckResult[], never, ToolProbeServices> {
    return Effect.suspend(() => {
      if (this.probes.inFlight) this.pendingRerun = true;
      return this.probes.run(() => this.probeUntilSettled(inputs));
    });
  }

  /** Recurses instead of looping: a caller joining mid-probe can set
   *  `pendingRerun` again before this settles, same as the `do...while` it
   *  replaces. */
  private probeUntilSettled(
    inputs: ToolProbeInputs,
  ): Effect.Effect<ExternalToolCheckResult[], never, ToolProbeServices> {
    this.pendingRerun = false;
    // Every group probes at once and no group's failure cancels a sibling,
    // because each one resolves to a result of its own.
    return Effect.forEach(
      PROBED_PLUGINS,
      (plugin) => probeToolGroup(plugin, inputs),
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.flatMap((results) => {
        this.lastResults = results;
        return this.pendingRerun
          ? this.probeUntilSettled(inputs)
          : Effect.succeed(results);
      }),
    );
  }

  /** Read the last check results without re-probing. */
  getLastResults(): ExternalToolCheckResult[] | null {
    return this.lastResults;
  }
}

/**
 * Process-wide, one cache per workspace root (`undefined` = no folder open),
 * created on first use; same lifetime as the module.
 */
const toolAvailabilityCaches = new Map<
  string | undefined,
  ToolAvailabilityCache
>();

function cacheFor(workspaceRoot: string | undefined): ToolAvailabilityCache {
  let cache = toolAvailabilityCaches.get(workspaceRoot);
  if (!cache) {
    cache = new ToolAvailabilityCache();
    toolAvailabilityCaches.set(workspaceRoot, cache);
  }
  return cache;
}

/**
 * Run all external tool checks in parallel.
 * Always returns fresh `check` + `detailCheck` probes and updates the
 * availability cache.
 *
 * Concurrent calls are coalesced: while a probe is in flight, additional
 * callers join the same deferred and receive its results. If any caller
 * arrives AFTER the active probe started reading inputs, a follow-up probe
 * is scheduled so the cache ultimately reflects the most recent state and
 * a stale probe can't overwrite a fresh one by finishing last.
 *
 * Called by the tool dashboard (needs per-group results) and
 * {@link refreshToolAvailability}. Also populates the cache read by
 * `getUnavailableToolNamesCached()`.
 *
 * @returns Per-group results with availability status and an optional
 *   human-readable `statusDetail`.
 */
export function runExternalToolChecks(
  inputs: ToolProbeInputs,
): Effect.Effect<ExternalToolCheckResult[], never, ToolProbeServices> {
  return cacheFor(inputs.workspaceRoot).runChecks(inputs);
}

const probeToolGroup = Effect.fn('probeToolGroup')(function* (
  {
    id,
    toolNames,
    name,
    availability: { probe, check, statusLabel: getStatusLabel, detailCheck },
  }: ProbedToolPlugin,
  inputs: ToolProbeInputs,
): Effect.fn.Return<ExternalToolCheckResult, never, ToolProbeServices> {
  // Run check/status/detail from one shared probe result. Some groups
  // (Codex, Zotero, GitHub PR) touch async local state, so running the
  // callbacks independently can duplicate the same probe work.
  const probed = yield* Effect.gen(function* () {
    const probeResult = probe ? yield* probe(inputs) : undefined;
    const available = yield* check(probeResult);
    return { failure: undefined, probeResult, available };
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(GROUP_PROBE_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new Cause.TimeoutError(
            `timed out after ${GROUP_PROBE_TIMEOUT_MS / 1000}s`,
          ),
        ),
    }),
    Effect.catch((error) =>
      Effect.logWarning(`Availability probe failed for ${name}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as({
          failure: { error },
          probeResult: undefined,
          available: false,
        }),
      ),
    ),
  );
  const detectedStatus = probed.available ? 'available' : 'not-found';
  const status: ExternalToolCheckResult['status'] = probed.failure
    ? 'unknown'
    : detectedStatus;
  const statusDetail = probed.failure
    ? `Availability check failed: ${toErrorMessage(probed.failure.error)}`
    : yield* resolveOptionalStatus(
        detailCheck,
        probed.probeResult,
        name,
        'status detail',
      );
  const statusLabel = probed.failure
    ? undefined
    : yield* resolveOptionalStatus(
        getStatusLabel,
        probed.probeResult,
        name,
        'status label',
      );
  return {
    id,
    tools: toolNames,
    name,
    status,
    statusLabel,
    statusDetail,
  };
});

function resolveOptionalStatus(
  getStatus:
    | ((
        probeResult?: unknown,
      ) => Effect.Effect<string | undefined, ToolProbeError, ToolProbeServices>)
    | undefined,
  probeResult: unknown,
  toolName: string,
  field: string,
): Effect.Effect<string | undefined, never, ToolProbeServices> {
  if (!getStatus) return Effect.succeed(undefined);
  return getStatus(probeResult).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Failed to resolve ${field} for ${toolName}`).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as(undefined),
      ),
    ),
  );
}

/**
 * Return the workspace's last check results without re-probing. Returns null
 * if checks haven't been run for that workspace yet.
 */
export function getLastCheckResults(
  workspaceRoot: string | undefined,
): ExternalToolCheckResult[] | null {
  return toolAvailabilityCaches.get(workspaceRoot)?.getLastResults() ?? null;
}

/**
 * Re-probe external tools and broadcast `toolAvailabilityChanged` so any
 * subscribed UI (Tools tab) and runtime caches refresh. Call this whenever
 * an input to the availability checks changes (GitHub token, workspace
 * git-repo status, extension install state) — mutators don't have to know
 * which UIs depend on the result.
 *
 * Coalescing and follow-up-probe scheduling happen inside
 * `runExternalToolChecks`, so the dashboard-load probe and a refresh-triggered
 * probe can't race.
 */
export const refreshToolAvailability = Effect.fn('refreshToolAvailability')(
  function* (inputs: ToolProbeInputs) {
    yield* runExternalToolChecks(inputs);
    emitAppSignal('toolAvailabilityChanged', undefined);
  },
);

/**
 * Non-blocking read — derives the unavailable tool names from the workspace's
 * last check results, or an empty set if no probe has completed for it yet.
 * Never triggers I/O.
 *
 * Only includes tools whose external dependency is missing (not-found).
 * Disabled tools are NOT included — the caller handles those separately
 * as the switched-off plugins of the run's composition (`@tools/composition`).
 *
 * Used by the agent tool resolver to avoid blocking the first tool-use
 * flow on network probes. External tools that are actually missing will
 * fail at call time with a clear error — same as pre-dashboard behavior.
 */
export function getUnavailableToolNamesCached(
  workspaceRoot: string | undefined,
): ReadonlySet<string> {
  return new Set<string>(
    (getLastCheckResults(workspaceRoot) ?? [])
      .filter((result) => result.status === 'not-found')
      .flatMap((result) => result.tools),
  );
}
