import * as logger from '@logger/logUtils';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ProgressViewOutboundMessage,
  StreamTabId,
} from '@shared/schemas';
import type { StreamLog } from '@transcript/StreamLog';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { createFlushableDebounce, type FlushableDebounce } from '@utils/core';

const CHANNEL = 'WebviewBridge';

const FRAME_INTERVAL_MS = 16;

export type ProgressViewMessageSender = (
  message: ProgressViewOutboundMessage,
) => boolean | PromiseLike<boolean>;

type ProgressLogSource = Pick<
  StreamLog,
  | 'head'
  | 'getRange'
  | 'getDirtyUpdates'
  | 'getDirtyTextDeltas'
  | 'ackDirtyUpdates'
  | 'ackDirtyTextDeltas'
>;

type ProgressLogStore = Pick<
  StreamLogStore,
  'onChange' | 'get' | 'clearDirtyUpdates'
>;

/** Per-stream cursor and pending-flush state, created by `syncStream`. */
interface StreamEntry {
  cursor: number;
  dirty: boolean;
}

export class WebviewBridge {
  private readonly flushDebounce: FlushableDebounce;
  /** Registered streams: presence means cursor is seeded; `dirty` means pending flush. */
  private readonly streams = new Map<StreamTabId, StreamEntry>();
  private readonly unsubscribe: () => void;
  private flushInProgress = false;
  private flushRequested = false;

  constructor(
    private readonly store: ProgressLogStore,
    private readonly sendMessage: ProgressViewMessageSender,
    private readonly getActiveStream: () => StreamTabId | null,
  ) {
    this.flushDebounce = createFlushableDebounce(
      () => void this.runFlush(),
      FRAME_INTERVAL_MS,
    );
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
      const entry = this.streams.get(streamId);
      if (!entry) return;
      entry.dirty = true;
      this.scheduleFlush();
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.flushDebounce.cancel();
    this.streams.clear();
  }

  syncStream(streamId: StreamTabId): void {
    this.streams.set(streamId, { cursor: 0, dirty: true });
    this.store.clearDirtyUpdates(streamId);
    this.scheduleFlush();
  }

  clearStream(streamId: StreamTabId): void {
    this.streams.delete(streamId);
  }

  clearAll(): void {
    this.streams.clear();
  }

  private scheduleFlush(): void {
    if (this.flushInProgress) {
      this.flushRequested = true;
      return;
    }
    if (!this.flushDebounce.pending) this.flushDebounce.schedule();
  }

  private async runFlush(): Promise<void> {
    if (this.flushInProgress) {
      this.flushRequested = true;
      return;
    }
    this.flushInProgress = true;
    const delivered = await this.flush();
    this.flushInProgress = false;
    const reflush = delivered && this.flushRequested;
    this.flushRequested = false;
    if (reflush) this.scheduleFlush();
  }

  private async flush(): Promise<boolean> {
    const activeStream = this.getActiveStream();
    if (!activeStream) return true;
    const entry = this.streams.get(activeStream);
    if (!entry?.dirty) return true;

    const log = this.store.get(activeStream);
    if (!log) {
      entry.dirty = false;
      return true;
    }

    const { cursor } = entry;
    const nextCursor = log.head;
    const entries = log.getRange(cursor, nextCursor);
    const updates = log.getDirtyUpdates(cursor);
    const textDeltas = log.getDirtyTextDeltas(cursor);

    if (
      entries.length === 0 &&
      updates.length === 0 &&
      textDeltas.length === 0
    ) {
      entry.dirty = false;
      return true;
    }

    const payload = {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries,
      updates,
      textDeltas,
    } as const;

    if (!(await this.deliver(payload))) return false;

    log.ackDirtyUpdates(updates);
    log.ackDirtyTextDeltas(textDeltas, entries);
    entry.cursor = nextCursor;
    entry.dirty = this.flushRequested;
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
