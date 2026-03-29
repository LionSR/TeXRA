/**
 * Tool dashboard data builder.
 *
 * Enriches tool groups with runtime availability and per-tool descriptions
 * from the registry. External tool definitions (SSOT) live in
 * {@link @tools/externalToolDefs}.
 */

// Local imports
import type {
  ToolDashboardItem,
  ToolInfo,
} from '@shared/schemas/settingsViewMessages';
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';
import {
  getDefaultToolRegistry,
  type RegisteredToolName,
} from '@tools/registry';
import { runExternalToolChecks } from '@tools/toolAvailability';
import { getDisabledToolIds } from '@utils/config/constants';

// ============================================================
// Tool description enrichment
// ============================================================

/**
 * Look up per-tool descriptions from the registry.
 * Falls back to name-only when a tool isn't registered.
 */
function enrichTools(toolNames: readonly string[]): ToolInfo[] {
  const registry = getDefaultToolRegistry();
  return toolNames.map((name) => {
    const tool = registry.get(name);
    return {
      name,
      description: tool?.definition.description,
    };
  });
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
      'Read, write, edit files and run shell commands. Includes glob/grep search and directory listing.',
    toolNames: [
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
    toolNames: ['crossref_doi', 'crossref_search'],
    requiresSetup: false,
  },
  {
    id: 'web',
    name: 'Web Search & Fetch',
    category: 'web',
    description:
      'Search the web and fetch/extract content from URLs. Uses native provider tools when available, with DuckDuckGo Instant Answers as fallback.',
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
 * Build the complete tool dashboard items list with runtime availability checks.
 *
 * Always runs fresh external checks (and updates the availability cache
 * in {@link @tools/toolAvailability} as a side effect).
 */
export async function buildToolDashboardItems(): Promise<ToolDashboardItem[]> {
  // Built-in tools are always available
  const builtinItems: ToolDashboardItem[] = BUILTIN_TOOLS.map(
    ({ toolNames, ...rest }) => ({
      ...rest,
      tools: enrichTools(toolNames),
      status: 'available' as const,
    }),
  );

  // Run fresh checks — also updates the availability cache
  const results = await runExternalToolChecks();

  // Resolve optional detail checks in parallel
  const detailResults = await Promise.all(
    results.map(async ({ id }) => {
      const def = EXTERNAL_TOOL_DEFS.find((c) => c.id === id);
      if (!def?.detailCheck) return undefined;
      try {
        return await def.detailCheck();
      } catch {
        return undefined;
      }
    }),
  );

  // Merge check results with UI metadata from EXTERNAL_TOOL_DEFS
  const disabledIds = getDisabledToolIds();
  const externalItems: ToolDashboardItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const { id, tools, status } = results[i];
    const def = EXTERNAL_TOOL_DEFS.find((c) => c.id === id);
    if (!def || def.hideFromDashboard) continue;
    externalItems.push({
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      tools: enrichTools(tools),
      status,
      requiresSetup: true,
      installGuide: def.installGuide,
      installUrl: def.installUrl,
      installExtensionId: def.installExtensionId,
      configNotes: def.configNotes,
      statusDetail: detailResults[i],
      authNote: def.authNote,
      toggleable: def.toggleable,
      enabled: !disabledIds.has(def.id),
    });
  }

  return [...builtinItems, ...externalItems];
}
