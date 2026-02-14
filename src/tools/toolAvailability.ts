/**
 * External tool availability checks with caching.
 *
 * Single source of truth for which external tools are installed.
 * Used by:
 *   - Tool dashboard (UI) — always runs fresh checks via `runExternalToolChecks()`
 *   - Agent tool resolver — reads cached results via `getUnavailableToolNames()`
 */

// Third-party imports
import * as vscode from 'vscode';
import axios from 'axios';

// Local imports
import { getZoteroPort } from '@tools/zotero/bbtClient';
import { checkToolInstalled } from '@utils/system/toolUtils';

// ============================================================
// Check definitions
// ============================================================

/** Defines how to check whether an external tool group is available. */
export interface ExternalToolCheck {
  /** Unique group identifier (matches ToolDashboardItem.id). */
  readonly id: string;
  /** Tool names belonging to this group. */
  readonly tools: readonly string[];
  /** Human-readable group name (for user-facing notifications). */
  readonly label: string;
  /** Returns true if the external dependency is available. */
  readonly check: () => Promise<boolean>;
}

/** Result of running a single external tool check. */
export interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly string[];
  readonly label: string;
  readonly status: 'available' | 'not-found' | 'unknown';
}

/** All external tool groups and their availability checks. */
export const EXTERNAL_TOOL_CHECKS: readonly ExternalToolCheck[] = [
  {
    id: 'texcount',
    tools: ['texcount'],
    label: 'TeXcount',
    check: () => checkToolInstalled('texcount', false),
  },
  {
    id: 'wolfram',
    tools: ['wolfram'],
    label: 'Wolfram Language',
    check: () => checkToolInstalled('wolframscript', false),
  },
  {
    id: 'zotero',
    tools: ['zotero_search', 'zotero_add', 'zotero_export'],
    label: 'Zotero',
    check: async () => {
      try {
        const port = getZoteroPort();
        await axios.get(`http://localhost:${port}/better-bibtex/json-rpc`, {
          timeout: 2000,
        });
        return true;
      } catch (error: unknown) {
        // 405 Method Not Allowed means the server is running but expects POST —
        // any HTTP response from the endpoint means Zotero + BBT is available.
        if (axios.isAxiosError(error) && error.response?.status === 405) {
          return true;
        }
        return false;
      }
    },
  },
  {
    id: 'lean4',
    tools: [
      'lean_diagnostics',
      'lean_file',
      'lean_project',
      'lean_inspect',
      'lean_loogle',
    ],
    label: 'Lean 4',
    check: async () => {
      const lean4Ext = vscode.extensions.getExtension('leanprover.lean4');
      return lean4Ext !== undefined;
    },
  },
];

// ============================================================
// Check execution + cache
// ============================================================

/** Cached unavailable tool names and their group labels. */
let cache: { unavailable: Set<string>; labels: string[] } | null = null;

/**
 * Run all external tool checks in parallel.
 * Always performs fresh checks and updates the internal cache.
 *
 * @returns Per-group results with `available` / `not-found` / `unknown` status.
 */
export async function runExternalToolChecks(): Promise<
  ExternalToolCheckResult[]
> {
  const results = await Promise.all(
    EXTERNAL_TOOL_CHECKS.map(
      async ({ id, tools, label, check }): Promise<ExternalToolCheckResult> => {
        try {
          const available = await check();
          return {
            id,
            tools,
            label,
            status: available ? 'available' : 'not-found',
          };
        } catch {
          return { id, tools, label, status: 'unknown' };
        }
      },
    ),
  );

  // Update cache as a side effect
  const unavailable = new Set<string>();
  const labels: string[] = [];
  for (const r of results) {
    if (r.status !== 'available') {
      r.tools.forEach((t) => unavailable.add(t));
      labels.push(r.label);
    }
  }
  cache = { unavailable, labels };

  return results;
}

/**
 * Get the set of external tool names that are currently unavailable.
 *
 * Uses the cached result from the most recent `runExternalToolChecks()` call.
 * If no cached data exists, runs a fresh check first.
 */
export async function getUnavailableToolNames(): Promise<ReadonlySet<string>> {
  if (cache) return cache.unavailable;
  await runExternalToolChecks();
  return cache!.unavailable;
}

/**
 * Get the human-readable labels of unavailable tool groups that were
 * actually requested by an agent. Used for user-facing notifications.
 *
 * @param excludedToolNames - Tool names that were excluded during resolution.
 */
export function getExcludedToolLabels(
  excludedToolNames: ReadonlySet<string>,
): string[] {
  return EXTERNAL_TOOL_CHECKS.filter((c) =>
    c.tools.some((t) => excludedToolNames.has(t)),
  ).map((c) => c.label);
}

/** Clear the cached availability data. Next access will re-check. */
export function invalidateToolAvailability(): void {
  cache = null;
}
