// Third-party imports
import { Cause, Effect, FileSystem, Layer, Schedule, Stream } from 'effect';

// Local imports
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { revisionKey } from '@common/plugins/mcpServers';
import {
  installedPluginId,
  readInstalledPluginLoad,
} from '@common/plugins/pluginTrust';
import { AppState } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingHost } from '@shared/state/stateSettings';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  type CanonicalDelegationToolName,
} from '@shared/constants/delegationTools';
import { LiveTools, toolTableLayer } from '@tools/liveTools';
import { mcpPlugin, mcpPluginLoader } from '@tools/mcp/mcpConfig';
import {
  readDisabledTools,
  switchedOffPlugins,
  TOOL_PLUGINS,
  type PluginToolName,
  type ToolPluginEntry,
  type ToolPluginId,
} from '@tools/plugins';
import {
  claudeAgentSessionsLayer,
  codexThreadsLayer,
} from '@tools/agentCliSessionStores';
import { GitHubSubscriptions } from '@tools/github/subscriptionBindings';
import { gitHubSubscriptionsLayer } from '@tools/github/subscriptionRegistries';
import { goalContinuation } from '@tools/goal/goalContinuation';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';
import { sha256 } from '@tools/catalogEntries';
import {
  toolTable,
  type Continuation,
  type InstalledToolReader,
  type ProcessPluginLayer,
  type PromptSection,
  type SessionPluginLayer,
} from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { BashTool } from './bash';
import { DiagnosticsTool } from './DiagnosticsTool';
import { InlineCommentTool } from './comment/InlineCommentTool';
import { EditFileTool } from './EditTool';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { ExtractBibliographyTool } from './latex/ExtractBibliographyTool';
import { ExtractLatexFiguresTool } from './latex/ExtractFiguresTool';
import { ExtractTikzFiguresTool } from './latex/ExtractTikzFiguresTool';
import { ArxivDownloadTool } from './arxiv/ArxivDownloadTool';
import { ArxivMetadataTool } from './arxiv/ArxivMetadataTool';
import { ArxivSearchTool } from './arxiv/ArxivSearchTool';
import { ReadFileTool } from './ReadTool';
import { WriteFileTool } from './WriteTool';
import { WebFetchTool } from './web/WebFetchTool';
import { WebSearchTool } from './web/WebSearchTool';
import { WolframTool } from './wolfram/WolframTool';
import { TexcountTool } from './texcount/TexcountTool';
import { CrossrefSearchTool } from './citation/CrossrefSearchTool';
import { PlanTool } from './plan/PlanTool';
import { TodoWriteTool } from './todo/TodoTool';
import { MemoryTool } from './memory/MemoryTool';
import { OpenPdfTool } from './OpenPdfTool';
import { ZoteroAddTool } from './zotero/ZoteroAddTool';
import { ZoteroCollectionsTool } from './zotero/ZoteroCollectionsTool';
import { ZoteroExportTool } from './zotero/ZoteroExportTool';
import { ZoteroSearchTool } from './zotero/ZoteroSearchTool';
import { CodexTool } from './codex';
import { ClaudeAgentTool } from './claudeAgent';
import { CLAUDE_AGENT_NAME } from './claudeAgentShared';
import {
  LeanDiagnosticsTool,
  LeanFileTool,
  LeanProjectTool,
  LeanInspectTool,
} from './lean/LspTools';
import { LeanLoogleTool } from './lean/LoogleTool';
import {
  WorkflowAgentTool,
  DelegateAgentTool,
} from './delegation/DelegationTools';
import { WorkflowScriptTool } from './delegation/WorkflowScriptTool';
import { ExecutionsTool } from './ExecutionsTool';
import { AcceptRunFilesTool } from './AcceptRunFilesTool';
import { codeSandboxLayer, ScriptTool } from './codemode/ScriptTool';
import { ExternalInquiryTool } from './inquiry/ExternalInquiryTool';
import { AskUserQuestionTool } from './userQuestion/UserQuestionTool';
import { GitHubSubscriptionTool } from './github/githubSubscriptionTool';
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

/**
 * Every plugin's tool objects, keyed by plugin id then tool name. The
 * `satisfies` clause is the manifest check: each plugin in `TOOL_PLUGINS` must
 * appear here with exactly the tools its `toolNames` declares — a missing or
 * extra name, or an unknown plugin id, is a compile error.
 */
