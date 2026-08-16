import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { AgentConfig } from '@agent/runtime';
import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import type { ChatExportController } from '@controllers/settingsView/ChatExportController';
import {
  HistoryActions,
  type HistoryActionPorts,
} from '@controllers/settingsView/backend/HistoryActions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewInboundHandlerRegistry } from '@shared/schemas';
import type { AdjacentStreamStores } from '@transcript/adjacentStreamCleanup';

type DesktopHistoryHandlerRegistry = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.RERUN_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.RESTORE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY
  | typeof SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD
  | typeof SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX
  | typeof SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML
>;

export interface DesktopHistoryOptions {
  readonly resourcesPath: string;
  readonly runExecution: (request: ValidatedExecutionRequest) => Promise<void>;
  readonly restoreRunConfig: (config: AgentConfig) => Promise<boolean>;
  readonly postToRenderer: (message: unknown) => void;
  readonly openPath: (filePath: string) => Promise<void>;
  readonly showInfoMessage: (message: string) => Promise<void>;
  readonly confirmAction: (
    message: string,
    confirmLabel: string,
  ) => Promise<boolean>;
  readonly showWarningMessage: (message: string) => Promise<void>;
  readonly showErrorMessage: (message: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
  /** The desktop main process's live session's transcript/snapshot pair —
   *  see `HistoryActionPorts.getLiveStreamStores`. Desktop's process session
   *  is never registered as `defaultSession()`, so this must be threaded in
   *  explicitly rather than reached for via that global accessor. */
  readonly getLiveStreamStores: () => AdjacentStreamStores | undefined;
}

export interface DesktopHistorySettingsController {
  readonly handlers: DesktopHistoryHandlerRegistry;
  postHistoryData(): Promise<void>;
}

/** Desktop ports and dispatcher bindings for shared history actions. */
export class DesktopHistoryHandlers implements DesktopHistorySettingsController {
  readonly handlers: DesktopHistoryHandlerRegistry;
  private readonly actions: HistoryActions;
  private chatExportControllerLoad: Promise<ChatExportController> | undefined;

  constructor(private readonly dependencies: DesktopHistoryOptions) {
    const ports: HistoryActionPorts = {
      getChatExportController: () => this.getChatExportController(),
      traceViewerTemplate: path.join(
        dependencies.resourcesPath,
        'traceViewer',
        'index.html',
      ),
      runExecution: dependencies.runExecution,
      restoreRunConfig: dependencies.restoreRunConfig,
      postMessage: dependencies.postToRenderer,
      openPath: (filePath) => dependencies.openPath(filePath),
      showInfo: dependencies.showInfoMessage,
      showWarning: dependencies.showWarningMessage,
      showError: dependencies.showErrorMessage,
      confirm: dependencies.confirmAction,
      reportDetail: (message) => dependencies.onError(new Error(message)),
      getLiveStreamStores: dependencies.getLiveStreamStores,
    };
    this.actions = new HistoryActions(ports);
    this.handlers = {
      deleteAgent: ({ historyId }) => this.actions.deleteItem(historyId),
      clearHistory: () => this.actions.clear(),
      rerunAgent: ({ historyId }) => this.actions.rerun(historyId),
      restoreAgent: ({ historyId }) => this.actions.restore(historyId),
      exportChatMd: ({ historyId }) => this.actions.exportChat(historyId, 'md'),
      exportChatTex: ({ historyId }) =>
        this.actions.exportChat(historyId, 'tex'),
      exportChatHtml: ({ historyId }) =>
        this.actions.exportChat(historyId, 'html'),
    };
  }

  postHistoryData(): Promise<void> {
    return this.actions.postHistoryData();
  }

  private getChatExportController(): Promise<ChatExportController> {
    this.chatExportControllerLoad ??=
      import('@controllers/settingsView/ChatExportController')
        .then(
          ({ ChatExportController }) =>
            new ChatExportController({
              latexPreamble: readFileSync(
                path.join(
                  this.dependencies.resourcesPath,
                  'templates',
                  'chatExport.tex',
                ),
                'utf8',
              ),
            }),
        )
        .catch((error: unknown) => {
          this.chatExportControllerLoad = undefined;
          throw error;
        });
    return this.chatExportControllerLoad;
  }
}
