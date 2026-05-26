import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import type { StreamTabId } from '@shared/schemas';
import type { StreamLogStore } from '@transcript';
import type * as vscode from 'vscode';

const FRAME_INTERVAL_MS = 16;

export class WebviewBridge {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changedStreams = new Set<StreamTabId>();
  private readonly cursors = new Map<StreamTabId, number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: StreamLogStore,
    private readonly getWebviews: () => (vscode.Webview | undefined)[],
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
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FRAME_INTERVAL_MS);
  }

  private flush(): void {
    const activeStream = this.getActiveStream();
    if (!activeStream) return;
    if (!this.changedStreams.has(activeStream)) return;

    const webviews = this.getWebviews().filter((wv): wv is vscode.Webview =>
      Boolean(wv),
    );
    if (webviews.length === 0) return;

    const log = this.store.get(activeStream);
    if (!log) {
      this.changedStreams.delete(activeStream);
      return;
    }

    // `changedStreams` is a subset of `cursors`: onChange only enqueues a
    // stream whose cursor is already seeded (the `syncStream` handshake), and
    // syncStream seeds it before enqueuing. Thus a stream present here has a
    // cursor here. The `?? 0` is therefore unreachable, kept only to satisfy
    // the type.
    const cursor = this.cursors.get(activeStream) ?? 0;
    const entries = log.getRange(cursor, log.head);
    const updates = log.drainDirtyUpdates(cursor);

    if (entries.length === 0 && updates.length === 0) {
      this.changedStreams.delete(activeStream);
      return;
    }

    const payload = {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries,
      updates,
    } as const;

    for (const webview of webviews) {
      webview.postMessage(payload);
    }

    this.cursors.set(activeStream, log.head);
    this.changedStreams.delete(activeStream);
  }
}
