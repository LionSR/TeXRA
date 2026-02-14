/**
 * Tool dashboard data builder.
 *
 * Defines static UI metadata for all tool groups and delegates runtime
 * availability checks to {@link @tools/toolAvailability}.
 */

// Local imports
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import { runExternalToolChecks } from '@tools/toolAvailability';

// ============================================================
// Static tool metadata
// ============================================================

/** Tool groups that are always available (built-in, no external deps). */
const BUILTIN_TOOLS: Omit<ToolDashboardItem, 'status'>[] = [
  {
    id: 'file-ops',
    name: 'File & Shell Operations',
    category: 'file',
    description:
      'Read, write, edit files and run shell commands. Includes glob/grep search and directory listing.',
    tools: [
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'ls',
      'apply_path',
    ],
    requiresSetup: false,
  },
  {
    id: 'latex-extract',
    name: 'LaTeX Extraction',
    category: 'latex',
    description:
      'Extract figures, TikZ diagrams, and bibliography entries from LaTeX documents.',
    tools: ['extract_figures', 'extract_tikz_figures', 'extract_bib_entries'],
    requiresSetup: false,
  },
  {
    id: 'latex-diagnostics',
    name: 'LaTeX Diagnostics',
    category: 'latex',
    description:
      'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
    tools: ['diagnostics'],
    requiresSetup: false,
  },
  {
    id: 'arxiv',
    name: 'ArXiv Search & Download',
    category: 'academic',
    description:
      'Search arXiv papers, retrieve metadata, and download LaTeX source packages.',
    tools: ['arxiv_search', 'arxiv_metadata', 'download_arxiv_source'],
    requiresSetup: false,
  },
  {
    id: 'crossref',
    name: 'Crossref Citation Lookup',
    category: 'academic',
    description:
      'Search Crossref for academic publications by query or resolve DOIs to full metadata.',
    tools: ['crossref_doi', 'crossref_search'],
    requiresSetup: false,
  },
  {
    id: 'web',
    name: 'Web Search & Fetch',
    category: 'web',
    description:
      'Search the web via DuckDuckGo Instant Answers and fetch/extract content from URLs.',
    tools: ['web_search', 'web_fetch'],
    requiresSetup: false,
  },
  {
    id: 'memory-workflow',
    name: 'Memory, Tasks & Delegation',
    category: 'workflow',
    description:
      'Persistent memory across sessions, task tracking with to-do lists, and delegate work to sub-agents.',
    tools: [
      'memory',
      'todo_write',
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
    requiresSetup: false,
  },
];

/**
 * UI-only metadata for external tool groups.
 * Keyed by group ID (must match {@link EXTERNAL_TOOL_CHECKS} entries).
 */
const EXTERNAL_TOOL_UI: Record<
  string,
  Omit<ToolDashboardItem, 'status' | 'tools'>
> = {
  texcount: {
    id: 'texcount',
    name: 'TeXcount',
    category: 'latex',
    description:
      'Count words, headers, figures, and other elements in LaTeX documents.',
    requiresSetup: true,
    installGuide:
      'TeXcount is a Perl script for counting words in LaTeX files.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install texcount\n' +
      '  Ubuntu:  sudo apt-get install texlive-extra-utils\n' +
      '  Windows: Install via MiKTeX or TeX Live package manager',
    installUrl: 'https://app.uio.no/ifi/texcount/',
    configNotes: 'Part of most TeX Live distributions.',
  },
  wolfram: {
    id: 'wolfram',
    name: 'Wolfram Language',
    category: 'computation',
    description:
      'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
    requiresSetup: true,
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
  },
  zotero: {
    id: 'zotero',
    name: 'Zotero Integration',
    category: 'academic',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    requiresSetup: true,
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
  },
  lean4: {
    id: 'lean4',
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, search Loogle, and manage files.',
    requiresSetup: true,
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
  },
};

// ============================================================
// Public API
// ============================================================

/**
 * Build the complete tool dashboard items list with runtime availability checks.
 *
 * Always runs fresh external checks (and updates the availability cache
 * in {@link @tools/toolAvailability} as a side effect).
 */
export async function buildToolDashboardItems(): Promise<ToolDashboardItem[]> {
  // Built-in tools are always available
  const builtinItems: ToolDashboardItem[] = BUILTIN_TOOLS.map((tool) => ({
    ...tool,
    status: 'available' as const,
  }));

  // Run fresh checks — also updates the availability cache
  const results = await runExternalToolChecks();

  // Merge check results with UI metadata
  const externalItems: ToolDashboardItem[] = [];
  for (const { id, tools, status } of results) {
    const ui = EXTERNAL_TOOL_UI[id];
    if (!ui) continue;
    externalItems.push({ ...ui, tools: [...tools], status });
  }

  return [...builtinItems, ...externalItems];
}
