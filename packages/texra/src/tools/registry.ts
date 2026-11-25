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
  codemode,
  fileOps,
  goal,
  memoryWorkflow,
  multiAgent,
  web,
} from '@texra-ai/worldline/builtins';
import {
  HostCapabilities,
  definePlugin,
  type Plugin,
} from '@texra-ai/worldline/plugins';

// Local imports
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import { AskUserQuestionTool } from '@texra/tools/userQuestion/UserQuestionTool';
import { texraPlugin } from '@texra/tools/texraPlugin';
import type { ToolInstallAction } from '@texra/shared/settingsView/settingsViewMessages';
import { THEORY_MODULES, THEORY_PROGRAMS } from './theory/programs';
import { hasExtension } from '@texra-ai/worldline/schemas';

// Local file imports
import {
  InlineComments,
  InlineCommentTool,
  type InlineCommentCapability,
  type InlineCommentProvider,
} from './comment/InlineCommentTool';
import { DiagnosticsTool } from './DiagnosticsTool';
import { EditorHost, editorRegistry, type EditorRegistry } from './editorHost';
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
import { SETUP_PROMPT } from './setup/setupPrompt';
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
import { type WriteFilter } from '@texra-ai/worldline/builtins';
import { Settings } from '@texra-ai/worldline/plugins';
import { BIB_DEFAULT_PATH_SETTING } from '@texra/shared/settings/texraSettings';

/** How a user gets a probed plugin's dependency installed and signed in. */
export interface ToolPluginSetup {
  /**
   * The install and sign-in steps the card offers, in order: the guide, a
   * command the dashboard runs in a terminal to install the tool or sign
   * the user in, a VS Code extension (offered only where an editor is),
   * the install page. A plugin whose install command depends on a probe
   * declares this as a getter, so the probe runs when the card is read.
   */
  readonly actions?: readonly ToolInstallAction[];
  readonly configNotes?: string;
  /** Short auth/billing note shown as a badge (e.g. "Uses ChatGPT subscription"). */
  readonly authNote?: string;
}

/** How the settings view's Plugins page and the CLI's `/plugins` show a
 *  plugin. */
export interface PluginCard {
  readonly name: string;
  readonly description: string;
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
};

/** TeXRA's filter on `write_file`: a `.tex` file's content goes through the
 *  replacement rules of the call's workspace. */
const texWriteFilter: WriteFilter = (path, content, config) => {
  if (!hasExtension(path, '.tex')) return Effect.succeed(content);
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
        ...(offers('open_pdf')
          ? [
              'After compiling a document the user asked to see, show it with `open_pdf`.',
            ]
          : []),
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
    prompt: ({ offered }) =>
      offered.includes('probe_environment') ? SETUP_PROMPT : '',
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

/** The theorist's programs, which a person or a model starts by name. */
const theory: TexraPlugin = texraPlugin({
  id: 'theory',
  // The script tool's description lists the programs; a run offered
  // `program` without it reads them here.
  prompt: ({ offered }) =>
    offered.includes('program') && !offered.includes('script')
      ? `The LaTeX programs \`program\` starts: ${Object.entries(
          THEORY_PROGRAMS,
        )
          .map(([name, { description }]) => `\`${name}\` (${description})`)
          .join('; ')}.`
      : '',
  scriptModules: THEORY_MODULES,
  programs: THEORY_PROGRAMS,
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
        name: 'Memory & Task History',
        description:
          'Persistent memory across tasks and inspection of agents launched during a task.',
      },
    },
    {
      ...goal,
      dashboard: {
        name: 'Goal Mode',
        description:
          'Propose a plan and run it autonomously across rounds until complete or input is needed.',
        setup: {
          configNotes:
            'Turning this off disables the plan tool and stops goal rounds on the next turn.',
        },
      },
    },
    wolfram,
    lean4,
    {
      ...multiAgent,
      icons: { agent: 'circle-user' },
      dashboard: {
        name: 'Multi-Agent Workflow',
        description:
          'Let the assistant delegate work to helper agents and programs, sequentially or in parallel.',
        setup: {
          configNotes:
            'Turning this off removes delegation and program tools on the next turn.',
        },
      },
    },
    core(editors, host.inlineComments),
    { ...codemode, icons: { script: 'code' } },
    setup(host.setup ?? {}, host.name, host.editor),
    theory,
  ];
  // The entries built here are held for the life of the process as the
  // module-level ones are, so they are frozen the same way.
  return plugins.map(texraPlugin);
};
