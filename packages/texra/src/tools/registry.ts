/**
 * TeXRA's plugin list: the harness's built-ins with TeXRA's options, beside
 * the app's own plugins, in the order the Tools dashboard lists them. Each
 * TeXRA entry passes it to `installProcessRuntime`; nothing in the harness
 * names an app plugin.
 */

// Third-party imports
import { Effect, Layer } from 'effect';

// Local imports
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import {
  claudeAgent,
  codex,
  externalInquiry,
  githubActivity,
  lean4,
  wolfram,
  zotero,
} from '@texra/tools/integrationPlugins';
import type { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import {
  codemode,
  fileOps,
  goal,
  memoryWorkflow,
  multiAgent,
  web,
} from '@tools/builtinPlugins';
import type { WriteFilter } from '@tools/WriteTool';
import { definePlugin, type Plugin } from '@tools/plugins';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import type { ProcessPluginLayer } from '@tools/toolTable';

// Local file imports
import { AskUserQuestionTool } from '@tools/userQuestion/UserQuestionTool';
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';
import {
  InlineComments,
  InlineCommentTool,
  type InlineCommentProvider,
} from './comment/InlineCommentTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import {
  DocumentCompileTool,
  DocumentContextTool,
  DocumentDiffTool,
  DocumentExtractTool,
  DocumentProposeTool,
} from './documents/documentTools';
import { DocumentReviewTool } from './documents/DocumentReviewTool';
import { DocumentTaskTool } from './documents/DocumentTaskTool';
import { ExtractBibliographyTool } from './latex/ExtractBibliographyTool';
import { ExtractLatexFiguresTool } from './latex/ExtractFiguresTool';
import { ExtractTikzFiguresTool } from './latex/ExtractTikzFiguresTool';
import { LeanLoogleTool } from './lean/LoogleTool';
import { OpenPdfTool } from './OpenPdfTool';
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

const latexExtract: Plugin = {
  id: 'latex-extract',
  tools: {
    extract_figures: ExtractLatexFiguresTool,
    extract_tikz_figures: ExtractTikzFiguresTool,
    extract_bib_entries: ExtractBibliographyTool,
  },
};

const latexDiagnostics: Plugin = {
  id: 'latex-diagnostics',
  tools: { diagnostics: DiagnosticsTool },
};

const arxiv: Plugin = {
  id: 'arxiv',
  tools: {
    arxiv_search: ArxivSearchTool,
    download_arxiv_source: ArxivDownloadTool,
  },
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
    tools: {
      inline_comment: InlineCommentTool,
      open_pdf: OpenPdfTool,
      ask_user_question: AskUserQuestionTool,
      lean_loogle: LeanLoogleTool,
    },
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
};

/** Document tasks: the tools their recipe calls, launching one as a child
 *  (`document_task`), and accepting the documents a run produced into the
 *  workspace. */
const documents: Plugin = {
  id: 'documents',
  tools: {
    accept_run_files: AcceptRunFilesTool,
    document_task: DocumentTaskTool,
    document_context: DocumentContextTool,
    document_extract: DocumentExtractTool,
    document_compile: DocumentCompileTool,
    document_diff: DocumentDiffTool,
    document_review: DocumentReviewTool,
    document_propose: DocumentProposeTool,
  },
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
  web,
  memoryWorkflow,
  goal,
  wolfram,
  zotero,
  host.lean === undefined
    ? lean4
    : { ...lean4, processLayer: { layer: host.lean } },
  multiAgent,
  githubActivity,
  externalInquiry,
  codex,
  claudeAgent,
  core(host.inlineComments),
  codemode,
  setup,
  {
    id: 'copilot',
    toggle: 'on',
    availability: ALWAYS_AVAILABLE,
    ...(host.copilot !== undefined && { processLayer: host.copilot }),
  },
  documents,
];
