// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import {
  signIn as authSignIn,
  signOut as authSignOut,
  viewProfile as authViewProfile,
} from '@auth/authCommands';
import {
  stopAgent as agentStopAgent,
  compactResponse as agentCompactResponse,
  handleCreateAgentWithAI as agentHandleCreateAgentWithAI,
  runExecuteCommand as agentRunExecuteCommand,
} from '@commands/agent';
import { downloadArXivSource as latexDownloadArXivSource } from '@commands/latex';
import { runSetupAssistant as setupRunAssistant } from '@commands/setup';
import {
  createSampleProject as sysCreateSampleProject,
  handleTestConnection as sysHandleTestConnection,
  handleTestAgentLoading as sysHandleTestAgentLoading,
  handleLoadSpecificAgent as sysHandleLoadSpecificAgent,
  showImportOptions as sysShowImportOptions,
} from '@commands/system';
import {
  setApiKey as apiSetApiKey,
  removeApiKey as apiRemoveApiKey,
} from '@commands/api/apiKeyCommands';
import {
  handleIndentTeX,
  handleIndentCurrentTeX as latexIndentCurrentTeX,
  handleApplyReplacements as latexApplyReplacements,
  handleFixCompilation as latexFixCompilation,
  handleGetTeXCount as latexGetTeXCount,
} from '@commands/latex/latexCommands';
import {
  handleCountPdfPages as latexCountPdfPages,
  handleEncodeImageToBase64 as latexEncodeImageToBase64,
  handleConvertPdfToImages as latexConvertPdfToImages,
} from '@commands/latex/imageCommands';
import {
  handleShowLinterMessages as latexShowLinterMessages,
  handleCountLinterMessages as latexCountLinterMessages,
} from '@commands/latex/linterCommands';
import {
  handleExtractFigurePaths as latexExtractFigurePaths,
  handleExtractTikzFigures as latexExtractTikzFigures,
  handleCompileTikzFigures as latexCompileTikzFigures,
} from '@commands/latex/figCommands';
import { cloneOverleafProject as gitCloneOverleafProject } from '@commands/git/gitCommands';
import {
  openProgressViewInTab as progressOpenInTab,
  showProgressView as progressShowProgressView,
} from '@commands/progress/progressViewCommands';
import { openDoc as sysOpenDoc } from '@commands/system/helpCommands';
import { openGettingStarted as sysOpenGettingStarted } from '@commands/system/walkthroughCommands';
import { handleParseXml as sysParseXml } from '@commands/system/xmlCommands';
import { handleParseYaml as sysParseYaml } from '@commands/system/yamlCommands';
import { handleTestTextEditor as sysTestTextEditor } from '@commands/system/textEditorCommands';
import {
  MAIN_VIEW_COMMANDS,
  SIDEBAR_VIEWS,
  getActiveSidebarView,
} from '@common/webview';
import { type ApiProvider, SecretManager } from '@frontend/secretManager';
import { getMainWebview } from '@frontend/system/commandUtils';
import { runCleanBuild, runCleanOutput } from '@housekeeping';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import {
  definedHandler,
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import { StreamTabIdSchema } from '@shared/schemas/identifiers';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';
import { AgentCategorySchema, type AgentCategory } from '@shared/schemas/agent';
import { SETTINGS_QUERY } from '@utils/config';
import type { CommandId } from './catalog';

/**
 * Optional `ApiProvider` argument for `texra.setApiKey`. The schema accepts
 * `undefined` so the registry's `safeParse` succeeds when the command is
 * invoked from the palette without arguments — the action then prompts the
 * user via `showQuickPick`.
 */
const SetApiKeyArgSchema = z.enum(SecretManager.API_PROVIDERS).optional();

/**
 * Optional `AgentCategory` argument for `texra.createAgentWithAI`. The
 * registry parses raw `unknown` and the action defaults to `workflow`
 * when undefined (preserving the legacy `category ?? 'workflow'` shape).
 */
const CreateAgentWithAIArgSchema = AgentCategorySchema.optional();

/**
 * Optional `{ inPlace }` argument for `texra.showProgressView`. The
 * legacy registration accepted any argument shape and only honoured the
 * `inPlace` boolean — `z.unknown()` here preserves that best-effort
 * semantics so callers passing `null`, booleans, or stringified flags
 * still open the progress view (just without the in-place flag) instead
 * of being rejected by the dispatcher as unhandled.
 */
const ShowProgressViewArgSchema = z.unknown();

const RESET_CHANNEL = 'mainViewCommands';

/**
 * Subset of `CommandId` whose registration is now driven by the shared
 * `dispatchCommandFromRegistry` helper. Any new entry must also exist in
 * `commandCatalog` so the shared catalog stays the source of truth.
 *
 * The desktop registry (`packages/desktop/src/desktopCommandSurface.ts`)
 * dispatches the same IDs through the same helper — this is deliberate
 * so adding a new view-routing command is a single registry entry per
 * host, not a parallel `vscode.commands.registerCommand` call site.
 */
export type ExtensionRegistryCommandId = Extract<
  CommandId,
  | 'texra.showSettingsView'
  | 'texra.showDashboard'
  | 'texra.showMemory'
  | 'texra.showAgentHistory'
  | 'texra.showModels'
  | 'texra.showAgents'
  | 'texra.showTools'
  | 'texra.showMultiAgent'
  | 'texra.openSettings'
  | 'texra.mainView.reset'
  | 'texra.cleanOutput'
  | 'texra.cleanBuild'
  | 'texra.indentTeX'
  | 'texra.auth.signIn'
  | 'texra.auth.signOut'
  | 'texra.auth.viewProfile'
  | 'texra.runSetupAssistant'
  | 'texra.openGettingStarted'
  | 'texra.createSampleProject'
  | 'texra.downloadArXivSource'
  | 'texra.testConnection'
  | 'texra.testAgentLoading'
  | 'texra.loadSpecificAgent'
  | 'texra.openProgressViewInTab'
  | 'texra.openDoc'
  | 'texra.stopAgent'
  | 'texra.compactResponse'
  // Batch 2 (#3775) — no-arg host-context commands. These read from
  // the active editor or fixed UI surfaces; their args are not
  // serializable, so they ride the legacy no-arg handler shape.
  | 'texra.parseXml'
  | 'texra.parseYaml'
  | 'texra.testTextEditor'
  | 'texra.indentCurrentTeX'
  | 'texra.applyReplacements'
  | 'texra.fixCompilation'
  | 'texra.getTeXCount'
  | 'texra.countPdfPages'
  | 'texra.showLinterMessages'
  | 'texra.countLinterMessages'
  | 'texra.extractFigurePaths'
  // Batch 3 (#3781) — additional no-arg commands. Each handler runs
  // its own user prompt internally (file picker, input box) so the
  // VS Code call site doesn't pass arguments. The `cloneOverleafProject`
  // entry needs `vscode.ExtensionContext` for `secrets` access; that's
  // captured as a closure inside the action factory below.
  | 'texra.encodeImageToBase64'
  | 'texra.convertPdfToImages'
  | 'texra.extractTikzFigures'
  | 'texra.compileTikzFigures'
  | 'texra.cloneOverleafProject'
  // Batch 4 (#3781) — settings/api/agent surface follow-ups. The
  // typed handlers carry a Zod schema for their argument so the dispatcher
  // can parse the optional provider / category / inPlace / config flag
  // before the handler runs. The remaining no-arg entries (toggleView,
  // showImportOptions, removeApiKey) drive interactive UI flows internally.
  | 'texra.removeApiKey'
  | 'texra.showImportOptions'
  | 'texra.toggleView'
  | 'texra.showProgressView'
  | 'texra.setApiKey'
  | 'texra.createAgentWithAI'
  | 'texra.execute'
>;

/*
 * Duplicate-registration audit (#3787 follow-up):
 * Every command id in `EXTENSION_COMMAND_HANDLERS` +
 * `EXTENSION_PARAMETERIZED_HANDLERS` has been verified to have no stale
 * `vscode.commands.registerCommand(...)` call elsewhere. The remaining
 * legacy `registerCommand` call sites all register ids NOT present in
 * the registry — they're legitimate VS Code-only handlers (file ops, git,
 * latex tools, pack/clean variants). The shared `commandCatalog` remains
 * the authoritative list of registry entries; this map is the
 * authoritative registration mechanism for those entries.
 */

/**
 * Capabilities the registry handlers need from the extension host. Mirrors
 * `DesktopCommandActions` in shape — both register parallel handler maps
 * over the same `CommandId` union with their host-specific actions.
 */
export interface ExtensionCommandActions {
  showSettings(
    tabIndex?: SettingsTab,
    agentSubTab?: AgentCategory,
  ): Promise<void>;
  resetMainView(): Promise<void>;
  openWorkbenchSettings(): Thenable<unknown>;
  cleanBuild(): Promise<void>;
  cleanOutput(): Promise<void>;
  indentTeX(): Promise<void>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  viewProfile(): Promise<void>;
  runSetupAssistant(): Promise<void>;
  openGettingStarted(): Thenable<unknown>;
  createSampleProject(): Promise<void>;
  downloadArXivSource(): Promise<void>;
  testConnection(): Promise<void>;
  testAgentLoading(): Promise<void>;
  loadSpecificAgent(): Promise<void>;
  openProgressViewInTab(): Promise<void>;
  openDoc(page: string): Promise<void>;
  stopAgent(streamId: string): void;
  compactResponse(streamId: string): Promise<void>;
  parseXml(): Promise<void>;
  parseYaml(): Promise<void>;
  testTextEditor(): Promise<void>;
  indentCurrentTeX(): Promise<void>;
  applyReplacements(): Promise<void>;
  fixCompilation(): Promise<void>;
  getTeXCount(): Promise<void>;
  countPdfPages(): Promise<void>;
  showLinterMessages(): Promise<void>;
  countLinterMessages(): Promise<void>;
  extractFigurePaths(): Promise<void>;
  // Batch 3 (#3781). The action functions return data (the underlying
  // `string | string[] | undefined`) for direct callers, but the
  // registry's typed return is `Promise<boolean>`, so the dispatcher
  // wraps them with `awaitTrue(...)` and the resolved data is
  // intentionally dropped. Palette / `executeCommand` callers don't
  // consume the value today; if a future caller needs the original
  // payload it must call the action helper directly instead of going
  // through `vscode.commands.executeCommand`.
  encodeImageToBase64(): Promise<string | undefined>;
  convertPdfToImages(): Promise<string[] | string | undefined>;
  extractTikzFigures(): Promise<void>;
  compileTikzFigures(): Promise<void>;
  cloneOverleafProject(): Promise<void>;
  // Batch 4 (#3781).
  removeApiKey(): Promise<void>;
  showImportOptions(): Promise<void>;
  toggleView(): Promise<void>;
  showProgressView(inPlace: boolean): Promise<void>;
  setApiKey(provider: ApiProvider | undefined): Promise<void>;
  createAgentWithAI(category: AgentCategory): Promise<void>;
  execute(input: unknown): Promise<void>;
}

export function createExtensionCommandActions(
  context: vscode.ExtensionContext,
  settingsViewProvider: SettingsViewProvider,
): ExtensionCommandActions {
  return {
    showSettings(tabIndex, agentSubTab) {
      return settingsViewProvider.showSettingsView(tabIndex, agentSubTab);
    },
    async resetMainView() {
      const webviewView = await getMainWebview(RESET_CHANNEL);
      if (!webviewView) {
        void vscode.window.showWarningMessage(
          'Main view is not available. Please ensure the TeXRA view is open.',
        );
        return;
      }
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: {},
        isResetOperation: true,
      });
    },
    openWorkbenchSettings() {
      return vscode.commands.executeCommand(
        'workbench.action.openSettings',
        SETTINGS_QUERY.EXTENSION,
      );
    },
    cleanBuild: runCleanBuild,
    cleanOutput: runCleanOutput,
    indentTeX: handleIndentTeX,
    signIn: authSignIn,
    signOut: authSignOut,
    viewProfile: authViewProfile,
    runSetupAssistant: setupRunAssistant,
    openGettingStarted: () => sysOpenGettingStarted(context.extension.id),
    createSampleProject: () => sysCreateSampleProject(context.extensionPath),
    downloadArXivSource: latexDownloadArXivSource,
    testConnection: sysHandleTestConnection,
    testAgentLoading: sysHandleTestAgentLoading,
    loadSpecificAgent: sysHandleLoadSpecificAgent,
    openProgressViewInTab: progressOpenInTab,
    openDoc: sysOpenDoc,
    stopAgent: agentStopAgent,
    compactResponse: agentCompactResponse,
    parseXml: sysParseXml,
    parseYaml: sysParseYaml,
    testTextEditor: sysTestTextEditor,
    indentCurrentTeX: latexIndentCurrentTeX,
    applyReplacements: latexApplyReplacements,
    fixCompilation: latexFixCompilation,
    getTeXCount: latexGetTeXCount,
    countPdfPages: latexCountPdfPages,
    showLinterMessages: latexShowLinterMessages,
    countLinterMessages: latexCountLinterMessages,
    extractFigurePaths: latexExtractFigurePaths,
    encodeImageToBase64: latexEncodeImageToBase64,
    convertPdfToImages: latexConvertPdfToImages,
    extractTikzFigures: latexExtractTikzFigures,
    compileTikzFigures: latexCompileTikzFigures,
    cloneOverleafProject: () => gitCloneOverleafProject(context),
    removeApiKey: apiRemoveApiKey,
    showImportOptions: sysShowImportOptions,
    async toggleView() {
      const target =
        getActiveSidebarView() === SIDEBAR_VIEWS.MAIN
          ? 'texra.showProgressView'
          : 'texra.showMainView';
      await vscode.commands.executeCommand(target);
    },
    showProgressView: progressShowProgressView,
    setApiKey: apiSetApiKey,
    createAgentWithAI: (category) =>
      agentHandleCreateAgentWithAI(context, category),
    execute: agentRunExecuteCommand,
  };
}

