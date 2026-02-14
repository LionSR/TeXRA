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

/** Cached set of unavailable tool names. */
let cached: ReadonlySet<string> | null = null;

/** In-flight check promise — prevents duplicate concurrent checks. */
let inflight: Promise<ExternalToolCheckResult[]> | null = null;

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
  for (const r of results) {
    if (r.status !== 'available') {
      r.tools.forEach((t) => unavailable.add(t));
    }
  }
  cached = unavailable;
  inflight = null;

  return results;
}

/**
 * Get the set of external tool names that are currently unavailable.
 *
 * Returns cached results when available. Concurrent callers share a
 * single in-flight check (promise dedup) to avoid duplicate work.
 */
export async function getUnavailableToolNames(): Promise<ReadonlySet<string>> {
  if (cached) return cached;
  if (!inflight) {
    inflight = runExternalToolChecks();
  }
  await inflight;
  return cached ?? new Set();
}

/** Clear the cached availability data. Next access will re-check. */
export function invalidateToolAvailability(): void {
  cached = null;
  inflight = null;
}
