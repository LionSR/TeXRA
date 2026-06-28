import * as vscode from 'vscode';

import {
  releaseRuntimeDeletedStream,
  releaseRuntimeDeletedStreams,
} from '@agent/runtime/streamResourceLifecycle';
import { isRuntimeStreamInFlight } from '@agent/runtime/streamControl';

import type { ProgressStreamLifecycleHost as ProgressStreamLifecycleHostPort } from '@controllers/progressView/ProgressStreamLifecycleController';
import type { ProgressViewProvider } from '../ProgressViewProvider';

type StreamTabId = import('@shared/schemas').StreamTabId;

interface ModelOutputBackupCleaner {
  clearStreamBackups(stream: StreamTabId): void;
  clearAllBackups(): void;
}

export class ProgressStreamLifecycleHost implements ProgressStreamLifecycleHostPort {
  constructor(
    private readonly provider: ProgressViewProvider,
    private readonly backupCleaner: ModelOutputBackupCleaner,
  ) {}

  getVisibleStreamIds(): StreamTabId[] {
    return this.provider.getVisibleStreamIds();
  }

  isStreamInFlight(stream: StreamTabId): boolean {
    return isRuntimeStreamInFlight(stream);
  }

  async stopStream(
    stream: StreamTabId,
    options: { clearRetryRequest?: boolean } = {},
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.stopAgent', {
      streamId: stream,
      clearRetryRequest: options.clearRetryRequest === true,
    });
  }

  async cleanupDeletedStream(stream: StreamTabId): Promise<void> {
    await releaseRuntimeDeletedStream({ streamId: stream });
    this.backupCleaner.clearStreamBackups(stream);
    this.provider.webviewBridge.clearStream(stream);
  }

  async cleanupDeletedStreams(streams: StreamTabId[]): Promise<void> {
    await releaseRuntimeDeletedStreams({
      streamIds: streams,
      approvalScope: 'process',
    });
    this.backupCleaner.clearAllBackups();
    this.provider.webviewBridge.clearAll();
  }

  deleteRenderedStream(stream: StreamTabId): void {
    this.provider.webviewUpdater.deleteStream(stream);
  }

  rebuildRenderedStreams(options: { forceRebuild: boolean }): void {
    this.provider.syncFullView(options);
  }

  async activateStream(stream: StreamTabId): Promise<void> {
    await this.provider.setActiveStream(stream);
  }
}