/**
 * Dispatch a no-arg `actions.X()` call through the registry while
 * preserving async semantics. Sync handlers that miss this helper
 * regressed in #3778 — the original `void actions.X(); return true;`
 * shape fired-and-forgot the promise, swallowing rejections (#3782).
 *
 * Wrap promise-returning actions through `awaitTrue` so the dispatcher
 * actually awaits the work and surfaces failures.
 */
function awaitTrue(p: Promise<unknown> | Thenable<unknown>): Promise<boolean> {
  return Promise.resolve(p).then(() => true);
}

const EXTENSION_COMMAND_HANDLERS = {
  'texra.showSettingsView': (actions) => awaitTrue(actions.showSettings()),
  'texra.showDashboard': (actions) => awaitTrue(actions.showSettings()),
  'texra.showMemory': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.MEMORY)),
  'texra.showAgentHistory': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.HISTORY)),
  'texra.showModels': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.MODELS)),
  'texra.showTools': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.TOOLS)),
  'texra.showMultiAgent': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.MULTI_AGENT)),
  'texra.openSettings': (actions) => awaitTrue(actions.openWorkbenchSettings()),
  'texra.mainView.reset': (actions) => awaitTrue(actions.resetMainView()),
  'texra.cleanOutput': (actions) => awaitTrue(actions.cleanOutput()),
  'texra.cleanBuild': (actions) => awaitTrue(actions.cleanBuild()),
  'texra.indentTeX': (actions) => awaitTrue(actions.indentTeX()),
  'texra.auth.signIn': (actions) => awaitTrue(actions.signIn()),
  'texra.auth.signOut': (actions) => awaitTrue(actions.signOut()),
  'texra.auth.viewProfile': (actions) => awaitTrue(actions.viewProfile()),
  'texra.runSetupAssistant': (actions) =>
    awaitTrue(actions.runSetupAssistant()),
  'texra.openGettingStarted': (actions) =>
    awaitTrue(actions.openGettingStarted()),
  'texra.createSampleProject': (actions) =>
    awaitTrue(actions.createSampleProject()),
  'texra.downloadArXivSource': (actions) =>
    awaitTrue(actions.downloadArXivSource()),
  'texra.testConnection': (actions) => awaitTrue(actions.testConnection()),
  'texra.testAgentLoading': (actions) => awaitTrue(actions.testAgentLoading()),
  'texra.loadSpecificAgent': (actions) =>
    awaitTrue(actions.loadSpecificAgent()),
  'texra.openProgressViewInTab': (actions) =>
    awaitTrue(actions.openProgressViewInTab()),
  'texra.openDoc': definedHandler(
    z.string(),
    (actions: ExtensionCommandActions, page) =>
      awaitTrue(actions.openDoc(page)),
  ),
  'texra.stopAgent': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) => {
      actions.stopAgent(streamId);
      return true;
    },
  ),
  'texra.compactResponse': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) =>
      awaitTrue(actions.compactResponse(streamId)),
  ),
  'texra.parseXml': (actions) => awaitTrue(actions.parseXml()),
  'texra.parseYaml': (actions) => awaitTrue(actions.parseYaml()),
  'texra.testTextEditor': (actions) => awaitTrue(actions.testTextEditor()),
  'texra.indentCurrentTeX': (actions) => awaitTrue(actions.indentCurrentTeX()),
  'texra.applyReplacements': (actions) =>
    awaitTrue(actions.applyReplacements()),
  'texra.fixCompilation': (actions) => awaitTrue(actions.fixCompilation()),
  'texra.getTeXCount': (actions) => awaitTrue(actions.getTeXCount()),
  'texra.countPdfPages': (actions) => awaitTrue(actions.countPdfPages()),
  'texra.showLinterMessages': (actions) =>
    awaitTrue(actions.showLinterMessages()),
  'texra.countLinterMessages': (actions) =>
    awaitTrue(actions.countLinterMessages()),
  'texra.extractFigurePaths': (actions) =>
    awaitTrue(actions.extractFigurePaths()),
  // Batch 3 (#3781) — image / PDF / TikZ / Overleaf entry points.
  'texra.encodeImageToBase64': (actions) =>
    awaitTrue(actions.encodeImageToBase64()),
  'texra.convertPdfToImages': (actions) =>
    awaitTrue(actions.convertPdfToImages()),
  'texra.extractTikzFigures': (actions) =>
    awaitTrue(actions.extractTikzFigures()),
  'texra.compileTikzFigures': (actions) =>
    awaitTrue(actions.compileTikzFigures()),
  'texra.cloneOverleafProject': (actions) =>
    awaitTrue(actions.cloneOverleafProject()),
  // Batch 4 (#3781).
  'texra.removeApiKey': (actions) => awaitTrue(actions.removeApiKey()),
  'texra.showImportOptions': (actions) =>
    awaitTrue(actions.showImportOptions()),
  'texra.toggleView': (actions) => awaitTrue(actions.toggleView()),
  'texra.showProgressView': definedHandler(
    ShowProgressViewArgSchema,
    (actions: ExtensionCommandActions, parsed) => {
      const inPlace =
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { inPlace?: unknown }).inPlace === true;
      return awaitTrue(actions.showProgressView(inPlace));
    },
  ),
  'texra.setApiKey': definedHandler(
    SetApiKeyArgSchema,
    (actions: ExtensionCommandActions, provider) =>
      awaitTrue(actions.setApiKey(provider)),
  ),
  'texra.createAgentWithAI': definedHandler(
    CreateAgentWithAIArgSchema,
    (actions: ExtensionCommandActions, category) =>
      awaitTrue(actions.createAgentWithAI(category ?? 'workflow')),
  ),
  'texra.execute': definedHandler(
    z.unknown(),
    (actions: ExtensionCommandActions, input) =>
      awaitTrue(actions.execute(input)),
  ),
} as const satisfies Record<
  Exclude<ExtensionRegistryCommandId, 'texra.showAgents'>,
  // The typed handlers (`openDoc`, `stopAgent`, `compactResponse`) carry
  // their own argument shapes via `definedHandler`. Matching the registry
  // map's per-entry TArgs widening (`any`) keeps inference per entry
  // without unifying every entry on `unknown`.
  CommandHandler<ExtensionCommandActions, any>
