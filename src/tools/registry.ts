/**
 * TeXRA's plugin list: the harness's built-ins with TeXRA's options, beside
 * the app's own plugins, in the order the Tools dashboard lists them. Each
 * TeXRA entry passes it to `installProcessRuntime`; nothing in the harness
 * names an app plugin.
 */

// Third-party imports
import { Effect, Layer } from 'effect';
import { z } from 'zod';

// Local imports
import { documentRoundMode } from '@agent/output/documentRoundPolicy';
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import { extractionShorthandToolConfig } from '@shared/schemas';
import {
  codemode,
  fileOps,
  goal,
  memoryWorkflow,
  multiAgent,
  web,
} from '@tools/builtinPlugins';
import type { WorkflowAgentOptions } from '@tools/delegation/AgentTool';
import type { WriteFilter } from '@tools/WriteTool';
import {
  claudeAgent,
  codex,
  externalInquiry,
  githubActivity,
  lean4,
  texcount,
  wolfram,
  zotero,
} from '@tools/integrationPlugins';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { definePlugin, type Plugin } from '@tools/plugins';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import type { ProcessPluginLayer } from '@tools/toolTable';

// Local file imports
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivMetadataTool } from './arxiv/ArxivMetadataTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';
import { CrossrefSearchTool } from './citation/CrossrefSearchTool';
import {
  InlineComments,
  InlineCommentTool,
  type InlineCommentProvider,
} from './comment/InlineCommentTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { ExtractBibliographyTool } from './latex/ExtractBibliographyTool';
import { ExtractLatexFiguresTool } from './latex/ExtractFiguresTool';
import { ExtractTikzFiguresTool } from './latex/ExtractTikzFiguresTool';
import { LeanLoogleTool } from './lean/LoogleTool';
import { OpenPdfTool } from './OpenPdfTool';
import { AskUserQuestionTool } from './userQuestion/UserQuestionTool';
/**
 * Setup-assistant tools: a narrow UNIX-style set for the onboarding agent.
 *
 * Each tool has one responsibility:
 *   - probe_environment — read-only environment snapshot
 *   - verify_setup — re-check dependencies
 *   - unset_api_key — remove a persisted provider credential
 *   - list_api_keys — enumerate stored secret key names for auditing
 *   - invoke_command — bridge to allowlisted VS Code commands
 *   - install_vscode_extension — install LaTeX Workshop / Lean 4
 *   - read_config / update_config — read a TeXRA setting, or write an
 *     allowlisted one
 *   - send_to_terminal — type into VS Code's integrated terminal for
 *     sudo / interactive prompts the captured-stdio bash tool can't handle
 *   - apply_team — apply a discipline team + record the default team
 *
 * Shell-rc writes go through the regular `bash` tool (and its approval
 * dialog) — there's no dedicated rc-writing tool. A hand-rolled validator
 * on top of shell would be a second, weaker approval surface that every
 * reviewer keeps finding bypasses for.
 *
 * Credentials come from the `Secrets` service and the host-varying
 * capabilities from the `SetupPlatform` service, both provided by the host's
 * composition root through `installProcessRuntime`.
 */
import { ProbeEnvironmentTool } from './setup/ProbeEnvironmentTool';
import { VerifySetupTool } from './setup/VerifySetupTool';
import { UnsetApiKeyTool } from './setup/UnsetApiKeyTool';
import { ListApiKeysTool } from './setup/ListApiKeysTool';
import { InvokeCommandTool } from './setup/InvokeCommandTool';
import { InstallVscodeExtensionTool } from './setup/InstallVscodeExtensionTool';
import { ReadConfigTool, UpdateConfigTool } from './setup/ConfigTools';
import { SendToTerminalTool } from './setup/SendToTerminalTool';
import { ApplyTeamTool } from './setup/ApplyTeamTool';

/** TeXRA's filter on `write_file`: a `.tex` file's content goes through the
 *  replacement rules of the call's workspace. */
const texWriteFilter: WriteFilter = (path, content, config) => {
  if (!isTexFile(path)) return Effect.succeed(content);
  const replaced = replacementEngine.applyFor(content, 'tex-write', (key) =>
    config.get(key),
  );
  return logReplacementDiagnostics(replaced.diagnostics).pipe(
    Effect.as(replaced.text),
  );
};

/**
 * TeXRA's workflow options on `agent`: the figure-extraction pair, which
 * reaches a workflow child as its tool configuration
 * (`autoExtractFigure` / `autoExtractTikzFigure`).
 */
const FIGURE_OPTIONS: WorkflowAgentOptions = {
  fields: {
    extractFigures: z
      .boolean()
      .nullish()
      .describe(
        'Workflow agents: attach the figures the input LaTeX includes as media.',
      ),
    extractTikz: z
      .boolean()
      .nullish()
      .describe(
        'Workflow agents: compile the input LaTeX TikZ figures and attach them.',
      ),
  },
  toolConfig: extractionShorthandToolConfig,
};

const latexExtract: Plugin = {
  id: 'latex-extract',
  tools: {
    extract_figures: ExtractLatexFiguresTool,
    extract_tikz_figures: ExtractTikzFiguresTool,
    extract_bib_entries: ExtractBibliographyTool,
  },
  name: 'LaTeX Extraction',
  category: 'latex',
  description:
    'Extract figures, TikZ diagrams, and bibliography entries from LaTeX documents.',
};

