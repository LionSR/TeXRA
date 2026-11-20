/**
 * TeXRA's plugin list: the harness's built-ins with TeXRA's options, beside
 * the app's own plugins, in the order the Tools dashboard lists them. Each
 * TeXRA host passes it to `processLayer`; nothing in the harness names an
 * app plugin. A plugin the dashboard lists carries its card, and a plugin
 * whose tools the transcript paints with an icon carries those icons; an
 * integration's plugin, availability check, card and icons sit in one
 * module beside its tools.
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
  type Plugin,
} from '@texra-ai/harness/plugins';

// Local imports
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import { AskUserQuestionTool } from '@texra/tools/userQuestion/UserQuestionTool';
import { texraPlugin } from '@texra/tools/texraPlugin';
import type { PluginSettingRow } from '@texra/shared/settingsView/settingRows';
import { THEORY_MODULES, THEORY_PROGRAMS } from './theory/programs';
import { APP_FACT_KINDS } from '@texra/shared/plugins/appFactKinds';
import { isTexFile } from '@texra/shared/latexFileTypes';

// Local file imports
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { arxiv } from './arxiv/plugin';
import { claudeAgent } from './agentCli/claudeAgentPlugin';
import { codex } from './agentCli/codexPlugin';
import {
  InlineComments,
  InlineCommentTool,
  type InlineCommentCapability,
  type InlineCommentProvider,
} from './comment/InlineCommentTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { EditorHost, editorRegistry, type EditorRegistry } from './editorHost';
import {
  DocumentCompileTool,
  DocumentContextTool,
  DocumentDiffTool,
  DocumentExtractTool,
  DocumentProposeTool,
} from './documents/documentTools';
import { DocumentReviewTool } from './documents/DocumentReviewTool';
import { githubActivity } from './github/plugin';
import { lean4 } from './lean/plugin';
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
import {
  SetupHost,
  SetupPlatform,
  type SetupPlatformShape,
} from './setup/platform';
import {
  EDITOR_EXTENSIONS_CAPABILITY,
  EditorIntegration,
  type EditorIntegrationShape,
} from '@texra/hosts/editorIntegration';
import { wolfram } from './wolframPlugin';
import { zotero } from './zotero/plugin';
import { type WriteFilter, Settings } from '@texra-ai/harness/plugins';
import { BIB_DEFAULT_PATH_SETTING } from '@texra/shared/settings/texraSettings';

/** How a user gets a probed plugin's dependency installed and signed in. */
export interface ToolPluginSetup {
  readonly installGuide?: string;
  readonly installUrl?: string;
  /** VS Code extension ID: when present, the dashboard offers a direct "Install" button. */
  readonly installExtensionId?: string;
  /** Shell command the dashboard can run in an integrated terminal to install the tool. */
  readonly installCommand?: string;
  /** Shell command the dashboard can run to sign the user in (e.g. `codex login`). */
  readonly authCommand?: string;
  readonly configNotes?: string;
  /** Short auth/billing note shown as a badge (e.g. "Uses ChatGPT subscription"). */
  readonly authNote?: string;
}

/** How the settings view's Plugins page and the CLI's `/plugins` show a
 *  plugin. */
export interface PluginCard {
  readonly name: string;
  readonly description: string;
  /** The plugin's catalog rows the card renders inline, in order; the
   *  catalog itself takes them from TeXRA's rows (`@texra/shared/settings/texraSettings`). */
  readonly settings?: readonly PluginSettingRow[];
  /** Install and sign-in copy and actions; only a probed plugin's card
   *  shows them. */
  readonly setup?: ToolPluginSetup;
}

/** A plugin of TeXRA's list, with the card the Tools dashboard shows for
 *  it (a plugin without one is listed on no dashboard) and the icon the
 *  transcript paints each of its tool calls with, by normalized tool name,
 *  from the UI toolkit's set (`@ui/wa/iconNames`). A call with no icon, or
 *  with a name the toolkit does not draw, gets the generic one. */
export type TexraPlugin = Plugin & {
  readonly dashboard?: PluginCard;
  readonly icons?: Readonly<Record<string, string>>;
  /** The tools, by normalized tool name, whose output the transcript paints
   *  as a terminal session, as it paints `bash`'s. */
  readonly terminalOutput?: readonly string[];
};

/** TeXRA's filter on `write_file`: a `.tex` file's content goes through the
 *  replacement rules of the call's workspace. */
const texWriteFilter: WriteFilter = (path, content, config) => {
  if (!isTexFile(path)) return Effect.succeed(content);
  const replaced = replacementEngine.applyToTexWrite(content, config);
  return logReplacementDiagnostics(replaced.diagnostics).pipe(
    Effect.as(replaced.text),
  );
};

/** The host capabilities (`ITool.hostCapability`) a plugin serves to a
 *  session's storage root, read each time a step asks. */
const serves = (capabilities: (storage: string) => Iterable<string>) =>
  Layer.succeed(HostCapabilities)({
    of: (storage) => new Set(capabilities(storage)),
  });