const PLUGIN_TOOLS = {
  'file-ops': {
    bash: BashTool,
    read_file: ReadFileTool,
    write_file: WriteFileTool,
    edit_file: EditFileTool,
    glob: GlobTool,
    grep: GrepTool,
  },
  'latex-extract': {
    extract_figures: ExtractLatexFiguresTool,
    extract_tikz_figures: ExtractTikzFiguresTool,
    extract_bib_entries: ExtractBibliographyTool,
  },
  'latex-diagnostics': { diagnostics: DiagnosticsTool },
  arxiv: {
    arxiv_search: ArxivSearchTool,
    arxiv_metadata: ArxivMetadataTool,
    download_arxiv_source: ArxivDownloadTool,
  },
  crossref: { crossref_search: CrossrefSearchTool },
  web: { web_search: WebSearchTool, web_fetch: WebFetchTool },
  'memory-workflow': {
    memory: MemoryTool,
    todo_write: TodoWriteTool,
    delegate_workflow: WorkflowAgentTool,
    delegate_agent: DelegateAgentTool,
    executions: ExecutionsTool,
    accept_run_files: AcceptRunFilesTool,
  },
  goal: { plan: PlanTool },
  texcount: { texcount: TexcountTool },
  wolfram: { wolfram: WolframTool },
  zotero: {
    zotero_collections: ZoteroCollectionsTool,
    zotero_search: ZoteroSearchTool,
    zotero_add: ZoteroAddTool,
    zotero_export: ZoteroExportTool,
  },
  lean4: {
    lean_diagnostics: LeanDiagnosticsTool,
    lean_file: LeanFileTool,
    lean_project: LeanProjectTool,
    lean_inspect: LeanInspectTool,
  },
  'workflow-script': { [DELEGATE_MULTI_AGENTS_TOOL_NAME]: WorkflowScriptTool },
  'github-pr-subscription': { github_subscription: GitHubSubscriptionTool },
  'external-inquiry': { inquiry: ExternalInquiryTool },
  codex: { codex: CodexTool },
  'claude-agent': { [CLAUDE_AGENT_NAME]: ClaudeAgentTool },
  copilot: {},
  codemode: { script: ScriptTool },
  core: {
    inline_comment: InlineCommentTool,
    open_pdf: OpenPdfTool,
    ask_user_question: AskUserQuestionTool,
    lean_loogle: LeanLoogleTool,
  },
  setup: {
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
} as const satisfies {
  readonly [Id in ToolPluginId]: {
    readonly [Name in PluginToolName<Id>]: ITool;
  };
};

/** The continuation of each plugin whose manifest entry declares one. */
const PLUGIN_CONTINUATIONS = {
  goal: goalContinuation,
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly continuation: true }>['id']
  ]: Continuation;
};

/** The prompt section of each plugin whose manifest entry declares one. */
const PLUGIN_PROMPT_SECTIONS: Readonly<Record<string, PromptSection>> = {
  'memory-workflow': memoryPromptSection,
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly promptSection: true }>['id']
  ]: PromptSection;
};

// ------------------------------------------------------------ plugin layers

/**
 * The process services of each plugin whose manifest entry declares
 * `processLayer`, up while the plugin is on or pinned (`@tools/liveTools`).
 * GitHub's delivery drain is its step of the core shutdown protocol.
 */
const PLUGIN_PROCESS_LAYERS = {
  'github-pr-subscription': {
    layer: gitHubSubscriptionsLayer,
    drain: Effect.flatMap(GitHubSubscriptions, (s) => s.drainDeliveries),
  },
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly processLayer: true }>['id']
  ]: ProcessPluginLayer;
};

/** The session services of each plugin whose manifest entry declares
 *  `sessionLayer`: one build per open session. */
const PLUGIN_SESSION_LAYERS = {
  codemode: codeSandboxLayer,
  codex: codexThreadsLayer,
  'claude-agent': claudeAgentSessionsLayer,
} as const satisfies {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly sessionLayer: true }>['id']
  ]: SessionPluginLayer;
};

type PluginTools = typeof PLUGIN_TOOLS;

/** Union of all registered tool names. */
type RegisteredToolName = {
  [Id in ToolPluginId]: keyof PluginTools[Id];
}[ToolPluginId];

/**
 * Compile-time guard: every canonical tool with specialized display treatment
 * must remain registered.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreRegistered = AssertNever<
  Exclude<CanonicalToolDisplayName, RegisteredToolName>
>;

/** Compile-time guard for canonical delegation names; historical aliases are excluded. */
type _CanonicalDelegationNamesAreRegistered = AssertNever<
  Exclude<CanonicalDelegationToolName, RegisteredToolName>
>;

/**
 * Every plugin's tools, continuation and prompt contribution, which the
 * process serves as the `ToolRegistry` service. Flattening cannot overwrite
 * a tool: the manifest rules out a name two plugins share.
 */
const TOOL_TABLE = toolTable(
  PLUGIN_TOOLS,
  PLUGIN_CONTINUATIONS,
  // Each plugin's section, and whether it ships skills for the catalog.
  Object.fromEntries(
    TOOL_PLUGINS.flatMap(({ id, skills }) => {
      const section = PLUGIN_PROMPT_SECTIONS[id] ?? null;
      return section !== null || skills
        ? [[id, { section, skills: skills === true }]]
        : [];
    }),
  ),
  PLUGIN_PROCESS_LAYERS,
  PLUGIN_SESSION_LAYERS,
);

