/**
 * External tool availability checks with caching.
 *
 * Runs `check` (main probe) and `detailCheck` (human-readable detail) in
 * parallel, caches the results, and broadcasts `toolAvailabilityChanged`
 * when inputs change so subscribed UIs refresh without re-probing. Tool
 * definitions (what to check + UI metadata) live in
 * {@link @tools/externalToolDefs}.
 *
 * Used by:
 *   - Tool dashboard — runs fresh checks via `runExternalToolChecks()`
 *   - Agent tool resolver — reads the last results via
 *     `getUnavailableToolNamesCached()`
 */

// Local imports
import { appSignals } from '@eventBus/AppSignals';
import * as logger from '@logger/logUtils';
import { tryGlobalState } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { RegisteredToolName } from '@tools/registry';
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';
import { getDisabledToolIds } from '@utils/config/constants';

// ============================================================
// Result type
// ============================================================

/** Result of running a single external tool check. */
export interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly RegisteredToolName[];
  readonly name: string;
  readonly status: 'available' | 'not-found' | 'unknown' | 'coming-soon';
  /** Raw external dependency probe result, independent of presentation-only statuses. */
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

/** Read the current set of disabled tool names from persisted Settings state. */
export function getDisabledToolNames(): ReadonlySet<string> {
  const disabledIds = getDisabledToolIds();
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
 * treated as opt-in and seeded as disabled on a fresh install. Callers must
 * invoke this after `initPlatform()` and before anything writes
 * `versionStateKey` (each host's bundled-agent-directory sync) — the combined
 * absence of that key and DISABLED_TOOLS is how a genuinely fresh install is
 * told apart from an existing, upgrading user who simply never toggled a
 * tool; re-seeding the latter would silently disable tools they already had
 * enabled. `versionStateKey` differs per host (e.g. `LAST_KNOWN_VERSION` for
 * the extension/desktop, `CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION` for the
 * CLI) because each tracks its own bundled-agent version independently.
 */
export async function seedDisabledToolDefaults(
  versionStateKey: string,
): Promise<void> {
  const state = tryGlobalState();
  if (!state) return;

  const lastKnownVersion = state.get<string>(versionStateKey);
  const disabledTools = state.get<string[]>(GlobalStateKey.DISABLED_TOOLS);
  if (lastKnownVersion !== undefined || disabledTools !== undefined) return;

  const defaults = EXTERNAL_TOOL_DEFS.filter((def) => def.toggleable).map(
    (def) => def.id,
  );
  await state.update(GlobalStateKey.DISABLED_TOOLS, defaults);
  logger.info(
    'toolAvailability',
    `First install: default-disabled toggleable tools: ${defaults.join(', ')}`,
  );
}

/**
 * Run all external tool checks in parallel.
 * Always returns fresh `check` + `detailCheck` probes and updates the
 * availability cache.
 *
 * Concurrent calls are coalesced: while a probe is in flight, additional
 * callers share the same Promise and receive its results. If any caller
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
let inflightProbe: Promise<ExternalToolCheckResult[]> | null = null;
let pendingRerun = false;
export function runExternalToolChecks(): Promise<ExternalToolCheckResult[]> {
  if (inflightProbe) {
    pendingRerun = true;
    return inflightProbe;
  }
  inflightProbe = (async () => {
    let results: ExternalToolCheckResult[] = [];
    try {
      do {
        pendingRerun = false;
        results = await runProbes();
        lastResults = results;
      } while (pendingRerun);
    } finally {
      inflightProbe = null;
    }
    return results;
  })();
  return inflightProbe;
}

async function runProbes(): Promise<ExternalToolCheckResult[]> {
  return Promise.all(
    EXTERNAL_TOOL_DEFS.map(
      async ({
        id,
        tools,
        name,
        probe,
        check,
        statusLabel: getStatusLabel,
        detailCheck,
        comingSoon,
      }): Promise<ExternalToolCheckResult> => {
        // Run check/status/detail from one shared probe result. Some groups
        // (Codex, Zotero, GitHub PR) touch async local state, so running the
        // callbacks independently can duplicate the same probe work.
        let probeResult: unknown;
        let probedStatus: 'available' | 'not-found' | 'unknown';
        try {
          probeResult = await probe?.();
          probedStatus = (await check(probeResult)) ? 'available' : 'not-found';
        } catch {
          probedStatus = 'unknown';
        }
        const statusDetail = await resolveOptionalStatus(
          detailCheck,
          probeResult,
        );
        const statusLabel = await resolveOptionalStatus(
          getStatusLabel,
          probeResult,
        );
        return {
          id,
          tools,
          name,
          status: comingSoon ? 'coming-soon' : probedStatus,
          detected:
            probedStatus === 'unknown' ? null : probedStatus === 'available',
          statusLabel,
          statusDetail,
        };
      },
    ),
  );
}

async function resolveOptionalStatus(
  getStatus:
    ((probeResult?: unknown) => Promise<string | undefined>) | undefined,
  probeResult: unknown,
): Promise<string | undefined> {
  if (!getStatus) return undefined;
  return getStatus(probeResult).catch(() => undefined);
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
export async function refreshToolAvailability(): Promise<void> {
  await runExternalToolChecks();
  appSignals.emit('toolAvailabilityChanged', undefined);
}

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