>;

// `texra.showAgents` accepts an optional `AgentCategory` argument from
// `executeCommand` callers, so it can't share the no-arg `CommandHandler`
// signature. It's still routed through the same actions interface — the
// only difference is that the VS Code registration forwards the argument.
//
// FOLLOW_UP: This bespoke parameterized map can be replaced with the
// `definedHandler` typed-args helper in `@shared/commands/registry` once
// the surrounding parameterized commands (pack/clean/compare/etc.) are
// migrated through that path. Keeping it as-is for now to minimize churn.
const EXTENSION_PARAMETERIZED_HANDLERS = {
  'texra.showAgents': (actions, subTab?: AgentCategory) =>
    actions.showSettings(SETTINGS_TAB.AGENTS, subTab),
} satisfies Record<
  Extract<ExtensionRegistryCommandId, 'texra.showAgents'>,
  (actions: ExtensionCommandActions, arg?: AgentCategory) => Promise<void>
>;

/**
 * Register every command in the shared registry against `vscode.commands`,
 * routing each invocation through `dispatchCommandFromRegistry` so the
 * dispatch path is identical to the desktop's. The registered callback
 * returns the dispatch result (a `boolean | Promise<boolean>`) so VS Code
 * forwards the underlying promise to `executeCommand` callers — async
 * rejections propagate instead of being swallowed (the bug fixed by
 * #3782).
 */
export function registerExtensionCommandRegistry(
  context: vscode.ExtensionContext,
  actions: ExtensionCommandActions,
): void {
  for (const id of Object.keys(EXTENSION_COMMAND_HANDLERS) as ReadonlyArray<
    keyof typeof EXTENSION_COMMAND_HANDLERS
  >) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (rawArg?: unknown) =>
        dispatchCommandFromRegistry(
          id,
          EXTENSION_COMMAND_HANDLERS,
          actions,
          (unhandledId) => {
            console.error(
              `[extension] dispatch: unhandled command ${unhandledId}`,
            );
          },
          rawArg,
        ),
      ),
    );
  }

  for (const id of Object.keys(
    EXTENSION_PARAMETERIZED_HANDLERS,
  ) as ReadonlyArray<keyof typeof EXTENSION_PARAMETERIZED_HANDLERS>) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (arg?: AgentCategory) =>
        EXTENSION_PARAMETERIZED_HANDLERS[id](actions, arg),
      ),
    );
  }
}
