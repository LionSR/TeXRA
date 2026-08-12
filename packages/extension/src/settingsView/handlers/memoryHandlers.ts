/**
 * Memory-settings domain handlers.
 *
 * Handles listing memory files, opening them (markdown in preview mode),
 * previewing a single entry, deleting, enabling, and pinning workspace
 * memory from the Settings view.
 */
import * as vscode from 'vscode';

import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';

import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/** Memory-settings handler delegate. */
export class MemoryHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly settingsHost: SettingsViewHost,
    private readonly viewName: string,
  ) {}

  async sendMemoryData(webview: vscode.Webview): Promise<void> {
    await this.settingsHost.sendMemoryData((message) =>
      webview.postMessage(message),
    );
  }

  async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    await this.settingsHost.sendMemoryEnabled((message) =>
      webview.postMessage(message),
    );
  }

  async handleGetMemoryPreview(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW>,
  ): Promise<void> {
    await this.ctx.withActiveWebview(async (webview) => {
      await this.settingsHost.sendMemoryPreview(data, {
        respond: (message) => webview.postMessage(message),
        onError: async (error) => {
          await showLoggedErrorMessage(
            this.ctx.channel,
            'Failed to load memory preview',
            error,
          );
        },
      });
    });
  }

  async handleOpenMemoryFile(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Open markdown files in preview mode (read-only rendered view)
      if (hasExtension(absolutePath, '.md')) {
        await safeExecuteCommand(
          'markdown.showPreview',
          [fileUri],
          this.viewName,
        );
      } else {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to open memory file',
        error,
      );
    }
  }

  async handleOpenMemoryFolder(): Promise<void> {
    try {
      const resolvedPath = resolveMemoryStoragePath();
      await StorageFS.ensureDir(resolvedPath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
      await safeExecuteCommand(
        'revealFileInOS',
        [vscode.Uri.file(absolutePath)],
        this.viewName,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to open memory folder',
        error,
      );
    }
  }

  async handleDeleteMemory(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_MEMORY>,
  ): Promise<void> {
    try {
      await this.settingsHost.deleteMemory(data, (message) =>
        this.postMessageToActiveWebview(message),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to delete memory',
        error,
      );
      await this.ctx.withActiveWebview((w) => this.sendMemoryData(w));
    }
  }

  async handleSetMemoryEnabled(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    await this.settingsHost.setMemoryEnabled(data.enabled, (message) =>
      this.postMessageToActiveWebview(message),
    );
  }

  async setMemoryPinned(storagePath: string, pinned: boolean): Promise<void> {
    try {
      await this.settingsHost.setMemoryPinned(storagePath, pinned, (message) =>
        this.postMessageToActiveWebview(message),
      );
    } catch (error) {
      const action = pinned ? 'pin' : 'unpin';
      await showLoggedErrorMessage(
        this.ctx.channel,
        `Failed to ${action} memory`,
        error,
      );
    }
  }

  private async postMessageToActiveWebview(message: unknown): Promise<void> {
    if (message == null) return;
    await this.ctx.withActiveWebview(async (webview) => {
      await webview.postMessage(message);
    });
  }
}
