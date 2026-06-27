import * as vscode from 'vscode';

import { clearRuntimeRetryRequest } from '@agent/runtime/runCoordinatorCommands';
import {
  cleanupRuntimeApprovalsForAllStreams,
  releaseRuntimeStreamResources,
} from '@agent/runtime/streamResourceLifecycle';
import {
  isRuntimeStreamInFlight,
  releaseQueuedFollowUpsForStreams,
} from '@agent/runtime/streamControl';
import { buildStreamInfos } from '@shared/progressView/backend/streamInfoUtils';

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
    return buildStreamInfos(
      this.provider.state,
      this.provider.state.agentCategoryFilter,
    ).map((stream) => stream.name);
  }

  isStreamInFlight(stream: StreamTabId): boolean {
    return isRuntimeStreamInFlight(stream);
  }

  async stopStream(
    stream: StreamTabId,
    options: { clearRetryRequest?: boolean } = {},
  ): Promise<void> {
    if (options.clearRetryRequest === true) {
      clearRuntimeRetryRequest({ streamId: stream });
    }
    await vscode.commands.executeCommand('texra.stopAgent', stream);
  }

  cleanupDeletedStream(stream: StreamTabId): void {
    releaseRuntimeStreamResources(stream);
    this.backupCleaner.clearStreamBackups(stream);
    this.provider.webviewBridge.clearStream(stream);
  }

  cleanupDeletedStreams(streams: StreamTabId[]): void {
    // Process-wide approval reset for the single-session extension host.
    cleanupRuntimeApprovalsForAllStreams();
    releaseQueuedFollowUpsForStreams(streams);
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
