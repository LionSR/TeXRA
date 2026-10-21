/**
 * TeXRA's plugin list: the harness's built-ins with TeXRA's options, beside
 * the app's own plugins, in the order the Tools dashboard lists them. Each
 * TeXRA entry passes it to `processLayer`; nothing in the harness
 * names an app plugin.
 */

// Third-party imports
import { Effect, Layer } from 'effect';
import {
  HostCapabilities,
  codemode,
  fileOps,
  goal,
  memoryWorkflow,
  multiAgent,
  web,
  definePlugin,
  type ProcessPluginLayer,
} from '@texra-ai/harness/plugins';

// Local imports
import { ALWAYS_AVAILABLE } from '@texra-ai/harness/plugins';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import { AskUserQuestionTool } from '@texra/tools/userQuestion/UserQuestionTool';
import type { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import {
  claudeAgent,
  codex,
  externalInquiry,
  githubActivity,
  lean4,
  wolfram,
  zotero,
} from '@texra/tools/integrationPlugins';
import { DOCUMENT_TASK_BLOCK } from '@texra/shared/plugins/documents';
import { APP_PLUGIN_ARMS } from '@texra/shared/plugins/appArms';
import { isTexFile } from '@texra/shared/latexFileTypes';

// Local file imports
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';
import {
  InlineComments,
  InlineCommentTool,
  type InlineCommentProvider,
} from './comment/InlineCommentTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { EditorHost, makeEditorHost, type EditorRegistry } from './editorHost';
import {
  DocumentCompileTool,
  DocumentContextTool,
  DocumentDiffTool,
  DocumentExtractTool,
  DocumentProposeTool,
} from './documents/documentTools';
import { DocumentReviewTool } from './documents/DocumentReviewTool';
import { DocumentTaskTool } from './documents/DocumentTaskTool';
import { DOCUMENT_TASK_RESULT } from './documents/documentResult';
import { ExtractBibliographyTool } from './latex/ExtractBibliographyTool';
import { ExtractLatexFiguresTool } from './latex/ExtractFiguresTool';
import { ExtractTikzFiguresTool } from './latex/ExtractTikzFiguresTool';
import { LeanLoogleTool } from './lean/LoogleTool';
import { OpenPdfTool } from './OpenPdfTool';
/**
 * Setup-assistant tools: a narrow set for the onboarding agent, one per
 * concern. Every read-only fact about the environment is one report, so the
 * agent never sequences overlapping reads:
 *   - probe_environment — the read-only environment and credential report
 *     (or, given a `tool`, a recheck of that one tool after an install)
 *   - unset_api_key — remove a persisted provider credential
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
 * Credentials come from the `Secrets` service, which the host's composition
 * root provides through `processLayer`, and the host-varying
 * capabilities from the `SetupPlatform` service, the setup plugin's process
 * layer over what the host passes `texraPlugins`.
 */
import { ProbeEnvironmentTool } from './setup/ProbeEnvironmentTool';
import { UnsetApiKeyTool } from './setup/UnsetApiKeyTool';
import { InvokeCommandTool } from './setup/InvokeCommandTool';
import { InstallVscodeExtensionTool } from './setup/InstallVscodeExtensionTool';
import { ReadConfigTool, UpdateConfigTool } from './setup/ConfigTools';
import { SendToTerminalTool } from './setup/SendToTerminalTool';
import { ApplyTeamTool } from './setup/ApplyTeamTool';
import { SetupPlatform, type SetupPlatformShape } from './setup/platform';
import type { WriteFilter } from '@texra-ai/harness/plugins';
import type { Plugin } from '@texra-ai/harness';

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

/** The editor's diagnostics, offered while an editor attached for the
 *  session reads them: the plugin serves `HostCapabilities` from the same
 *  registry its tool reads. */
const latexDiagnostics = (editors: EditorRegistry) =>
  definePlugin<EditorHost>({
    id: 'latex-diagnostics',
    tools: { diagnostics: DiagnosticsTool },
    processLayer: {
      layer: Layer.mergeAll(
        Layer.succeed(EditorHost)(editors),
        Layer.succeed(HostCapabilities)(editors),
      ),
    },
  });

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
const core = (editors: EditorRegistry, provider?: InlineCommentProvider) =>
  definePlugin<EditorHost>({
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
    // The editor's PDF viewer; the host's Comments UI, for the one host
    // that has one (elsewhere the tool fails naming the missing wiring).
    processLayer: {
      layer:
        provider === undefined
          ? Layer.succeed(EditorHost)(editors)
          : Layer.mergeAll(
              Layer.succeed(EditorHost)(editors),
              Layer.succeed(InlineComments)(provider),
            ),
    },
  });

/** The onboarding agent's narrow set, one concern per tool, over the host's
 *  setup capabilities. */
const setup = (platform: SetupPlatformShape) =>
  definePlugin<SetupPlatform>({
    id: 'setup',
    processLayer: { layer: SetupPlatform.layer(platform) },
    tools: {
      probe_environment: ProbeEnvironmentTool,
      unset_api_key: UnsetApiKeyTool,
      invoke_command: InvokeCommandTool,
      install_vscode_extension: InstallVscodeExtensionTool,
      read_config: ReadConfigTool,
      update_config: UpdateConfigTool,
      send_to_terminal: SendToTerminalTool,
      apply_team: ApplyTeamTool,
    },
  });

/** Document tasks: the `task:` block of an agent file, the tools their
 *  recipe calls, launching one as a child (`document_task`), and accepting
 *  the documents a run produced into the workspace. */
const documents: Plugin = {
  id: 'documents',
  // The `task:` block, and how its runs read (`DOCUMENT_TASK_RESULT`).
  agentBlock: Object.freeze({
    ...DOCUMENT_TASK_BLOCK,
    result: DOCUMENT_TASK_RESULT,
  }),
  // The delegation targets mark a task's agent `(task)`.
  prompt: ({ offered }) =>
    offered.includes('document_task')
      ? 'An agent marked (task) in the available agents also runs a document task over files with `document_task`.'
      : '',
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
  arms: APP_PLUGIN_ARMS.documents,
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
    /** The host's setup capabilities (VS Code's commands, extensions and
     *  terminal); none elsewhere. */
    readonly setup?: SetupPlatformShape;
    /** The composition's editor registry its hosts attach to
     *  (`makeEditorHost`); none attached when absent. */
    readonly editors?: EditorRegistry;
  } = {},
): readonly Plugin[] => {
  const editors = host.editors ?? makeEditorHost();
  return [
    fileOps({ writeFilter: texWriteFilter }),
    latexExtract,
    latexDiagnostics(editors),
    arxiv,
    web,
    memoryWorkflow,
    goal,
    wolfram,
    zotero,
    lean4({ setup: host.setup ?? {}, services: host.lean }),
    multiAgent,
    githubActivity,
    externalInquiry,
    codex,
    claudeAgent,
    core(editors, host.inlineComments),
    codemode,
    setup(host.setup ?? {}),
    {
      id: 'copilot',
      toggle: 'on',
      availability: ALWAYS_AVAILABLE,
      ...(host.copilot !== undefined && { processLayer: host.copilot }),
    },
    documents,
  ];
};
