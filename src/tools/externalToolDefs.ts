/**
 * External tool definitions — single source of truth.
 *
 * Each entry co-locates:
 *   - identity: id, tool names (typed via RegisteredToolName)
 *   - check function: how to detect availability at runtime
 *   - dashboard metadata: name, category, description, install guide
 *
 * Consumed by:
 *   - {@link @tools/toolAvailability} — reads id/tools/check for caching
 *   - {@link @settingsView/utils/toolDashboardData} — reads everything for the UI
 */

// Third-party imports
import axios from 'axios';

// Local imports
import type { ToolCategory } from '@shared/schemas/settingsViewMessages';
import type { RegisteredToolName } from '@tools/registry';
import { getZoteroPort } from '@tools/zotero/bbtClient';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { importCodexClass, findCodexBinaryPath } from '@tools/codexImport';

const LEAN4_EXT_ID = 'leanprover.lean4';

/**
 * Pluggable check for VS Code extension availability.
 * Set by the extension host at activation; defaults to false (not available).
 */
let extensionChecker: (extensionId: string) => boolean = () => false;

/** Register a platform-specific extension availability checker. */
export function setExtensionChecker(
  checker: (extensionId: string) => boolean,
): void {
  extensionChecker = checker;
}

// ============================================================
// Type
// ============================================================

/** Full definition for an external tool group. */
export interface ExternalToolDef {
  /** Unique group identifier (matches ToolDashboardItem.id). */
  readonly id: string;
  /** Tool names belonging to this group — must match registry keys. */
  readonly tools: readonly RegisteredToolName[];
  /** Returns true if the external dependency is available. */
  readonly check: () => Promise<boolean>;
  /** Optional detailed status string resolved at check time (shown below description). */
  readonly detailCheck?: () => Promise<string | undefined>;
  // Dashboard UI metadata
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly installGuide?: string;
  readonly installUrl?: string;
  /** VS Code extension ID — when present, the dashboard offers a direct "Install" button. */
  readonly installExtensionId?: string;
  readonly configNotes?: string;
  /** When true, the tool is checked for availability but not shown in the Tools tab dashboard. */
  readonly hideFromDashboard?: boolean;
}

// ============================================================
// Zotero probe helpers
// ============================================================

/** Probe the Zotero connector endpoint (responds if Zotero is running). */
async function probeZoteroConnector(port: number): Promise<boolean> {
  try {
    await axios.get(`http://127.0.0.1:${port}/connector/ping`, {
      timeout: 2000,
    });
    return true;
  } catch (error: unknown) {
    // Any HTTP response means Zotero is running
    if (axios.isAxiosError(error) && error.response) return true;
    return false;
  }
}

/** Probe the Better BibTeX JSON-RPC endpoint. */
async function probeZoteroBbt(port: number): Promise<boolean> {
  try {
    await axios.get(`http://127.0.0.1:${port}/better-bibtex/json-rpc`, {
      timeout: 2000,
    });
    return true;
  } catch (error: unknown) {
    // 405 = server running but expects POST — BBT is available
    if (axios.isAxiosError(error) && error.response?.status === 405) {
      return true;
    }
    return false;
  }
}

// ============================================================
// Definitions
// ============================================================

export const EXTERNAL_TOOL_DEFS: readonly ExternalToolDef[] = [
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
    hideFromDashboard: true, // Shown in LaTeX settings tab instead
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
      'Requires the "wolframscript" command-line tool.\n\n' +
      'Install the free Wolfram Engine:\n' +
      '  Mac:     brew install --cask wolfram-engine\n' +
      '  Ubuntu:  Download from wolfram.com/engine\n' +
      '  Windows: Download from wolfram.com/engine\n\n' +
      'Note: A Mathematica installation alone is not enough — you\n' +
      'need WolframScript on your PATH. The Wolfram Engine includes\n' +
      'it automatically. Free licenses are available for development use.',
    installUrl: 'https://www.wolfram.com/engine/',
    configNotes: 'Requires the free Wolfram Engine (provides wolframscript).',
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
    check: async () => probeZoteroBbt(getZoteroPort()),
    detailCheck: async () => {
      const port = getZoteroPort();
      const zoteroOk = await probeZoteroConnector(port);
      const bbtOk = await probeZoteroBbt(port);
      if (zoteroOk && bbtOk) {
        return `Zotero running on port ${port}, Better BibTeX responding.`;
      }
      if (zoteroOk && !bbtOk) {
        return `Zotero detected on port ${port}, but Better BibTeX is not responding. Install the Better BibTeX plugin.`;
      }
      return `Zotero not detected on port ${port}. Make sure Zotero is running.`;
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
    installExtensionId: LEAN4_EXT_ID,
    configNotes: 'Lean 4 VS Code extension must be installed and active.',
    check: async () => extensionChecker(LEAN4_EXT_ID),
  },

  {
    id: 'codex',
    tools: ['codex'],
    name: 'OpenAI Codex CLI',
    category: 'computation',
    description:
      'OpenAI Codex agent runtime. Required by the Codex SDK for local code generation and analysis.',
    installGuide:
      'Install the Codex CLI (choose one):\n\n' +
      '  npm install -g @openai/codex\n' +
      '  brew install codex          (macOS)\n\n' +
      'Authentication (choose one):\n' +
      '  • codex login        — sign in with ChatGPT account (recommended)\n' +
      '  • OPENAI_API_KEY     — environment variable with API key',
    installUrl: 'https://github.com/openai/codex',
    configNotes:
      'Requires @openai/codex npm package with platform binaries. Used by @openai/codex-sdk. ' +
      'Supports OAuth via `codex login` or OPENAI_API_KEY env var.',
    check: async () => findCodexBinaryPath() != null,
    detailCheck: async () => {
      // Step 1: Can we import the SDK?
      try {
        await importCodexClass();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('not found') ||
          msg.includes('MODULE_NOT_FOUND') ||
          msg.includes('Cannot find package')
        ) {
          return '@openai/codex-sdk not found. Install with: npm install -g @openai/codex';
        }
        if (msg.includes('Unsupported platform')) {
          return `Platform not supported: ${msg}`;
        }
        return `Codex SDK import failed: ${msg}`;
      }

      // Step 2: Can we find the native binary?
      const codexPath = findCodexBinaryPath();
      if (!codexPath) {
        return 'Codex SDK loaded but native binary not found. Install with: npm install -g @openai/codex';
      }

      return `Codex CLI ready. Binary: ${codexPath}`;
    },
  },

  // System dependencies (latexindent, image processing) have moved to the
  // LaTeX settings tab — see LaTeXTab.ts and SettingsViewMessageHandler.ts.
];