/** A switch apply's backoff: 200 ms doubling, over six retries. */
const SWITCH_READ = Schedule.exponential('200 millis');

/** The process layers a host supplies, for the plugins whose manifest
 *  entry declares `hostLayer` (the VS Code host's Copilot tools). */
export type HostPluginLayers = {
  readonly [
    Id in Extract<ToolPluginEntry, { readonly hostLayer: true }>['id']
  ]?: ProcessPluginLayer;
};

/**
 * The process's `ToolRegistry` and the live catalog (`LiveTools`) over it,
 * the process layers `hostLayers` adds, and the MCP servers of
 * `mcpConfigPath` (a host's is the user's `~/.texra/mcp.json`), which
 * `installProcessRuntime` provides. The layer takes the process `FileSystem`
 * that `installProcessRuntime` serves, to read that file, and its
 * `AppState`, which holds the key MCP env values are digested under, the
 * switches and the plugin install record. A switch flipped or a plugin
 * disabled in any process sharing that state reaches the catalog at once
 * (`AppState.changes`), not only at a run's next step, so what follows the
 * catalog outside a run (a host layer's lifetime, its Copilot tools, an
 * installed plugin's server) follows the switch.
 */
export const toolRegistryLayer = (
  mcpConfigPath: string,
  hostLayers: HostPluginLayers = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const appState = yield* AppState;
      // Resolved once per process, on the first run that declares an MCP tool.
      const envKey = yield* Effect.cached(revisionKey(appState));
      // The installed plugins a step loads: the enabled, trusted ones, each
      // keyed by what it would start, and why each other enabled one loads
      // nothing. One that ships only skills loads with no servers.
      const installed: InstalledToolReader = Effect.gen(function* () {
        const load = yield* readInstalledPluginLoad({
          globalState: appState,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        const withServers = load.loadable.filter(
          ({ plugin }) => plugin.mcpServers.length > 0,
        );
        const warnings = [
          ...load.withheld,
          ...withServers.flatMap(({ plugin }) => plugin.warnings),
        ];
        const key =
          withServers.length === 0 ? undefined : yield* Effect.result(envKey);
        if (key?._tag === 'Failure')
          warnings.push(
            `No installed plugin's MCP servers start: ${key.failure.message}`,
          );
        return {
          plugins: load.loadable.map((source) => {
            const { record, plugin, trust } = source;
            const id = installedPluginId(record.name);
            const servers =
              key?._tag === 'Success'
                ? plugin.mcpServers.map((server) =>
                    mcpPlugin(server, key.success, id),
                  )
                : [];
            return {
              id,
              key: sha256({
                trust,
                servers: servers.map(({ spec, revision }) => [spec, revision]),
              }),
              servers,
              source,
            };
          }),
          warnings,
        };
      });
      const catalog = toolTableLayer(
        {
          ...TOOL_TABLE,
          processLayers: new Map([
            ...TOOL_TABLE.processLayers,
            ...Object.entries(hostLayers),
          ]),
        },
        mcpPluginLoader(fs, mcpConfigPath, envKey),
        // Fail closed: every plugin with a switch stays off until the
        // switches are read, so an unreadable store never enables one.
        switchedOffPlugins(new Set(TOOL_PLUGINS.map(({ id }) => id))),
        installed,
      );
      const followSwitches = Layer.effectDiscard(
        Effect.gen(function* () {
          const live = yield* LiveTools;
          const off = Effect.map(
            readDisabledTools(appState),
            switchedOffPlugins,
          );
          // Nothing stays pinned: a pin here only applies the switches and
          // withdraws the installed plugins no longer enabled; it starts
          // none. A failed apply changes nothing, so what is off stays off;
          // it is tried again with a bounded backoff, the catalog's lock
          // released between tries, and a change it still misses is logged.
          const apply = Effect.scoped(
            live.pinSwitched(off, { installed: 'withdraw' }),
          ).pipe(
            Effect.retry({ schedule: SWITCH_READ, times: 6 }),
            Effect.catchCause((cause) =>
              Effect.logError(
                `Tool switches were not applied to the catalog after seven tries; the plugins they switch stay as they were (off, before the first read) until the switches or the install record change again: ${toErrorMessage(Cause.squash(cause))}`,
              ),
            ),
          );
          // The switches as they stand, then again on each change to them
          // or to the install record, written here or by another process,
          // off the build: a store not readable yet fails no process.
          yield* appState
            .changes([
              GlobalStateKey.DISABLED_TOOLS,
              GlobalStateKey.INSTALLED_PLUGINS,
            ])
            .pipe(
              Stream.runForEach(() => apply),
              Effect.forkScoped,
            );
        }),
      );
      return Layer.provideMerge(followSwitches, catalog);
    }),
  );

/** Whether a registered tool declares itself unavailable on a product host. */
export function isToolUnavailableOnHost(
  name: string,
  host: SettingHost,
): boolean {
  return TOOL_TABLE.get(name)?.unavailableHosts?.includes(host) === true;
}