/** The editor's diagnostics, offered while an editor attached for the
 *  session reads them: the plugin serves `HostCapabilities` from the same
 *  registry its tool reads. */
const latexDiagnostics = (editors: EditorRegistry): TexraPlugin => ({
  ...definePlugin<EditorHost>({
    id: 'latex-diagnostics',
    tools: [DiagnosticsTool],
    processLayer: {
      layer: Layer.mergeAll(
        Layer.succeed(EditorHost)(editors),
        Layer.succeed(HostCapabilities)(editors),
      ),
    },
  }),
  icons: { diagnostics: 'list-check' },
  dashboard: {
    name: 'LaTeX Diagnostics',
    description:
      'Report LaTeX compilation errors and warnings from the VS Code Problems panel.',
  },
});

const FIND_TEX_SOURCES = `Find the project's TeX sources with relative paths (e.g., \`find . -name "*.tex"\`).`;

const MATH_IN_REPLIES = `For math in responses, use $...$ or \\(...\\) for inline and $$...$$ or \\[...\\] for display math. Wrap LaTeX environments like align or gather inside $$...$$ (e.g., $$\\begin{align}...\\end{align}$$) so they render correctly.`;

/**
 * Tools that need no setup and that no dashboard card lists: review
 * annotations and the PDF viewer (each offered where the host serves it),
 * and the user-question dialog. Its
 * prompt section, at every step that offers a tool, says how replies write
 * math and names the configured default bibliography; how to find the TeX
 * sources and read the bibliography is said only to a step offered a tool
 * that does it.
 */
const core = (
  editors: EditorRegistry,
  provider?: InlineCommentProvider,
): TexraPlugin => ({
  ...definePlugin<EditorHost>({
    id: 'core',
    tools: [InlineCommentTool, OpenPdfTool, AskUserQuestionTool],
    // The section writes math for a rendered reply: a run that writes a
    // document, with no tool offered, gets none of it (`$$\\begin{align}`
    // inside a .tex file does not compile).
    prompt: ({ config, offered }) => {
      if (offered.length === 0) return '';
      const offers = (...names: string[]) =>
        names.some((name) => offered.includes(name));
      const bibPath = Settings.getConfig(config, BIB_DEFAULT_PATH_SETTING);
      return [
        ...(offers('bash') ? [FIND_TEX_SOURCES] : []),
        MATH_IN_REPLIES,
        ...(bibPath
          ? [
              `The default bibliography file is ${bibPath}.${offers('grep', 'read_file', 'bash') ? ' You can grep or read this file to search for citations and references.' : ''}`,
            ]
          : []),
      ].join('\n');
    },
    // The editor's PDF viewer, where `open_pdf` is offered while one is
    // attached; the host's Comments UI, for the one host that has one,
    // where `inline_comment` is offered.
    processLayer: {
      layer: Layer.mergeAll(
        Layer.succeed(EditorHost)(editors),
        ...(provider === undefined
          ? []
          : [Layer.succeed(InlineComments)(provider)]),
        serves((storage) => [
          ...editors.of(storage),
          ...(provider === undefined
            ? []
            : ['inline-comments' satisfies InlineCommentCapability]),
        ]),
      ),
    },
  }),
});

/** The onboarding agent's narrow set, one concern per tool, over the host's
 *  setup capabilities: a tool that needs a member the host left undefined
 *  is not offered. The members are read when asked, not here. */
