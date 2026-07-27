/**
 * Domain-tool registry — separated from {@link @tools/registry} to break the
 * import cycle that drags ~480 domain files (LaTeX, Lean, arxiv, Zotero) into
 * every generic tool's transitive closure.
 *
 * Tools here are registered lazily via {@link ensureDomainToolsRegistered} in
 * registry.ts. The module body is NOT imported eagerly by registry.ts.
 *
 * See #9327 for the cycle description and closure measurements.
 */

// Local imports
import type { ITool } from '@agent/core/tools/ToolTypes';

// Lazy domain-tool imports — each tool module lives here instead of registry.ts.
// These imports are evaluated only when this module is dynamically imported.

// Local file imports — arxiv
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivMetadataTool } from './arxiv/ArxivMetadataTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';

// Local file imports — latex
import {
  ExtractBibliographyTool,
  ExtractLatexFiguresTool,
  ExtractTikzFiguresTool,
} from './latex';

// Local file imports — zotero
import { ZoteroAddTool } from './zotero/ZoteroAddTool';
import { ZoteroCollectionsTool } from './zotero/ZoteroCollectionsTool';
import { ZoteroExportTool } from './zotero/ZoteroExportTool';
import { ZoteroSearchTool } from './zotero/ZoteroSearchTool';

// Local file imports — wolfram
import { WolframTool } from './wolfram/WolframTool';

// Local file imports — texcount
import { TexcountTool } from './texcount/TexcountTool';

// Local file imports — citation
import { CrossrefSearchTool } from './citation/CrossrefSearchTool';

// Local file imports — lean
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanProjectTool,
  LeanInspectTool,
  LeanLoogleTool,
} from './lean';

// Local file imports — github
import { GitHubSubscriptionTool } from './github';

// Local file imports — other domain tools with heavy transitive deps
import { PlanTool } from './plan/PlanTool';
import { OpenPdfTool } from './OpenPdfTool';
import { AcceptRunFilesTool } from './AcceptRunFilesTool';

/**
 * Canonical domain-tool factory.
 *
 * Returns tool instances whose constructors live outside the core registry's
 * module graph. Callers that need domain tools must call
 * {@link ensureDomainToolsRegistered} (or import this module dynamically)
 * before resolving tool definitions.
 */
export function createDomainTools() {
  return {
    download_arxiv_source: new ArxivDownloadTool(),
    arxiv_metadata: new ArxivMetadataTool(),
    arxiv_search: new ArxivSearchTool(),
    extract_figures: new ExtractLatexFiguresTool(),
    extract_bib_entries: new ExtractBibliographyTool(),
    extract_tikz_figures: new ExtractTikzFiguresTool(),
    crossref_search: new CrossrefSearchTool(),
    zotero_add: new ZoteroAddTool(),
    zotero_collections: new ZoteroCollectionsTool(),
    zotero_search: new ZoteroSearchTool(),
    zotero_export: new ZoteroExportTool(),
    wolfram: new WolframTool(),
    texcount: new TexcountTool(),
    lean_diagnostics: new LeanDiagnosticsTool(),
    lean_file: new LeanFileTool(),
    lean_project: new LeanProjectTool(),
    lean_inspect: new LeanInspectTool(),
    lean_loogle: new LeanLoogleTool(),
    github_subscription: new GitHubSubscriptionTool(),
    plan: new PlanTool(),
    open_pdf: new OpenPdfTool(),
    accept_run_files: new AcceptRunFilesTool(),
  } satisfies Record<string, ITool>;
}

/** Domain tool names — consumed by {@link @tools/registry}'s `RegisteredToolName`. */
export type DomainToolName = keyof ReturnType<typeof createDomainTools>;
