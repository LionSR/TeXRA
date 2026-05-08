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
} from '@commands/agent';
import { downloadArXivSource as latexDownloadArXivSource } from '@commands/latex';
import { runSetupAssistant as setupRunAssistant } from '@commands/setup';
import {
  createSampleProject as sysCreateSampleProject,
  handleTestConnection as sysHandleTestConnection,
  handleTestAgentLoading as sysHandleTestAgentLoading,
  handleLoadSpecificAgent as sysHandleLoadSpecificAgent,
} from '@commands/system';
import {
  handleIndentTeX,
  handleIndentCurrentTeX as latexIndentCurrentTeX,
  handleApplyReplacements as latexApplyReplacements,
  handleFixCompilation as latexFixCompilation,
  handleGetTeXCount as latexGetTeXCount,
} from '@commands/latex/latexCommands';
import { handleCountPdfPages as latexCountPdfPages } from '@commands/latex/imageCommands';
import {
  handleShowLinterMessages as latexShowLinterMessages,
  handleCountLinterMessages as latexCountLinterMessages,
} from '@commands/latex/linterCommands';
import { handleExtractFigurePaths as latexExtractFigurePaths } from '@commands/latex/figCommands';
import { openProgressViewInTab as progressOpenInTab } from '@commands/progress/progressViewCommands';
import { openDoc as sysOpenDoc } from '@commands/system/helpCommands';
import { openGettingStarted as sysOpenGettingStarted } from '@commands/system/walkthroughCommands';
import { handleParseXml as sysParseXml } from '@commands/system/xmlCommands';
import { handleParseYaml as sysParseYaml } from '@commands/system/yamlCommands';
import { handleTestTextEditor as sysTestTextEditor } from '@commands/system/textEditorCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
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
import { type AgentCategory } from '@shared/schemas/agent';
import { SETTINGS_QUERY } from '@utils/config';

import type { CommandId } from './catalog';

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
>;

/**
 * Capabilities the registry handlers need from the extension host. Mirrors
 * `DesktopCommandActions` in shape — both register parallel handler maps
 * over the same `CommandId` union with their host-specific actions.
 */
export interface ExtensionCommandActions {
  showSettings(tabIndex?: SettingsTab, agentSubTab?: AgentCategory): void;
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
}

