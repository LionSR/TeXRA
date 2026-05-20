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
 *   - Agent tool resolver — reads cache via `getUnavailableToolNamesCached()`
 */

// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
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
  /** Short status label for the dashboard badge, when the default is too generic. */
  readonly statusLabel?: string;
  /** Human-readable status detail from the group's `detailCheck`, if any. */
  readonly statusDetail?: string;
}

// ============================================================
// Check execution + cache
// ============================================================

/** Cached set of unavailable tool names. */
let cached: ReadonlySet<string> | null = null;

/** Last check results — kept for rebuilding the cache without re-probing. */
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
        cached = buildUnavailableSet(results);
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
          statusLabel,
          statusDetail,
        };
      },
    ),
  );
}

async function resolveOptionalStatus(
  getStatus:
    | ((probeResult?: unknown) => Promise<string | undefined>)
    | undefined,
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
export async function refreshToolAvailability(
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  await runExternalToolChecks();
  runtimeHost.emit('toolAvailabilityChanged', undefined);
}

/**
 * Rebuild the availability cache from the last check results without
 * re-probing external tools. Called after toggling a tool on/off.
 */
export function refreshDisabledToolCache(): void {
  if (!lastResults) {
    cached = null;
    return;
  }
  cached = buildUnavailableSet(lastResults);
}

/**
 * Non-blocking cache read — returns cached unavailable tool names if
 * checks have already completed, or an empty set if the cache isn't
 * populated yet. Never triggers I/O.
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
  return cached ?? new Set();
}

/** Info about an unavailable tool group, used by the notification layer. */
export interface UnavailableGroupInfo {
  readonly name: string;
  readonly hideFromDashboard: boolean;
  /**
   * Command to execute when the user clicks the "fix this" button in the
   * notification. Overrides the default Tools-Dashboard action so groups
   * whose real configuration lives elsewhere (e.g. GitHub token in the Git
   * tab) can point the user to the right place.
   */
  readonly installActionCommand?: string;
  /** Label for the custom action button (falls back to a sensible default). */
  readonly installActionLabel?: string;
}

/**
 * Map a list of unavailable tool names to their group info
 * (e.g. `["lean_diagnostics", "lean_file"]` → `[{ name: "Lean 4 Proof Assistant", … }]`).
 * Returns deduplicated entries in definition order.
 */
export function mapToolNamesToGroups(
  toolNames: readonly string[],
): UnavailableGroupInfo[] {
  const nameSet = new Set(toolNames);
  const seen = new Set<string>();
  const groups: UnavailableGroupInfo[] = [];
  for (const def of EXTERNAL_TOOL_DEFS) {
    if (seen.has(def.id)) continue;
    if (def.tools.some((t) => nameSet.has(t))) {
      seen.add(def.id);
      groups.push({
        name: def.name,
        hideFromDashboard: def.hideFromDashboard ?? false,
        installActionCommand: def.installActionCommand,
        installActionLabel: def.installActionLabel,
      });
    }
  }
  return groups;
}
