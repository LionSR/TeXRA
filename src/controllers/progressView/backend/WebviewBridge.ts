import { createLog } from '@logger/logUtils';
import { getRuntimeModelLabel } from '@model/runtimeModelRegistry';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  WorkflowCallProgressSchema,
  type ProgressViewOutboundMessage,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { StreamLogDeltaBuffer } from '@transcript/StreamLog';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { createFlushableDebounce, type FlushableDebounce } from '@utils/core';

const log = createLog('WebviewBridge');

const FRAME_INTERVAL_MS = 16;

/**
 * Webview-facing copy of one transcript entry. The stream-log store keeps the
 * canonical `WorkflowCallProgress.model` id; only the copy that crosses the
 * `postMessage` boundary projects it through the runtime model registry. This
 * mirrors `formatCliWorkflowCallLine` while keeping `@model/runtimeModelRegistry`
 * out of the browser frontend import graph.
 */
function projectWorkflowCallEntry(entry: StreamLogEntry): StreamLogEntry {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType !== MESSAGE_TYPES.WORKFLOW_TASK
  ) {
    return entry;
  }
  const call = WorkflowCallProgressSchema.safeParse(entry.data);
  if (!call.success) return entry;
  if (!('model' in call.data) || call.data.model === undefined) return entry;
  const model = getRuntimeModelLabel(call.data.model);
  if (model === call.data.model) return entry;
  return { ...entry, data: { ...call.data, model } };
}

export type ProgressViewMessageSender = (
  message: ProgressViewOutboundMessage,
) => boolean | PromiseLike<boolean>;

type ProgressLogStore = Pick<StreamLogStore, 'onChange' | 'get'>;

/**
 * Per-stream feed state, created by `syncStream`. `buffer` folds the store's
 * multicast deltas between flushes; `undefined` routes the next flush through
 * the from-scratch resync (registration, reconnect, failed delivery).
 */
interface StreamEntry {
  buffer: StreamLogDeltaBuffer | undefined;
  dirty: boolean;
}

/**
 * Mirrors the active stream's transcript to the progress webview by folding
 * the store's `StreamLogDelta` feed into `LOG_DELTA` wire frames. The feed is
 * multicast and nothing is acked store-side; delivery guarantees toward the
 * webview come from the explicit resync handshake instead — consumer
 * registration (`syncStream`), a detected emission gap, and any failed
 * `postMessage` all replay `getRange(0)` from scratch, the same oracle path
 * a from-scratch projection uses.
 */
export class WebviewBridge {
  private readonly flushDebounce: FlushableDebounce;
  /** Registered streams: presence means the webview knows the stream exists. */
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
    this.unsubscribe = this.store.onChange((streamId, delta) => {
      if (streamId !== this.getActiveStream()) return;
      // A stream is mirrored to the webview only after `syncStream` registers
      // it. That call is the registration handshake, run once the webview
      // knows the stream exists. A run appends its earliest entries (the
      // "Init" stage and files-loaded logs) during launch, before that
      // handshake; streaming them here would post a LOG_DELTA the frontend
      // drops (no streamState yet). Until then deltas are ignored and
      // `syncStream`'s from-scratch replay covers the whole log.
      const entry = this.streams.get(streamId);
      if (!entry) return;
      // No buffer while a resync is pending: the resync replays the whole
      // log, so buffering earlier deltas would only double-apply them.
      entry.buffer?.push(delta);
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
    this.streams.set(streamId, { buffer: undefined, dirty: true });
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

    let payload: ProgressViewOutboundMessage;
    if (!entry.buffer || entry.buffer.resyncRequired) {
      // Resync from scratch through the oracle path. The replacement buffer
      // is based at the emission head read in the same synchronous snapshot
      // as `getRange(0)`, so deltas emitted during the async delivery below
      // fold on top of exactly this frame.
      const entries = log.getRange(0).map(projectWorkflowCallEntry);
      entry.buffer = new StreamLogDeltaBuffer(log.emissionHead);
      if (entries.length === 0) {
        entry.dirty = false;
        return true;
      }
      payload = {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId: activeStream,
        entries,
        updates: [],
        textDeltas: [],
      };
    } else {
      const { appended, dirtied, textChunks } = entry.buffer.drain();
      if (
        appended.length === 0 &&
        dirtied.length === 0 &&
        textChunks.length === 0
      ) {
        entry.dirty = false;
        return true;
      }
      payload = {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId: activeStream,
        entries: appended.map(projectWorkflowCallEntry),
        updates: dirtied.map(projectWorkflowCallEntry),
        textDeltas: textChunks,
      };
    }

    if (!(await this.deliver(payload))) {
      // The frame is gone and nothing store-side retains it: route the next
      // flush through the from-scratch resync so the webview cannot stay
      // stale. `dirty` remains set; the next store delta (or `syncStream`)
      // triggers the retry.
      entry.buffer = undefined;
      return false;
    }
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
      log.debug('Failed to deliver message to webview', {
        data: error,
      });
      return false;
    }
  }
}
