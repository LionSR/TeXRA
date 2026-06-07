import * as logger from '@logger/logUtils';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ProgressViewOutboundMessage,
  StreamLogEntry,
  StreamTabId,
} from '@shared/schemas';

const CHANNEL = 'WebviewBridge';

const FRAME_INTERVAL_MS = 16;

export type ProgressViewMessageSender = (
  message: ProgressViewOutboundMessage,
) => boolean | PromiseLike<boolean>;

export interface ProgressLogSource {
  readonly head: number;
  getRange(fromSeq: number, toSeq: number): StreamLogEntry[];
  getDirtyUpdates(maxSeqInclusive: number): StreamLogEntry[];
  ackDirtyUpdates(updates: readonly StreamLogEntry[]): void;
}

export interface ProgressLogStore {
  onChange(listener: (streamId: StreamTabId) => void): () => void;
  get(streamId: StreamTabId): ProgressLogSource | undefined;
  clearDirtyUpdates(streamId: StreamTabId): void;
}

export class WebviewBridge {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changedStreams = new Set<StreamTabId>();
  private readonly cursors = new Map<StreamTabId, number>();
  private readonly unsubscribe: () => void;
  private flushInProgress = false;
  private flushRequested = false;

  constructor(
    private readonly store: ProgressLogStore,
    private readonly sendMessage: ProgressViewMessageSender,
    private readonly getActiveStream: () => StreamTabId | null,
  ) {
    this.unsubscribe = this.store.onChange((streamId) => {
      if (streamId !== this.getActiveStream()) return;
      // A stream is mirrored to the webview only after `syncStream` seeds its
      // cursor. That call is the registration handshake, run once the webview
      // knows the stream exists. A run appends its earliest entries (the "Init"
      // stage and files-loaded logs) during launch, before that handshake;
      // streaming them here would post a LOG_DELTA the frontend drops (no
      // streamState yet) while this bridge advances its cursor past them,
      // losing them until a manual reload. Until then the on-disk log is
      // authoritative and `syncStream` replays it in full.
      if (!this.cursors.has(streamId)) return;
      this.changedStreams.add(streamId);
      this.scheduleFlush();
    });
  }

  dispose(): void {
    this.unsubscribe();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.changedStreams.clear();
    this.cursors.clear();
  }

  syncStream(streamId: StreamTabId): void {
    this.cursors.set(streamId, 0);
    this.store.clearDirtyUpdates(streamId);
    this.changedStreams.add(streamId);
    this.scheduleFlush();
  }

  clearStream(streamId: StreamTabId): void {
    this.changedStreams.delete(streamId);
    this.cursors.delete(streamId);
  }

  clearAll(): void {
    this.changedStreams.clear();
    this.cursors.clear();
  }

  private scheduleFlush(): void {
    if (this.flushInProgress) {
      this.flushRequested = true;
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.runFlush();
    }, FRAME_INTERVAL_MS);
  }

  private async runFlush(): Promise<void> {
    if (this.flushInProgress) {
      this.flushRequested = true;
      return;
    }
    this.flushInProgress = true;
    const delivered = await this.flush();
    this.flushInProgress = false;
    if (delivered && this.flushRequested) {
      this.flushRequested = false;
      this.scheduleFlush();
    } else if (!delivered) {
      this.flushRequested = false;
    }
  }

  private async flush(): Promise<boolean> {
    const activeStream = this.getActiveStream();
    if (!activeStream) return true;
    if (!this.changedStreams.has(activeStream)) return true;

    const log = this.store.get(activeStream);
    if (!log) {
      this.changedStreams.delete(activeStream);
      return true;
    }

    // `changedStreams` is a subset of `cursors`: onChange only enqueues a
    // stream whose cursor is already seeded (the `syncStream` handshake), and
    // syncStream seeds it before enqueuing. Thus a stream present here has a
    // cursor here. The `?? 0` is therefore unreachable, kept only to satisfy
    // the type.
    const cursor = this.cursors.get(activeStream) ?? 0;
    const nextCursor = log.head;
    const entries = log.getRange(cursor, nextCursor);
    const updates = log.getDirtyUpdates(cursor);

    if (entries.length === 0 && updates.length === 0) {
      this.changedStreams.delete(activeStream);
      return true;
    }

    const payload = {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries,
      updates,
    } as const;

    if (!(await this.deliver(payload))) return false;

    log.ackDirtyUpdates(updates);
    this.cursors.set(activeStream, nextCursor);
    if (this.flushRequested) {
      this.changedStreams.add(activeStream);
    } else {
      this.changedStreams.delete(activeStream);
    }
    return true;
  }

  private async deliver(
    message: ProgressViewOutboundMessage,
  ): Promise<boolean> {
    try {
      return await this.sendMessage(message);
    } catch (error) {
      // Webview may be disposed/unreachable; drop the frame and retry next flush.
      logger.debug(CHANNEL, 'Failed to deliver message to webview', {
        data: error,
      });
      return false;
    }
  }
}
