/**
 * External tool availability checks with caching.
 *
 * Runs every group's checks concurrently — one shared `probe` per group feeds
 * its `check` (availability), `statusLabel` (badge), and `detailCheck`
 * (human-readable detail) — caches the results, and broadcasts
 * `toolAvailabilityChanged` when inputs change so subscribed UIs refresh
 * without re-probing. Tool definitions (what to check + UI metadata) live in
 * {@link @tools/externalToolDefs}.
 *
 * Used by:
 *   - Tool dashboard — runs fresh checks via `runExternalToolChecks()`
 *   - Agent tool resolver — reads the last results via
 *     `getUnavailableToolNamesCached()`
 */

// Third-party imports
import { Deferred, Effect } from 'effect';

// Local imports
import { hostPort } from '@common/hostPort';
import { appSignals } from '@eventBus/AppSignals';
import { createLog } from '@logger/logUtils';
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { RegisteredToolName } from '@tools/registry';
import {
  EXTERNAL_TOOL_DEFS,
  type ExternalToolDef,
} from '@tools/externalToolDefs';
import { getDisabledToolIds } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('toolAvailability');

// ============================================================
// Result type
// ============================================================

/** Result of running a single external tool check. */
export interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly RegisteredToolName[];
  readonly name: string;
  readonly status: 'available' | 'not-found' | 'unknown';
  /** Raw external dependency probe result; null when the probe failed. */
  readonly detected: boolean | null;
  /** Short status label for the dashboard badge, when the default is too generic. */
  readonly statusLabel?: string;
  /** Human-readable status detail from the group's `detailCheck`, if any. */
  readonly statusDetail?: string;
}

// ============================================================
// Check execution + cache
// ============================================================

/** Last check results — the only source for availability answers. */
let lastResults: ExternalToolCheckResult[] | null = null;

/** The disabled tool names, from the process global state the caller holds. */
export function getDisabledToolNames(
  globalState: StateStore,
): ReadonlySet<string> {
  const disabledIds = getDisabledToolIds(globalState);
  const disabled = new Set<string>();
  for (const def of EXTERNAL_TOOL_DEFS) {
    if (!disabledIds.has(def.id)) continue;
    for (const toolName of def.tools) disabled.add(toolName);
  }
  return disabled;
}

/**
 * Seed the disabled-tool list for first-time users only, on any host.
 *
 * Every tool group flagged `toggleable: true` in EXTERNAL_TOOL_DEFS is
 * treated as opt-in and seeded as disabled on a fresh install. Callers pass
 * the global state store they already hold, and must invoke this before
 * anything writes `versionStateKey` (each host's bundled-agent-directory
 * sync) — the combined absence of that key and DISABLED_TOOLS is how a
 * genuinely fresh install is told apart from an existing, upgrading user who
 * simply never toggled a tool; re-seeding the latter would silently disable
 * tools they already had enabled.
 * `versionStateKey` differs per host (e.g. `LAST_KNOWN_VERSION` for
 * the extension/desktop, `CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION` for the
 * CLI) because each tracks its own bundled-agent version independently.
 */
export const seedDisabledToolDefaults = Effect.fn('seedDisabledToolDefaults')(
  function* (state: StateStore, versionStateKey: string) {
    const lastKnownVersion = state.get<string>(versionStateKey);
    const disabledTools = state.get<string[]>(GlobalStateKey.DISABLED_TOOLS);
    if (lastKnownVersion !== undefined || disabledTools !== undefined) return;

    const defaults = EXTERNAL_TOOL_DEFS.filter((def) => def.toggleable).map(
      (def) => def.id,
    );
    yield* hostPort(() =>
      state.update(GlobalStateKey.DISABLED_TOOLS, defaults),
    );
    log.info(
      `First install: default-disabled toggleable tools: ${defaults.join(', ')}`,
    );
  },
);

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
let inflightProbe: Deferred.Deferred<ExternalToolCheckResult[]> | null = null;
let pendingRerun = false;
export function runExternalToolChecks(): Effect.Effect<
  ExternalToolCheckResult[]
