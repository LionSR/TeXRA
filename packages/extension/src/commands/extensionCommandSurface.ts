// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  signIn as authSignIn,
  signOut as authSignOut,
  viewProfile as authViewProfile,
} from '@auth/authCommands';
import { handleIndentTeX } from '@commands/latex/latexCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { getMainWebview } from '@frontend/system/commandUtils';
import { runCleanBuild, runCleanOutput } from '@housekeeping';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import {
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
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
}

export function createExtensionCommandActions(
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
} as const satisfies Record<
  Exclude<ExtensionRegistryCommandId, 'texra.showAgents'>,
  CommandHandler<ExtensionCommandActions>
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
      vscode.commands.registerCommand(id, () => {
        dispatchCommandFromRegistry(
          id,
          EXTENSION_COMMAND_HANDLERS,
          actions,
          (unhandledId) => {
            console.error(
              `[extension] dispatch: unhandled command ${unhandledId}`,
            );
          },
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
