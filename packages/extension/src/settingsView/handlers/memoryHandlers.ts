/**
 * Memory-settings domain handlers.
 *
 * Handles listing memory files, opening them (markdown in preview mode),
 * previewing a single entry, deleting, and pinning workspace memory from the
 * Settings view.
 */
import * as vscode from 'vscode';

import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { effectRuntime } from '@platform/processRuntime';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';

import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** Memory-settings handler delegate. */
export class MemoryHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly memory: SettingsMemoryController,
    private readonly viewName: string,
  ) {}

  async sendMemoryData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await effectRuntime().runPromise(this.memory.getMemoryDataMessage()),
    );
  }

  /**
   * Post one memory preview, or the preview's error placeholder when it
   * cannot be produced. Every outcome of the read-and-post — an unreadable
   * file, a rejected post — is reported and then answered with the
   * placeholder, so the view never waits on a preview that will not arrive.
   */
  async handleGetMemoryPreview(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW>,
  ): Promise<void> {
    await this.ctx.withActiveWebview(async (webview) => {
      try {
        await webview.postMessage(
          await effectRuntime().runPromise(
            this.memory.getMemoryPreviewMessage(data.storagePath),
          ),
        );
        return;
      } catch (error) {
        await showLoggedErrorMessage(
          this.ctx.channel,
          'Failed to load memory preview',
          error,
        );
      }
      await webview.postMessage(
        this.memory.getMemoryPreviewErrorMessage(data.storagePath),
      );
    });
  }

  async handleOpenMemoryFile(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to open memory file',
      async () => {
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
      },
    );
  }

  async handleOpenMemoryFolder(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to open memory folder',
      async () => {
        const resolvedPath = resolveMemoryStoragePath();
        await StorageFS.ensureDir(resolvedPath);
        const absolutePath = StorageFS.fullPath(resolvedPath);
        await safeExecuteCommand(
          'revealFileInOS',
          [vscode.Uri.file(absolutePath)],
          this.viewName,
        );
      },
    );
  }

  async handleDeleteMemory(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_MEMORY>,
  ): Promise<void> {
    try {
      const message = await effectRuntime().runPromise(
        this.memory.deleteMemory(data),
      );
      if (message != null) {
        await this.ctx.postMessageToActiveWebview(message);
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to delete memory',
        error,
      );
      await this.ctx.withActiveWebview((w) => this.sendMemoryData(w));
    }
  }

  async setMemoryPinned(storagePath: string, pinned: boolean): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      `Failed to ${pinned ? 'pin' : 'unpin'} memory`,
      async () => {
        const message = await effectRuntime().runPromise(
          this.memory.setMemoryPinned(storagePath, pinned),
        );
        if (message != null) {
          await this.ctx.postMessageToActiveWebview(message);
        }
      },
    );
  }
}
