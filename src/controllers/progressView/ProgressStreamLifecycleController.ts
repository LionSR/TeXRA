// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

export interface ProgressStreamLifecycleState {
  getActiveStream(): StreamTabId | '';
  setActiveStream(stream: StreamTabId | ''): void;
  hasStream(stream: StreamTabId): boolean;
  hasTaskState(stream: StreamTabId): boolean;
  getStreamIds(): StreamTabId[];
  pickValidActiveStream(availableStreams: StreamTabId[]): StreamTabId | '';
  clearStream(stream: StreamTabId): Promise<void>;
  clearAll(): Promise<void>;
}

export interface ProgressStreamLifecycleControllerDeps {
  state: ProgressStreamLifecycleState;
  isStreamInFlight(stream: StreamTabId): boolean;
  getVisibleStreamIds(): StreamTabId[];
  stopStream(stream: StreamTabId): Promise<void>;
  clearRetryRequest(stream: StreamTabId): void;
  releaseFollowUpQueue(stream: StreamTabId): void;
  cleanupApprovalsForStream(stream: StreamTabId): void;
  cleanupAllApprovals(): void;
  clearModelOutputBackups(stream?: StreamTabId): void;
  clearWebviewStream(stream: StreamTabId): void;
  clearAllWebviewStreams(): void;
  deleteWebviewStream(stream: StreamTabId): void;
  syncFullView(options: { forceRebuild: boolean }): void;
  setActiveStream(stream: StreamTabId): Promise<void>;
}

export class ProgressStreamLifecycleController {
  constructor(private readonly deps: ProgressStreamLifecycleControllerDeps) {}

  async stopStream(stream: StreamTabId): Promise<void> {
    // Clear pending retry requests so the UI panel is dismissed with the stop.
    this.deps.clearRetryRequest(stream);
    await this.deps.stopStream(stream);
  }

  async deleteStream(stream: StreamTabId): Promise<void> {
    const hasStream =
      this.deps.state.hasStream(stream) || this.deps.state.hasTaskState(stream);
    if (!hasStream) return;

    if (this.deps.isStreamInFlight(stream)) {
      // Finished streams should not get synthetic STOPPED transitions or child
      // interrupts after they completed naturally.
      await this.deps.stopStream(stream);
    }

    this.deps.cleanupApprovalsForStream(stream);
    this.deps.clearRetryRequest(stream);
    this.deps.releaseFollowUpQueue(stream);
    this.deps.clearModelOutputBackups(stream);
    this.deps.clearWebviewStream(stream);

    const wasActive = this.deps.state.getActiveStream() === stream;
    await this.deps.state.clearStream(stream);

    if (wasActive) {
      this.deps.state.setActiveStream(
        this.deps.state.pickValidActiveStream(this.deps.getVisibleStreamIds()),
      );
    }

    this.deps.deleteWebviewStream(stream);

    const nextActive = this.deps.state.getActiveStream();
    if (wasActive && nextActive) {
      await this.deps.setActiveStream(nextActive);
    }
  }

  async deleteAllStreams(): Promise<void> {
    const streamIds = this.deps.state.getStreamIds();

    await Promise.allSettled(
      streamIds.map((stream) => this.deps.stopStream(stream)),
    );

    this.deps.cleanupAllApprovals();
    for (const stream of streamIds) {
      this.deps.clearRetryRequest(stream);
      this.deps.releaseFollowUpQueue(stream);
    }
    this.deps.clearModelOutputBackups();
    this.deps.clearAllWebviewStreams();
    await this.deps.state.clearAll();
    this.deps.syncFullView({ forceRebuild: true });
  }
}
