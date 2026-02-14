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
import * as vscode from 'vscode';
import axios from 'axios';

// Local imports
import type { ToolCategory } from '@shared/schemas/settingsViewMessages';
import type { RegisteredToolName } from '@tools/registry';
import { getZoteroPort } from '@tools/zotero/bbtClient';
import { checkToolInstalled } from '@utils/system/toolUtils';

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
  // Dashboard UI metadata
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly installGuide?: string;
  readonly installUrl?: string;
  readonly configNotes?: string;
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

  // ── System dependencies (no agent tools gated) ───────────────
  {
    id: 'latex-format',
    tools: [],
    name: 'LaTeX Formatting (latexindent)',
    category: 'system',
    description:
      'Format and indent LaTeX documents. Requires latexindent and Perl.',
    installGuide:
      'latexindent is a Perl script for formatting LaTeX files.\n\n' +
      'Installation:\n' +
      '  Mac:     brew install latexindent\n' +
      '  Ubuntu:  sudo apt-get install texlive-extra-utils\n' +
      '  Windows: Install via MiKTeX or TeX Live package manager\n\n' +
      'Perl is also required:\n' +
      '  Mac:     brew install perl\n' +
      '  Ubuntu:  sudo apt-get install perl\n' +
      '  Windows: Download from strawberryperl.com',
    installUrl: 'https://github.com/cmhughes/latexindent.pl',
    configNotes: 'Part of most TeX Live distributions. Requires Perl runtime.',
    check: async () => {
      const [hasLatexindent, hasPerl] = await Promise.all([
        checkToolInstalled('latexindent', false),
        checkToolInstalled('perl', false),
      ]);
      return hasLatexindent && hasPerl;
    },
  },
  {
    id: 'image-processing',
    tools: [],
    name: 'Image Processing (Ghostscript + GM/IM)',
    category: 'system',
    description:
      'Convert PDF pages to PNG images for preview. Requires Ghostscript and either GraphicsMagick or ImageMagick.',
    installGuide:
      'Ghostscript converts PDF to raster images; GraphicsMagick or\n' +
      'ImageMagick handles the final PNG output.\n\n' +
      'Ghostscript:\n' +
      '  Mac:     brew install ghostscript\n' +
      '  Ubuntu:  sudo apt-get install ghostscript\n' +
      '  Windows: Download from ghostscript.com\n\n' +
      'GraphicsMagick (recommended):\n' +
      '  Mac:     brew install graphicsmagick\n' +
      '  Ubuntu:  sudo apt-get install graphicsmagick\n' +
      '  Windows: Download from graphicsmagick.org\n\n' +
      'OR ImageMagick:\n' +
      '  Mac:     brew install imagemagick\n' +
      '  Ubuntu:  sudo apt-get install imagemagick\n' +
      '  Windows: Download from imagemagick.org',
    installUrl: 'https://ghostscript.com/releases/gsdnld.html',
    configNotes: 'Needs Ghostscript plus either GraphicsMagick or ImageMagick.',
    check: async () => {
      const [hasGs, hasGm, hasMagick] = await Promise.all([
        checkToolInstalled('gs', false),
        checkToolInstalled('gm', false),
        checkToolInstalled('magick', false),
      ]);
      return hasGs && (hasGm || hasMagick);
    },
  },
];
