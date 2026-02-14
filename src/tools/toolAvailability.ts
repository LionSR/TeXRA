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
import type { ToolCategory } from '@shared/schemas/settingsViewMessages';
import type { RegisteredToolName } from '@tools/registry';
import { getZoteroPort } from '@tools/zotero/bbtClient';
import { checkToolInstalled } from '@utils/system/toolUtils';

// ============================================================
// Check definitions
// ============================================================

/** Defines an external tool group: runtime check + dashboard UI metadata. */
export interface ExternalToolCheck {
  /** Unique group identifier (matches ToolDashboardItem.id). */
  readonly id: string;
  /** Tool names belonging to this group — must match registry keys. */
  readonly tools: readonly RegisteredToolName[];
  /** Human-readable display name. */
  readonly name: string;
  /** Returns true if the external dependency is available. */
  readonly check: () => Promise<boolean>;
  // Dashboard UI metadata
  readonly category: ToolCategory;
  readonly description: string;
  readonly installGuide?: string;
  readonly installUrl?: string;
  readonly configNotes?: string;
}

/** Result of running a single external tool check. */
export interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly string[];
  readonly name: string;
  readonly status: 'available' | 'not-found' | 'unknown';
}

/** All external tool groups — single source of truth for checks and UI metadata. */
export const EXTERNAL_TOOL_CHECKS: readonly ExternalToolCheck[] = [
  {
    id: 'texcount',
    tools: ['texcount'],
    name: 'TeXcount',
    category: 'latex',
    description:
      'Count words, headers, figures, and other elements in LaTeX documents.',
    installGuide:
      'TeXcount is a Perl script for counting words in LaTeX files.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install texcount\n' +
      '  Ubuntu:  sudo apt-get install texlive-extra-utils\n' +
      '  Windows: Install via MiKTeX or TeX Live package manager',
    installUrl: 'https://app.uio.no/ifi/texcount/',
    configNotes: 'Part of most TeX Live distributions.',
    check: () => checkToolInstalled('texcount', false),
  },
  {
    id: 'wolfram',
    tools: ['wolfram'],
    name: 'Wolfram Language',
    category: 'computation',
    description:
      'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
    installGuide:
      'Requires WolframScript or the Wolfram Engine.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install wolfram-engine\n' +
      '  Ubuntu:  sudo apt-get install wolfram-engine\n' +
      '  Windows: Download from wolfram.com/engine\n\n' +
      'Free Wolfram Engine licenses are available for development use.',
    installUrl: 'https://www.wolfram.com/engine/',
    configNotes:
      'Requires a free Wolfram Engine license or Mathematica installation.',
    check: () => checkToolInstalled('wolframscript', false),
  },
  {
    id: 'zotero',
    tools: ['zotero_search', 'zotero_add', 'zotero_export'],
    name: 'Zotero Integration',
    category: 'academic',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    installGuide:
      'Requires Zotero with the Better BibTeX plugin installed.\n\n' +
      'Setup:\n' +
      '  1. Install Zotero (zotero.org)\n' +
      '  2. Install Better BibTeX plugin:\n' +
      '     - Download from retorque.re/zotero-better-bibtex\n' +
      '     - In Zotero: Tools > Add-ons > Install from File\n' +
      '  3. Keep Zotero running while using TeXRA\n\n' +
      'Better BibTeX exposes a JSON-RPC API on localhost:23119\n' +
      'that TeXRA uses to communicate with your library.',
    installUrl: 'https://retorque.re/zotero-better-bibtex/installation/',
    configNotes:
      'Zotero must be running with Better BibTeX installed. Port configurable via texra.bib.zoteroPort.',
    check: async () => {
      try {
        const port = getZoteroPort();
        await axios.get(`http://127.0.0.1:${port}/better-bibtex/json-rpc`, {
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
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, search Loogle, and manage files.',
    installGuide:
      'Requires the Lean 4 VS Code extension (leanprover.lean4).\n\n' +
      'Setup:\n' +
      '  1. Install the "lean4" extension from VS Code Marketplace\n' +
      '  2. Open a Lean 4 project (with lakefile.lean)\n' +
      '  3. The extension will auto-install elan and Lean toolchain\n\n' +
      'The Lean tools communicate via the Lean Language Server\n' +
      'provided by the VS Code extension.',
    installUrl:
      'https://marketplace.visualstudio.com/items?itemName=leanprover.lean4',
    configNotes: 'Lean 4 VS Code extension must be installed and active.',
    check: async () => {
      const lean4Ext = vscode.extensions.getExtension('leanprover.lean4');
      return lean4Ext !== undefined;
    },
  },
];

// ============================================================
// Check execution + cache
// ============================================================

/** Fail-closed fallback — if checks cannot run, all external tools are unavailable. */
const ALL_EXTERNAL_TOOLS: ReadonlySet<string> = new Set(
  EXTERNAL_TOOL_CHECKS.flatMap((c) => [...c.tools]),
);

/** Cached set of unavailable tool names. */
let cached: ReadonlySet<string> | null = null;

/**
 * In-flight dedup promise, owned exclusively by `getUnavailableToolNames()`.
 * `runExternalToolChecks()` never touches this — so a direct dashboard call
 * cannot break the dedup for concurrent agent callers.
 */
let inflight: Promise<ExternalToolCheckResult[]> | null = null;

/**
 * Run all external tool checks in parallel.
 * Always performs fresh checks and updates the availability cache.
 *
 * Called directly by the tool dashboard (needs per-group results)
 * and indirectly by `getUnavailableToolNames()` (needs the cache side-effect).
 *
 * @returns Per-group results with `available` / `not-found` / `unknown` status.
 */
export async function runExternalToolChecks(): Promise<
  ExternalToolCheckResult[]
> {
  const results = await Promise.all(
    EXTERNAL_TOOL_CHECKS.map(
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

  // Update cache — last writer wins, which is fine since fresher data is always better
  const unavailable = new Set<string>();
  for (const r of results) {
    if (r.status !== 'available') {
      r.tools.forEach((t) => unavailable.add(t));
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

/**
 * Get the set of external tool names that are currently unavailable.
 *
 * Returns cached results when available. Concurrent callers share a
 * single in-flight check (promise dedup) to avoid duplicate work.
 * Fails closed — if checks cannot complete, all external tools are
 * treated as unavailable rather than silently enabled.
 */
export async function getUnavailableToolNames(): Promise<ReadonlySet<string>> {
  if (cached) return cached;
  if (!inflight) {
    inflight = runExternalToolChecks().finally(() => {
      inflight = null;
    });
  }
  try {
    await inflight;
  } catch {
    return ALL_EXTERNAL_TOOLS;
  }
  return cached ?? ALL_EXTERNAL_TOOLS;
}