export function createExtensionCommandActions(
  context: vscode.ExtensionContext,
  settingsViewProvider: SettingsViewProvider,
): ExtensionCommandActions {
  return {
    showSettings(tabIndex, agentSubTab) {
      void settingsViewProvider.showSettingsView(tabIndex, agentSubTab);
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
  };
}

const EXTENSION_COMMAND_HANDLERS = {
  'texra.showSettingsView': (actions) => {
    actions.showSettings();
    return true;
  },
  'texra.showDashboard': (actions) => {
    actions.showSettings();
    return true;
  },
  'texra.showMemory': (actions) => {
    actions.showSettings(SETTINGS_TAB.MEMORY);
    return true;
  },
  'texra.showAgentHistory': (actions) => {
    actions.showSettings(SETTINGS_TAB.HISTORY);
    return true;
  },
  'texra.showModels': (actions) => {
    actions.showSettings(SETTINGS_TAB.MODELS);
    return true;
  },
  'texra.showTools': (actions) => {
    actions.showSettings(SETTINGS_TAB.TOOLS);
    return true;
  },
  'texra.showMultiAgent': (actions) => {
    actions.showSettings(SETTINGS_TAB.MULTI_AGENT);
    return true;
  },
  'texra.openSettings': (actions) => {
    void actions.openWorkbenchSettings();
    return true;
  },
  'texra.mainView.reset': (actions) => {
    void actions.resetMainView();
    return true;
  },
  'texra.cleanOutput': (actions) => {
    void actions.cleanOutput();
    return true;
  },
  'texra.cleanBuild': (actions) => {
    void actions.cleanBuild();
    return true;
  },
  'texra.indentTeX': (actions) => {
    void actions.indentTeX();
    return true;
  },
  'texra.auth.signIn': (actions) => {
    void actions.signIn();
    return true;
  },
  'texra.auth.signOut': (actions) => {
    void actions.signOut();
    return true;
  },
  'texra.auth.viewProfile': (actions) => {
    void actions.viewProfile();
    return true;
  },
  'texra.runSetupAssistant': (actions) => {
    void actions.runSetupAssistant();
    return true;
  },
  'texra.openGettingStarted': (actions) => {
    void actions.openGettingStarted();
    return true;
  },
  'texra.createSampleProject': (actions) => {
    void actions.createSampleProject();
    return true;
  },
  'texra.downloadArXivSource': (actions) => {
    void actions.downloadArXivSource();
    return true;
  },
  'texra.testConnection': (actions) => {
    void actions.testConnection();
    return true;
  },
  'texra.testAgentLoading': (actions) => {
    void actions.testAgentLoading();
    return true;
  },
  'texra.loadSpecificAgent': (actions) => {
    void actions.loadSpecificAgent();
    return true;
  },
  'texra.openProgressViewInTab': (actions) => {
    void actions.openProgressViewInTab();
    return true;
  },
  'texra.openDoc': definedHandler(
    z.string(),
    (actions: ExtensionCommandActions, page) => {
      void actions.openDoc(page);
      return true;
    },
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
    (actions: ExtensionCommandActions, streamId) => {
      void actions.compactResponse(streamId);
      return true;
    },
  ),
  'texra.parseXml': (actions) => {
    void actions.parseXml();
    return true;
  },
  'texra.parseYaml': (actions) => {
    void actions.parseYaml();
    return true;
  },
  'texra.testTextEditor': (actions) => {
    void actions.testTextEditor();
    return true;
  },
  'texra.indentCurrentTeX': (actions) => {
    void actions.indentCurrentTeX();
    return true;
  },
  'texra.applyReplacements': (actions) => {
    void actions.applyReplacements();
    return true;
  },
  'texra.fixCompilation': (actions) => {
    void actions.fixCompilation();
    return true;
  },
  'texra.getTeXCount': (actions) => {
    void actions.getTeXCount();
    return true;
  },
  'texra.countPdfPages': (actions) => {
    void actions.countPdfPages();
    return true;
  },
  'texra.showLinterMessages': (actions) => {
    void actions.showLinterMessages();
    return true;
  },
  'texra.countLinterMessages': (actions) => {
    void actions.countLinterMessages();
    return true;
  },
  'texra.extractFigurePaths': (actions) => {
    void actions.extractFigurePaths();
    return true;
  },
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
  'texra.showAgents': (actions, subTab?: AgentCategory) => {
    actions.showSettings(SETTINGS_TAB.AGENTS, subTab);
  },
} satisfies Record<
  Extract<ExtensionRegistryCommandId, 'texra.showAgents'>,
  (actions: ExtensionCommandActions, arg?: AgentCategory) => void
>;

/**
 * Register every command in the shared registry against `vscode.commands`,
 * routing each invocation through `dispatchCommandFromRegistry` so the
 * dispatch path is identical to the desktop's.
 */
export function registerExtensionCommandRegistry(
  context: vscode.ExtensionContext,
  actions: ExtensionCommandActions,
): void {
  for (const id of Object.keys(EXTENSION_COMMAND_HANDLERS) as ReadonlyArray<
    keyof typeof EXTENSION_COMMAND_HANDLERS
  >) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (rawArg?: unknown) => {
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
        );
      }),
    );
  }

  for (const id of Object.keys(
    EXTENSION_PARAMETERIZED_HANDLERS,
  ) as ReadonlyArray<keyof typeof EXTENSION_PARAMETERIZED_HANDLERS>) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (arg?: AgentCategory) => {
        EXTENSION_PARAMETERIZED_HANDLERS[id](actions, arg);
      }),
    );
  }
}
