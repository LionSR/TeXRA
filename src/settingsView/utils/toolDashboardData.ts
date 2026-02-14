/**
 * Tool dashboard data builder.
 *
 * Defines static metadata for all tool groups and performs runtime
 * availability checks for tools that depend on external binaries,
 * applications, or VS Code extensions.
 */

// Third-party imports
import * as vscode from 'vscode';
import axios from 'axios';

// Local imports
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import { getZoteroPort } from '@tools/zotero/bbtClient';
import { checkToolInstalled } from '@utils/system/toolUtils';

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

/** Tool groups that require external dependencies. */
const EXTERNAL_TOOLS: (Omit<ToolDashboardItem, 'status'> & {
  check: () => Promise<boolean>;
})[] = [
  {
    id: 'texcount',
    name: 'TeXcount',
    category: 'latex',
    description:
      'Count words, headers, figures, and other elements in LaTeX documents.',
    tools: ['texcount'],
    requiresSetup: true,
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
    name: 'Wolfram Language',
    category: 'computation',
    description:
      'Execute Wolfram Language code for symbolic math, computation, and data analysis.',
    tools: ['wolfram'],
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
    check: () => checkToolInstalled('wolframscript', false),
  },
  {
    id: 'zotero',
    name: 'Zotero Integration',
    category: 'academic',
    description:
      'Search, add items to, and export citations from your Zotero library. Requires Better BibTeX plugin.',
    tools: ['zotero_search', 'zotero_add', 'zotero_export'],
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
    check: async () => {
      try {
        const port = getZoteroPort();
        await axios.get(`http://localhost:${port}/better-bibtex/json-rpc`, {
          timeout: 2000,
        });
        return true;
      } catch {
        // 405 Method Not Allowed means the server is running but expects POST
        // Any response from the server means Zotero + BBT is available
        return false;
      }
    },
  },
  {
    id: 'lean4',
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    description:
      'Interact with Lean 4 projects: check diagnostics, inspect terms, search Loogle, and manage files.',
    tools: [
      'lean_diagnostics',
      'lean_file',
      'lean_project',
      'lean_inspect',
      'lean_loogle',
    ],
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
    check: async () => {
      const lean4Ext = vscode.extensions.getExtension('leanprover.lean4');
      return lean4Ext !== undefined;
    },
  },
];

// ============================================================
// Public API
// ============================================================

/**
 * Build the complete tool dashboard items list with runtime availability checks.
 */
export async function buildToolDashboardItems(): Promise<ToolDashboardItem[]> {
  // Built-in tools are always available
  const builtinItems: ToolDashboardItem[] = BUILTIN_TOOLS.map((tool) => ({
    ...tool,
    status: 'available' as const,
  }));

  // Check external tools in parallel
  const externalChecks = await Promise.all(
    EXTERNAL_TOOLS.map(async ({ check, ...tool }) => {
      try {
        const available = await check();
        return {
          ...tool,
          status: available ? ('available' as const) : ('not-found' as const),
        };
      } catch {
        return { ...tool, status: 'unknown' as const };
      }
    }),
  );

  return [...builtinItems, ...externalChecks];
}