> {
  return Effect.suspend(() => {
    if (inflightProbe) {
      pendingRerun = true;
      return Deferred.await(inflightProbe);
    }
    // The deferred is claimed here, synchronously, before the first suspension
    // point: a caller that arrives while this probe runs must find the slot
    // taken and join it rather than start a second probe.
    const deferred = Deferred.makeUnsafe<ExternalToolCheckResult[]>();
    inflightProbe = deferred;
    return probeUntilSettled.pipe(
      Effect.onExit((exit) => {
        inflightProbe = null;
        return Deferred.done(deferred, exit);
      }),
    );
  });
}

const probeUntilSettled = Effect.gen(function* () {
  let results: ExternalToolCheckResult[] = [];
  do {
    pendingRerun = false;
    results = yield* runProbes;
    lastResults = results;
  } while (pendingRerun);
  return results;
});

const runProbes: Effect.Effect<ExternalToolCheckResult[]> = Effect.suspend(() =>
  // Same fan-out as the Promise.all this replaces: every group probes at once
  // and no group's failure cancels a sibling, because each one resolves to a
  // result of its own below.
  Effect.forEach(EXTERNAL_TOOL_DEFS, probeToolGroup, {
    concurrency: 'unbounded',
  }),
);

const probeToolGroup = Effect.fn('probeToolGroup')(function* ({
  id,
  tools,
  name,
  probe,
  check,
  statusLabel: getStatusLabel,
  detailCheck,
}: ExternalToolDef): Effect.fn.Return<ExternalToolCheckResult, never> {
  // Run check/status/detail from one shared probe result. Some groups
  // (Codex, Zotero, GitHub PR) touch async local state, so running the
  // callbacks independently can duplicate the same probe work.
  const probed = yield* Effect.gen(function* () {
    const probeResult = probe ? yield* probe() : undefined;
    const available = yield* check(probeResult);
    return { failure: undefined, probeResult, available };
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn(`Availability probe failed for ${name}`, { data: error });
        return { failure: { error }, probeResult: undefined, available: false };
      }),
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
    tools,
    name,
    status,
    detected: status === 'unknown' ? null : status === 'available',
    statusLabel,
    statusDetail,
  };
});

function resolveOptionalStatus(
  getStatus:
    | ((probeResult?: unknown) => Effect.Effect<string | undefined, unknown>)
    | undefined,
  probeResult: unknown,
  toolName: string,
  field: string,
): Effect.Effect<string | undefined> {
  if (!getStatus) return Effect.succeed(undefined);
  return getStatus(probeResult).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn(`Failed to resolve ${field} for ${toolName}`, { data: error });
        return undefined;
      }),
    ),
  );
}

/** Build the set of unavailable tool names from external check results only. */
function buildUnavailableSet(
  results: ExternalToolCheckResult[],
): ReadonlySet<string> {
  const unavailable = new Set<string>();
  for (const { tools, status } of results) {
    if (status === 'not-found') {
      for (const t of tools) unavailable.add(t);
    }
  }
  return unavailable;
}

/**
 * Return the last check results without re-probing. Returns null if
 * checks haven't been run yet.
 */
export function getLastCheckResults(): ExternalToolCheckResult[] | null {
  return lastResults;
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
  function* () {
    yield* runExternalToolChecks();
    appSignals.emit('toolAvailabilityChanged', undefined);
  },
);

/**
 * Non-blocking read — derives the unavailable tool names from the last check
 * results, or an empty set if no probe has completed yet. Never triggers I/O.
 *
 * Only includes tools whose external dependency is missing (not-found).
 * Disabled tools are NOT included — the caller handles those separately
 * via {@link getDisabledToolNames}.
 *
 * Used by the agent tool resolver to avoid blocking the first tool-use
 * flow on network probes. External tools that are actually missing will
 * fail at call time with a clear error — same as pre-dashboard behavior.
 */
export function getUnavailableToolNamesCached(): ReadonlySet<string> {
  return lastResults ? buildUnavailableSet(lastResults) : new Set();
}
