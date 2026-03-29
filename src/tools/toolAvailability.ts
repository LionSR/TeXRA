/**
 * External tool availability checks with caching.
 *
 * Pure service — runs checks, manages cache, returns results.
 * Tool definitions (what to check + UI metadata) live in
 * {@link @tools/externalToolDefs}.
 *
 * Used by:
 *   - Tool dashboard — runs fresh checks via `runExternalToolChecks()`
 *   - Agent tool resolver — reads cache via `getUnavailableToolNamesCached()`
 */

// Local imports
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
  readonly status: 'available' | 'not-found' | 'unknown';
}

// ============================================================
// Check execution + cache
// ============================================================

/** Cached set of unavailable tool names. */
let cached: ReadonlySet<string> | null = null;

/**
 * Run all external tool checks in parallel.
 * Always performs fresh checks and updates the availability cache.
 *
 * Called by the tool dashboard (needs per-group results).
 * Also populates the cache read by `getUnavailableToolNamesCached()`.
 *
 * @returns Per-group results with `available` / `not-found` / `unknown` status.
 */
export async function runExternalToolChecks(): Promise<
  ExternalToolCheckResult[]
> {
  const results = await Promise.all(
    EXTERNAL_TOOL_DEFS.map(
      async ({ id, tools, name, check }): Promise<ExternalToolCheckResult> => {
        try {
          const available = await check();
          return {
            id,
            tools,
            name,
            status: available ? 'available' : 'not-found',
          };
        } catch {
          return { id, tools, name, status: 'unknown' };
        }
      },
    ),
  );

  // Update cache — exclude tools whose check failed AND user-disabled tools.
  const unavailable = new Set<string>();
  const disabledIds = getDisabledToolIds();
  for (const r of results) {
    if (r.status === 'not-found') {
      for (const t of r.tools) unavailable.add(t);
    }
  }
  // User-disabled tool groups: look up their tool names from definitions
  for (const def of EXTERNAL_TOOL_DEFS) {
    if (disabledIds.has(def.id)) {
      for (const t of def.tools) unavailable.add(t);
    }
  }
  cached = unavailable;

  return results;
}

/**
 * Non-blocking cache read — returns cached unavailable tool names if
 * checks have already completed, or an empty set if the cache isn't
 * populated yet. Never triggers I/O.
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
      });
    }
  }
  return groups;
}
