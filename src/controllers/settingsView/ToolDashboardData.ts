/**
 * Tool dashboard data builder.
 *
 * Enriches settings-view tool groups with runtime availability. External tool
 * definitions live in {@link @tools/externalToolDefs}; this controller module
 * keeps that tool-layer dependency out of shared settings-view code.
 */

// Local imports
import type { ToolCommandKind, ToolDashboardItem } from '@shared/schemas';
import { findExternalToolDef } from '@tools/externalToolDefs';
import type { RegisteredToolName } from '@tools/registry';
import {
  runExternalToolChecks,
  type ExternalToolCheckResult,
} from '@tools/toolAvailability';
import { getDisabledToolIds } from '@utils/config/constants';

// ============================================================
// Tool terminal actions
// ============================================================

export type ToolTerminalAction =
  | {
      readonly kind: 'terminal';
      readonly name: string;
      readonly command: string;
    }
  | {
      readonly kind: 'none';
      readonly reason: 'unknownTool' | 'missingCommand';
    };

/**
 * Plan the terminal command for a tool-dashboard install/auth action.
 *
 * Hosts re-look up the command from the shared tool definitions rather than
 * trusting a command string supplied by the webview, and report which of the
 * two failure reasons applies instead of silently doing nothing.
 */
export function planToolTerminalAction(input: {
  readonly toolId: string;
  readonly commandKind: ToolCommandKind;
}): ToolTerminalAction {
  const def = findExternalToolDef(input.toolId);
  if (!def) return { kind: 'none', reason: 'unknownTool' };

  const command =
    input.commandKind === 'install' ? def.installCommand : def.authCommand;
  if (!command) return { kind: 'none', reason: 'missingCommand' };

  return { kind: 'terminal', name: `TeXRA: ${def.name}`, command };
}

// ============================================================
// Static tool metadata
// ============================================================

/** Tool groups that are always available (built-in, no external deps). */
const BUILTIN_TOOLS: (Omit<ToolDashboardItem, 'status' | 'tools'> & {
  toolNames: readonly RegisteredToolName[];
})[] = [
  {
    id: 'file-ops',
    name: 'File & Shell Operations',
    category: 'file',
    description:
      'Read, write, edit files and run shell commands. Includes glob/grep search.',
    toolNames: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    requiresSetup: false,
  },
  {
    id: 'latex-extract',
    name: 'LaTeX Extraction',
    category: 'latex',
    description:
      'Extract figures, TikZ diagrams, and bibliography entries from LaTeX documents.',
    toolNames: [
      'extract_figures',
      'extract_tikz_figures',
      'extract_bib_entries',
    ],
    requiresSetup: false,
  },
  {
    id: 'latex-diagnostics',
    name: 'LaTeX Diagnostics',
    category: 'latex',
    description:
      'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
    toolNames: ['diagnostics'],
    requiresSetup: false,
  },
  {
    id: 'arxiv',
    name: 'ArXiv Search & Download',
    category: 'academic',
    description:
      'Search arXiv papers, retrieve metadata, and download LaTeX source packages.',
    toolNames: ['arxiv_search', 'arxiv_metadata', 'download_arxiv_source'],
    requiresSetup: false,
  },
  {
    id: 'crossref',
    name: 'Crossref Citation Lookup',
    category: 'academic',
    description:
      'Search Crossref for academic publications by query or resolve DOIs to full metadata.',
    toolNames: ['crossref_search'],
    requiresSetup: false,
  },
  {
    id: 'web',
    name: 'Web Search & Fetch',
    category: 'web',
    description:
      'Search the web and fetch or extract content from URLs. Uses native provider tools when available, and DuckDuckGo Instant Answers otherwise.',
    toolNames: ['web_search', 'web_fetch'],
    requiresSetup: false,
  },
  {
    id: 'memory-workflow',
    name: 'Memory, Tasks & Delegation',
    category: 'workflow',
    description:
      'Persistent memory across sessions, task tracking with to-do lists, and delegate work to sub-agents.',
    toolNames: [
      'memory',
      'todo_write',
      'plan',
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
    requiresSetup: false,
  },
];

// ============================================================
// Public API
// ============================================================

/**
 * Build the complete tool dashboard items list.
 *
 * @param cachedResults - when provided, skips network probes and uses
 *   these results (including their `statusDetail`). Used by the toggle
 *   handler for instant UI updates.
 */
export async function buildToolDashboardItems(
  cachedResults?: ExternalToolCheckResult[],
): Promise<ToolDashboardItem[]> {
  const builtinItems: ToolDashboardItem[] = BUILTIN_TOOLS.map(
    ({ toolNames, ...rest }) => ({
      ...rest,
      tools: toolNames.map((name) => ({ name })),
      status: 'available' as const,
    }),
  );

  const results = cachedResults ?? (await runExternalToolChecks());

  const disabledIds = getDisabledToolIds();
  const externalItems: ToolDashboardItem[] = [];
  for (const { id, tools, status, statusLabel, statusDetail } of results) {
    const def = findExternalToolDef(id);
    if (!def || def.hideFromDashboard) continue;
    externalItems.push({
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      tools: tools.map((name) => ({ name })),
      status,
      statusLabel,
      requiresSetup: true,
      installGuide: def.installGuide,
      installUrl: def.installUrl,
      installExtensionId: def.installExtensionId,
      installCommand: def.installCommand,
      authCommand: def.authCommand,
      configNotes: def.configNotes,
      statusDetail,
      authNote: def.authNote,
      toggleable: def.toggleable,
      enabled: !disabledIds.has(def.id),
    });
  }

  return [...builtinItems, ...externalItems];
}
