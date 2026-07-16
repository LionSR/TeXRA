// Local imports - transcript
import { canUseStreamDataDir } from '@transcript/streamDataPaths';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';
import type { DeleteAllStreamsResult } from './backend/state/SessionStores';

export interface ProgressStreamLifecycleState {
  getActiveStream(): StreamTabId | '';
  setActiveStream(stream: StreamTabId | ''): void;
  hasStream(stream: StreamTabId): boolean;
  hasTaskState(stream: StreamTabId): boolean;
  getStreamIds(): StreamTabId[];
  pickValidActiveStream(availableStreams: StreamTabId[]): StreamTabId | '';
  waitForOwnedExecutionRelease(stream: StreamTabId): Promise<void>;
  clearStream(stream: StreamTabId): Promise<boolean>;
  clearAll(): Promise<DeleteAllStreamsResult>;
}

export interface ProgressStreamLifecycleControllerDeps {
  state: ProgressStreamLifecycleState;
  host: ProgressStreamLifecycleHost;
}

export interface ProgressStreamLifecycleHost {
  getVisibleStreamIds(): StreamTabId[];
  isStreamInFlight(stream: StreamTabId): boolean;
  isStreamOwnedLocally(stream: StreamTabId): boolean;
  stopStream(
    stream: StreamTabId,
    options?: { clearRetryRequest?: boolean },
  ): Promise<void>;
  cleanupDeletedStream(stream: StreamTabId): void;
  cleanupDeletedStreams(
    streams: StreamTabId[],
    options: { allDeleted: boolean },
  ): void;
  deleteRenderedStream(stream: StreamTabId): void;
  rebuildRenderedStreams(options: { forceRebuild: boolean }): void;
  activateStream(stream: StreamTabId): Promise<void>;
  notifyDeletionRetained(
    activeCount: number,
    failedCount?: number,
  ): Promise<void>;
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
      const deleted = await this.deps.state.clearStream(stream);
      if (!deleted) await this.deps.host.notifyDeletionRetained(1);
      return;
    }

    // Capture before any await: a synchronous caller-side stream switch after
    // invoking deleteStream belongs to the post-deletion state.
    const wasActive = this.deps.state.getActiveStream() === stream;
    const ownedLocally = this.deps.host.isStreamOwnedLocally(stream);
    if (ownedLocally && this.deps.host.isStreamInFlight(stream)) {
      // Finished streams should not get synthetic STOPPED transitions or child
      // interrupts after they completed naturally.
      await this.deps.host.stopStream(stream);
    }
    if (ownedLocally)
      await this.deps.state.waitForOwnedExecutionRelease(stream);

    const deleted = await this.deps.state.clearStream(stream);
    if (!deleted) {
      this.deps.host.rebuildRenderedStreams({ forceRebuild: true });
      await this.deps.host.notifyDeletionRetained(1);
      return;
    }
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

    const locallyOwnedStreams = streamIds.filter((stream) =>
      this.deps.host.isStreamOwnedLocally(stream),
    );
    await Promise.allSettled(
      locallyOwnedStreams.map((stream) =>
        this.deps.host.isStreamInFlight(stream)
          ? this.deps.host.stopStream(stream)
          : Promise.resolve(),
      ),
    );
    await Promise.all(
      locallyOwnedStreams.map((stream) =>
        this.deps.state.waitForOwnedExecutionRelease(stream),
      ),
    );

    const retained = await this.deps.state.clearAll();
    const retainedStreams = new Set([...retained.active, ...retained.failed]);
    const deleted = streamIds.filter((stream) => !retainedStreams.has(stream));
    this.deps.host.cleanupDeletedStreams(deleted, {
      allDeleted: retainedStreams.size === 0,
    });
    this.deps.host.rebuildRenderedStreams({ forceRebuild: true });
    if (retainedStreams.size > 0) {
      await this.deps.host.notifyDeletionRetained(
        retained.active.size,
        retained.failed.size,
      );
    }
  }
}
