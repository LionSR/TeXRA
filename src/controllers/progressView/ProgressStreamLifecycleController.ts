// Local imports - transcript
import { canUseStreamDataDir } from '@transcript/streamDataPaths';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

export interface ProgressStreamLifecycleState {
  getActiveStream(): StreamTabId | '';
  setActiveStream(stream: StreamTabId | ''): void;
  hasStream(stream: StreamTabId): boolean;
  hasTaskState(stream: StreamTabId): boolean;
  getStreamIds(): StreamTabId[];
  pickValidActiveStream(availableStreams: StreamTabId[]): StreamTabId | '';
  clearStream(stream: StreamTabId): Promise<boolean>;
  clearAll(): Promise<ReadonlySet<StreamTabId>>;
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
    if (!canUseStreamDataDir(stream)) return;

    const hasStream =
      this.deps.state.hasStream(stream) || this.deps.state.hasTaskState(stream);
    if (!hasStream) {
      await this.deps.state.clearStream(stream);
      return;
    }

    if (this.deps.host.isStreamInFlight(stream)) {
      // Finished streams should not get synthetic STOPPED transitions or child
      // interrupts after they completed naturally.
      await this.deps.host.stopStream(stream);
    }

    // The wasActive snapshot must happen before the first await: callers may
    // switch streams synchronously after invoking deleteStream, and that
    // switch belongs to the post-deletion state, not this snapshot.
    const wasActive = this.deps.state.getActiveStream() === stream;
    const deleted = await this.deps.state.clearStream(stream);
    if (!deleted) return;
    this.deps.host.cleanupDeletedStream(stream);

    let shouldActivateStream = false;
    const activeAfterClear = this.deps.state.getActiveStream();
    const visibleStreams = this.deps.host.getVisibleStreamIds();
    const hasVisibleActive =
      activeAfterClear !== '' && visibleStreams.includes(activeAfterClear);
    if (activeAfterClear === stream || (wasActive && !hasVisibleActive)) {
      const nextActive =
        visibleStreams.length === 0
          ? ''
          : this.deps.state.pickValidActiveStream(visibleStreams);
      this.deps.state.setActiveStream(nextActive);
      shouldActivateStream = nextActive !== '';
    } else if (wasActive && hasVisibleActive) {
      shouldActivateStream = true;
    }

    this.deps.host.deleteRenderedStream(stream);

    const nextActive = this.deps.state.getActiveStream();
    if (shouldActivateStream && nextActive) {
      await this.deps.host.activateStream(nextActive);
    }
  }

  async deleteAllStreams(): Promise<void> {
    const streamIds = this.deps.state.getStreamIds();

    await Promise.allSettled(
      streamIds.map((stream) => this.deps.host.stopStream(stream)),
    );

    const retained = await this.deps.state.clearAll();
    const deleted = streamIds.filter((stream) => !retained.has(stream));
    this.deps.host.cleanupDeletedStreams(deleted);
    this.deps.host.rebuildRenderedStreams({ forceRebuild: true });
  }
}
