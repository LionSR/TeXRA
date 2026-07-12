import * as vscode from 'vscode';

import { buildStreamInfos } from '@controllers/progressView/backend/streamInfoUtils';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { isInFlightPhase } from '@common/constants/streamStatus';
import type { StreamTabId } from '@shared/schemas';
import { cleanupAllApprovals, releaseStreamResources } from '@tools/approval';

import type { ProgressStreamLifecycleHost as ProgressStreamLifecycleHostPort } from '@controllers/progressView/ProgressStreamLifecycleController';
import type { ProgressViewProvider } from '../ProgressViewProvider';

interface ModelOutputBackupCleaner {
  clearStreamBackups(stream: StreamTabId): void;
  clearAllBackups(): void;
}

export class ProgressStreamLifecycleHost implements ProgressStreamLifecycleHostPort {
  constructor(
    private readonly provider: ProgressViewProvider,
    private readonly backupCleaner: ModelOutputBackupCleaner,
    private readonly interactions: HostInteractions,
  ) {}

  getVisibleStreamIds(): StreamTabId[] {
    return buildStreamInfos(
      this.provider.state,
      this.provider.state.agentCategoryFilter,
    ).map((stream) => stream.name);
  }

  isStreamInFlight(stream: StreamTabId): boolean {
    return isInFlightPhase(defaultSession().status.get(stream));
  }

  async stopStream(
    stream: StreamTabId,
    options: { clearRetryRequest?: boolean } = {},
  ): Promise<void> {
    if (options.clearRetryRequest === true) {
      // Kind-scoped: clear only the pending retry panel. Other pending
      // interactions on the stream (plan approvals, proposals, questions)
      // belong to the run being stopped and settle through their own paths.
      this.interactions.cancel({
        streamId: stream,
        kind: 'retry',
        cause: 'Retry request cleared.',
      });
    }
    await vscode.commands.executeCommand('texra.stopAgent', stream);
  }

  cleanupDeletedStream(stream: StreamTabId): void {
    releaseStreamResources(stream);
    this.backupCleaner.clearStreamBackups(stream);
    this.provider.webviewBridge.clearStream(stream);
  }

  cleanupDeletedStreams(streams: StreamTabId[]): void {
    // Default-session approval reset for the single-session extension host.
    // Follow-up queues are released per stream after the approval sweep
    // through the same helper used by single-stream deletes.
    cleanupAllApprovals();
    for (const stream of streams) {
      releaseStreamResources(stream);
    }
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