const setup = (
  platform: SetupPlatformShape,
  host: SetupHost['Service'],
  editor: EditorIntegrationShape | undefined,
) =>
  definePlugin<SetupPlatform | SetupHost>({
    id: 'setup',
    processLayer: {
      layer: Layer.mergeAll(
        Layer.succeed(SetupPlatform)(platform),
        Layer.succeed(SetupHost)(host),
        Layer.succeed(EditorIntegration)(editor),
        serves(() => [
          ...Object.entries(platform).flatMap(([member, value]) =>
            value === undefined ? [] : [member],
          ),
          ...(editor ? [EDITOR_EXTENSIONS_CAPABILITY] : []),
        ]),
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
    ],
  });

/** The theorist's programs: the document programs a person or a model
 *  starts by name, the tools they call, and accepting the documents a run
 *  produced into the workspace. */
const theory: TexraPlugin = texraPlugin({
  id: 'theory',
  icons: { accept_run_files: 'check' },
  prompt: ({ offered }) =>
    offered.includes('program')
      ? [
          '`program` starts a document program over files (`inputFiles`, with `contextFiles` it may read and not change).',
          // The script tool's description lists the programs; a run without
          // it reads them here.
          ...(offered.includes('script')
            ? []
            : [
                `The programs: ${Object.entries(THEORY_PROGRAMS)
                  .map(
                    ([name, { description }]) => `\`${name}\` (${description})`,
                  )
                  .join('; ')}.`,
              ]),
          'Each rewrites whole documents in fixed revisions, with compile checks and diffs, and proposes the result for the user to accept; it reads only the files you pass. What to change, how far and from which point of view is the `prompt`: one program covers a proofread and a restructuring, a referee and a first reader.',
          "Its `args` may switch on `reflect` (a critic reviews each revision but the last), `attachTeXCount` (word counts in the prompt), and `autoExtractFigure`, `autoExtractTikzFigure` or `autoCompileInputPdf` (the inputs' figures, compiled TikZ pictures or PDF as media, for a model that reads images).",
          'Its delivery lists each proposed file with a `diff` attribute, the diff against the document the program started from, readable among the run\'s files (`/executions/{id}/files/<diff>`), and `large-change="true"` when the file changed extensively; a diff may be truncated.',
          "The host compiles each .tex the program writes: a file that failed to build leaves its log at `compile/r{n}_<name>.log` among the run's files, which the delivery's `<compile-failures>` names (read it at `/executions/{id}/files/<log>`), and no log means every build passed or no LaTeX toolchain is installed.",
          ...(offered.includes('script')
            ? [
                "In a script, `program(name, { prompt, inputFiles })` resolves to the program's result, whose `changes` list each revision's files in order: pass the last `absolutePath` of each `path` as the `inputFiles` of the next program to chain them. `describeTool(name)` shows a program's source, and `builtIn:revise` exports what the programs are built from.",
              ]
            : []),
        ].join(' ')
      : '',
  scriptModules: THEORY_MODULES,
  programs: THEORY_PROGRAMS,
  tools: [
    AcceptRunFilesTool,
    DocumentContextTool,
    DocumentExtractTool,
    DocumentCompileTool,
    DocumentDiffTool,
    DocumentReviewTool,
    DocumentProposeTool,
  ],
  factKinds: APP_FACT_KINDS.theory,
});

/** TeXRA's plugins, in dashboard order. */
export const texraPlugins = (host: {
  /** Which host this is, as the setup agent's environment probe reports it. */
  readonly name: SetupHost['Service'];
  /** The host's Comments UI behind `inline_comment`. */
  readonly inlineComments?: InlineCommentProvider;
  /** The host's setup capabilities (VS Code's commands and terminal);
   *  none elsewhere. */
  readonly setup?: SetupPlatformShape;
  /** The host's code editor (VS Code); none elsewhere. */
  readonly editor?: EditorIntegrationShape;
  /** What the composition's windows offer the editor tools (its window
   *  table's `editors`); none offered when absent. */
  readonly editors?: EditorRegistry;
}): readonly TexraPlugin[] => {
  const editors = host.editors ?? editorRegistry(() => ({}));
  const plugins: readonly TexraPlugin[] = [
    {
      ...fileOps({ writeFilter: texWriteFilter }),
      icons: {
        bash: 'terminal',
        read_file: 'file',
        write_file: 'file-circle-plus',
        edit_file: 'pencil',
        glob: 'magnifying-glass',
        grep: 'magnifying-glass',
      },
      dashboard: {
        name: 'File & Shell Operations',
        description:
          'Read, write, edit files and run shell commands. Includes glob/grep search.',
      },
    },
    latexDiagnostics(editors),
    arxiv,
    {
      ...web,
      icons: { web_search: 'globe', web_fetch: 'globe' },
      dashboard: {
        name: 'Web Search & Fetch',
        description:
          'Search the web with DuckDuckGo Instant Answers and fetch or extract content from URLs.',
      },
    },
    {
      ...memoryWorkflow,
      icons: { memory: 'database', executions: 'clock-rotate-left' },
      dashboard: {
        name: 'Memory & Executions',
        description:
          'Persistent memory across sessions and the executions view of the runs an agent launched.',
      },
    },
    {
      ...goal,
      dashboard: {
        name: 'Goal Mode',
        description:
          'Propose a plan for approval and, when you run it as a goal, let the agent keep working turn after turn until the objective is done or it needs you.',
        setup: {
          configNotes:
            "No local install required. Turning this off removes the plan tool from every agent and stops goal turns, from each run's next step.",
        },
      },
    },
    wolfram,
    zotero,
    lean4,
    {
      ...multiAgent,
      icons: { agent: 'circle-user' },
      dashboard: {
        name: 'Multi-Agent Workflow',
        description:
          'Run named agents as children of a run: one at a time, or fanned out and joined from a script, resuming safely after interruption. An agent only gets the agent and program tools if its own configuration names them: this switch is an additional kill switch on top of that per-agent opt-in.',
        setup: {
          configNotes:
            'No local install required. Turning this off removes the agent and program tools from every agent tool list, even agents whose configuration names them explicitly, so no agent can delegate or start a program.',
        },
      },
    },
    githubActivity,
    codex,
    claudeAgent,
    core(editors, host.inlineComments),
    { ...codemode, icons: { script: 'code' } },
    setup(host.setup ?? {}, host.name, host.editor),
    theory,
  ];
  // The entries built here are held for the life of the process as the
  // module-level ones are, so they are frozen the same way.
  return plugins.map(texraPlugin);
};
