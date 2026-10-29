/**
 * TeXRA's plugin list: the harness's built-ins with TeXRA's options, beside
 * the app's own plugins, in the order the Tools dashboard lists them. Each
 * TeXRA entry passes it to `processLayer`; nothing in the harness
 * names an app plugin.
 */

// Third-party imports
import { Effect, Layer } from 'effect';
import { Settings } from '@texra-ai/harness/host';
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
  type InlineCommentCapability,
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
import { DOCUMENTS_MODULE } from './documents/documentsModule';
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
import {
  SetupHost,
  SetupPlatform,
  type SetupPlatformShape,
} from './setup/platform';
import type { InquiryPanelCapability } from './inquiry/ExternalInquiryTool';
import type { WriteFilter } from '@texra-ai/harness/plugins';
import type { Plugin } from '@texra-ai/harness';

/** TeXRA's filter on `write_file`: a `.tex` file's content goes through the
 *  replacement rules of the call's workspace. */
const texWriteFilter: WriteFilter = (path, content, config) => {
  if (!isTexFile(path)) return Effect.succeed(content);
  const replaced = replacementEngine.applyFor(content, 'tex-write', config);
  return logReplacementDiagnostics(replaced.diagnostics).pipe(
    Effect.as(replaced.text),
  );
};

/** The host capabilities (`ITool.hostCapability`) a plugin serves, read
 *  each time a step asks. */
const serves = (capabilities: () => readonly string[]) =>
  Layer.succeed(HostCapabilities)({ of: () => new Set(capabilities()) });

const latexExtract: Plugin = {
  id: 'latex-extract',
  tools: [
    ExtractLatexFiguresTool,
    ExtractTikzFiguresTool,
    ExtractBibliographyTool,
  ],
};

/** The editor's diagnostics, offered while an editor attached for the
 *  session reads them: the plugin serves `HostCapabilities` from the same
 *  registry its tool reads. */
const latexDiagnostics = (editors: EditorRegistry) =>
  definePlugin<EditorHost>({
    id: 'latex-diagnostics',
    tools: [DiagnosticsTool],
    processLayer: {
      layer: Layer.mergeAll(
        Layer.succeed(EditorHost)(editors),
        Layer.succeed(HostCapabilities)(editors),
      ),
    },
  });

const arxiv: Plugin = {
  id: 'arxiv',
  tools: [ArxivSearchTool, ArxivDownloadTool],
};

const TEX_INSTRUCTIONS = `Find the project's TeX sources with relative paths (e.g., \`find . -name "*.tex"\`).\nFor math in responses, use $...$ or \\(...\\) for inline and $$...$$ or \\[...\\] for display math. Wrap LaTeX environments like align or gather inside $$...$$ (e.g., $$\\begin{align}...\\end{align}$$) so they render correctly.`;

/**
 * Tools every host offers without setup that no dashboard card lists:
 * review annotations, the PDF viewer, the user-question dialog, and Loogle
 * search (network only, so not gated on the Lean 4 plugin's probe). Its
 * prompt section, at every step of every run, finds the TeX sources, says how
 * replies write math, and names the configured default bibliography.
 */
const core = (editors: EditorRegistry, provider?: InlineCommentProvider) =>
  definePlugin<EditorHost>({
    id: 'core',
    tools: [
      InlineCommentTool,
      OpenPdfTool,
      AskUserQuestionTool,
      LeanLoogleTool,
    ],
    prompt: ({ config }) => {
      const bibPath = Settings.getConfig<string>(config, 'bib.defaultPath');
      return bibPath
        ? `${TEX_INSTRUCTIONS}\nThe default bibliography file is ${bibPath}. You can grep or read this file to search for citations and references.`
        : TEX_INSTRUCTIONS;
    },
    // The editor's PDF viewer; the host's Comments UI, for the one host
    // that has one, where `inline_comment` is offered.
    processLayer: {
      layer:
        provider === undefined
          ? Layer.succeed(EditorHost)(editors)
          : Layer.mergeAll(
              Layer.succeed(EditorHost)(editors),
              Layer.succeed(InlineComments)(provider),
              serves(() => [
                'inline-comments' satisfies InlineCommentCapability,
              ]),
            ),
    },
  });

/** The onboarding agent's narrow set, one concern per tool, over the host's
 *  setup capabilities: a tool that needs a member the host left undefined
 *  is not offered. The members are read when asked, not here. */
const setup = (platform: SetupPlatformShape, host: SetupHost['Service']) =>
  definePlugin<SetupPlatform | SetupHost>({
    id: 'setup',
    processLayer: {
      layer: Layer.mergeAll(
        Layer.succeed(SetupPlatform)(platform),
        Layer.succeed(SetupHost)(host),
        serves(() =>
          Object.entries(platform).flatMap(([member, value]) =>
            value === undefined ? [] : [member],
          ),
        ),
      ),
    },
    tools: [
      ProbeEnvironmentTool,
      UnsetApiKeyTool,
      InvokeCommandTool,
      InstallVscodeExtensionTool,
      ReadConfigTool,
      UpdateConfigTool,
      SendToTerminalTool,
      ApplyTeamTool,
    ],
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
      ? [
          'An agent marked (task) in the available agents also runs a document task over files with `document_task`.',
          ...(offered.includes('script')
            ? [
                "In a script, `const { revise, from } = await import('builtIn:documents')`: `revise(agentName, args)` runs a task (`args` as `document_task`'s) and resolves to its result; `from(result, args)` is `args` with that result's revised files as the input files, to chain tasks.",
              ]
            : []),
        ].join(' ')
      : '',
  scriptModules: { documents: DOCUMENTS_MODULE },
  tools: [
    AcceptRunFilesTool,
    DocumentTaskTool,
    DocumentContextTool,
    DocumentExtractTool,
    DocumentCompileTool,
    DocumentDiffTool,
    DocumentReviewTool,
    DocumentProposeTool,
  ],
  arms: APP_PLUGIN_ARMS.documents,
};

/** TeXRA's plugins, in dashboard order. */
export const texraPlugins = (host: {
  /** Which host this is, as the setup agent's environment probe reports it. */
  readonly name: SetupHost['Service'];
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
  /** The host shows external inquiries (VS Code, desktop): the `inquiry`
   *  tool is offered only there. */
  readonly inquiryPanel?: true;
}): readonly Plugin[] => {
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
    host.inquiryPanel
      ? {
          ...externalInquiry,
          processLayer: {
            layer: serves(() => [
              'inquiry-panel' satisfies InquiryPanelCapability,
            ]),
          },
        }
      : externalInquiry,
    codex,
    claudeAgent,
    core(editors, host.inlineComments),
    codemode,
    setup(host.setup ?? {}, host.name),
    documents,
  ];
};
