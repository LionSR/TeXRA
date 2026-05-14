import * as vscode from 'vscode';

import { clearRetryRequest } from '@agent/runtime/runCoordinators';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { isInFlightStatus } from '@common/constants/streamStatus';
import {
  cleanupAllApprovals,
  cleanupApprovalsForStream,
} from '@tools/approval';

import { buildStreamInfos } from '../streamInfoUtils';
import type { ProgressStreamLifecycleHost as ProgressStreamLifecycleHostPort } from '@controllers/progressView/ProgressStreamLifecycleController';
import type { ProgressViewProvider } from '../ProgressViewProvider';

type StreamTabId = import('@shared/schemas').StreamTabId;
type ModelOutputBackups = Map<
  StreamTabId,
  Map<string, { content: string; streamId: StreamTabId }>
>;

export class ProgressStreamLifecycleHost
  implements ProgressStreamLifecycleHostPort
{
  constructor(
    private readonly provider: ProgressViewProvider,
    private readonly modelOutputBackups: ModelOutputBackups,
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
      clearRetryRequest(stream);
    }
    await vscode.commands.executeCommand('texra.stopAgent', stream);
  }

  cleanupDeletedStream(stream: StreamTabId): void {
    cleanupApprovalsForStream(stream);
    ToolUseFollowUpQueue.release(stream);
    this.modelOutputBackups.delete(stream);
    this.provider.webviewBridge.clearStream(stream);
  }

  cleanupDeletedStreams(streams: StreamTabId[]): void {
    cleanupAllApprovals();
    for (const stream of streams) {
      ToolUseFollowUpQueue.release(stream);
    }
    this.modelOutputBackups.clear();
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
