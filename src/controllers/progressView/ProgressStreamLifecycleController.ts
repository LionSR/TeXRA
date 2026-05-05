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
  host: ProgressStreamLifecycleHost;
}

export interface ProgressStreamLifecycleHost {
  getVisibleStreamIds(): StreamTabId[];
  isStreamInFlight(stream: StreamTabId): boolean;
  stopStream(
    stream: StreamTabId,
    options?: { clearRetryRequest?: boolean },
  ): Promise<void>;
  cleanupDeletedStream(stream: StreamTabId): void;
  cleanupDeletedStreams(streams: StreamTabId[]): void;
  deleteRenderedStream(stream: StreamTabId): void;
  rebuildRenderedStreams(options: { forceRebuild: boolean }): void;
  activateStream(stream: StreamTabId): Promise<void>;
}

export class ProgressStreamLifecycleController {
  constructor(private readonly deps: ProgressStreamLifecycleControllerDeps) {}

  async stopStream(stream: StreamTabId): Promise<void> {
    await this.deps.host.stopStream(stream, { clearRetryRequest: true });
  }

  async deleteStream(stream: StreamTabId): Promise<void> {
    const hasStream =
      this.deps.state.hasStream(stream) || this.deps.state.hasTaskState(stream);
    if (!hasStream) return;

    if (this.deps.host.isStreamInFlight(stream)) {
      // Finished streams should not get synthetic STOPPED transitions or child
      // interrupts after they completed naturally.
      await this.deps.host.stopStream(stream);
    }

    this.deps.host.cleanupDeletedStream(stream);

    const wasActive = this.deps.state.getActiveStream() === stream;
    await this.deps.state.clearStream(stream);

    const shouldSelectFallback =
      wasActive && this.deps.state.getActiveStream() === stream;
    if (shouldSelectFallback) {
      this.deps.state.setActiveStream(
        this.deps.state.pickValidActiveStream(
          this.deps.host.getVisibleStreamIds(),
        ),
      );
    }

    this.deps.host.deleteRenderedStream(stream);

    const nextActive = this.deps.state.getActiveStream();
    if (shouldSelectFallback && nextActive) {
      await this.deps.host.activateStream(nextActive);
    }
  }

  async deleteAllStreams(): Promise<void> {
    const streamIds = this.deps.state.getStreamIds();

    await Promise.allSettled(
      streamIds.map((stream) => this.deps.host.stopStream(stream)),
    );

    this.deps.host.cleanupDeletedStreams(streamIds);
    await this.deps.state.clearAll();
    this.deps.host.rebuildRenderedStreams({ forceRebuild: true });
  }
}