const latexDiagnostics: Plugin = {
  id: 'latex-diagnostics',
  tools: { diagnostics: DiagnosticsTool },
  name: 'LaTeX Diagnostics',
  category: 'latex',
  description:
    'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
};

const arxiv: Plugin = {
  id: 'arxiv',
  tools: {
    arxiv_search: ArxivSearchTool,
    arxiv_metadata: ArxivMetadataTool,
    download_arxiv_source: ArxivDownloadTool,
  },
  name: 'ArXiv Search & Download',
  category: 'academic',
  description:
    'Search arXiv papers, retrieve metadata, and download LaTeX source packages.',
};

const crossref: Plugin = {
  id: 'crossref',
  tools: { crossref_search: CrossrefSearchTool },
  name: 'Crossref Citation Lookup',
  category: 'academic',
  description:
    'Search Crossref for academic publications by query or resolve DOIs to full metadata.',
};

/**
 * Tools every host offers without setup that no dashboard card lists:
 * review annotations, the PDF viewer, the user-question dialog, and Loogle
 * search (network only, so not gated on the Lean 4 plugin's probe). Its
 * prompt section is the configured default bibliography, at every step of
 * every run.
 */
const core = (provider?: InlineCommentProvider) =>
  definePlugin<InlineComments>({
    id: 'core',
    name: 'Core Tools',
    category: 'workflow',
    description:
      'Review annotations, PDF viewing, user questions, and Loogle search.',
    tools: {
      inline_comment: InlineCommentTool,
      open_pdf: OpenPdfTool,
      ask_user_question: AskUserQuestionTool,
      lean_loogle: LeanLoogleTool,
    },
    hidden: true,
    prompt: ({ config }) => {
      const bibPath = config.get<string>('texra.bib.defaultPath');
      return bibPath
        ? `The default bibliography file is ${bibPath}. You can grep or read this file to search for citations and references.`
        : '';
    },
    // The host's Comments UI, for the one host that has one; elsewhere the
    // tool fails naming the missing host wiring.
    ...(provider !== undefined && {
      processLayer: { layer: Layer.succeed(InlineComments)(provider) },
    }),
  });

/** The onboarding agent's narrow set, one responsibility per tool. */
const setup: Plugin = {
  id: 'setup',
  name: 'Setup Assistant',
  category: 'system',
  description:
    'Probe and verify the environment, manage API keys and settings, and apply a team.',
  tools: {
    probe_environment: ProbeEnvironmentTool,
    verify_setup: VerifySetupTool,
    unset_api_key: UnsetApiKeyTool,
    list_api_keys: ListApiKeysTool,
    invoke_command: InvokeCommandTool,
    install_vscode_extension: InstallVscodeExtensionTool,
    read_config: ReadConfigTool,
    update_config: UpdateConfigTool,
    send_to_terminal: SendToTerminalTool,
    apply_team: ApplyTeamTool,
  },
  hidden: true,
};

/** Workflow agents: their rounds, and accepting the documents a run
 *  produced into the workspace. */
const documents: Plugin = {
  id: 'documents',
  name: 'Documents',
  category: 'workflow',
  description:
    'Run workflow agents: rounds that rewrite documents, with diffs and compile checks, and accept their outputs into the workspace.',
  tools: { accept_run_files: AcceptRunFilesTool },
  hidden: true,
  rounds: documentRoundMode,
};

/**
 * TeXRA's plugins, in dashboard order. `copilot` contributes no tool of its
 * own: its process layer, which the VS Code host passes here, exposes the
 * research tools of the other plugins on in the live catalog to Copilot while
 * it is on (`copilotToolsLayer` in packages/extension).
 */
export const texraPlugins = (
  host: {
    readonly copilot?: ProcessPluginLayer;
    /** The host's Lean services in place of the direct `lake` pool (VS
     *  Code's Lean 4 extension bridge). */
    readonly lean?: ProcessPluginLayer<LeanLanguageServices>['layer'];
    /** The host's Comments UI behind `inline_comment`. */
    readonly inlineComments?: InlineCommentProvider;
  } = {},
): readonly Plugin[] => [
  fileOps({ writeFilter: texWriteFilter }),
  latexExtract,
  latexDiagnostics,
  arxiv,
  crossref,
  web,
  memoryWorkflow,
  goal,
  texcount,
  wolfram,
  zotero,
  host.lean === undefined
    ? lean4
    : { ...lean4, processLayer: { layer: host.lean } },
  multiAgent(FIGURE_OPTIONS),
  githubActivity,
  externalInquiry,
  codex,
  claudeAgent,
  core(host.inlineComments),
  codemode,
  setup,
  {
    id: 'copilot',
    name: 'Copilot Chat Tools',
    category: 'ai-agents',
    description:
      'Expose arXiv search, web fetch, and Crossref search to GitHub Copilot Chat and agent mode as #texra_arxiv_search, #texra_web_fetch, and #texra_crossref_search. Each is exposed while its own plugin is on.',
    setup: Object.freeze({
      configNotes:
        'VS Code only. Turning this off removes every TeXRA tool from Copilot.',
    }),
    unavailableHosts: ['cli', 'desktop', 'sdk'],
    toggleable: true,
    onByDefault: true,
    availability: ALWAYS_AVAILABLE,
    ...(host.copilot !== undefined && { processLayer: host.copilot }),
  },
  documents,
];
