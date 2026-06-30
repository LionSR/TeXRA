import * as vscode from 'vscode';

import type { RunCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { isInFlightStatus } from '@common/constants/streamStatus';
import type { StreamTabId } from '@shared/schemas';
import { buildStreamInfos } from '@shared/progressView/backend/streamInfoUtils';
import { cleanupAllApprovals, releaseStreamResources } from '@tools/approval';

import type { ProgressStreamLifecycleHost as ProgressStreamLifecycleHostPort } from '@controllers/progressView/ProgressStreamLifecycleController';
import type { ProgressViewProvider } from '../ProgressViewProvider';

type ProgressRetryCoordinator = Pick<RunCoordinatorBridge, 'clearRetryRequest'>;

interface ModelOutputBackupCleaner {
  clearStreamBackups(stream: StreamTabId): void;
  clearAllBackups(): void;
}

export class ProgressStreamLifecycleHost implements ProgressStreamLifecycleHostPort {
  constructor(
    private readonly provider: ProgressViewProvider,
    private readonly backupCleaner: ModelOutputBackupCleaner,
    private readonly coordinators: ProgressRetryCoordinator,
  ) {}

  getVisibleStreamIds(): StreamTabId[] {
    return buildStreamInfos(
      this.provider.state,
      this.provider.state.agentCategoryFilter,
    ).map((stream) => stream.name);
  }

  isStreamInFlight(stream: StreamTabId): boolean {
    return isInFlightStatus(StreamStatusService.get(stream));
  }

  async stopStream(
    stream: StreamTabId,
    options: { clearRetryRequest?: boolean } = {},
  ): Promise<void> {
    if (options.clearRetryRequest === true) {
      this.coordinators.clearRetryRequest(stream);
    }
    await vscode.commands.executeCommand('texra.stopAgent', stream);
  }

  cleanupDeletedStream(stream: StreamTabId): void {
    releaseStreamResources(stream);
    this.backupCleaner.clearStreamBackups(stream);
    this.provider.webviewBridge.clearStream(stream);
  }

  cleanupDeletedStreams(streams: StreamTabId[]): void {
    // Process-wide approval reset for the single-session extension host.
    // ToolUseFollowUpQueue has no bulk-release method, so queues are released
    // per stream after the approval sweep.
    cleanupAllApprovals();
    for (const stream of streams) {
      ToolUseFollowUpQueue.release(stream);
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
