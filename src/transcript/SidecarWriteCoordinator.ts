/**
 * Write-durability lane for the snapshot store's sidecars.
 *
 * Every ordinary sidecar write is serialized per (stream, category) through a
 * `Mutex` keyed by `${stream}::${key}`, tracked in `dirtyWrites` until it is
 * confirmed durable, and retried a bounded number of times by
 * `retryDirtyWrites` before remaining dirt is allowed to fail a flush.
 * Eviction safety is the other half: a write queued before
 * `evict()`/`deleteStream()` drops its chain key must not fire afterward and
 * resurrect the deleted `streamData/{id}/` directory.
 *
 * It reaches the rest of the store only through {@link SidecarWriteHost} —
 * the staged-deletion write buffer, the revocable stream-generation guard,
 * and the KV write itself stay owned by `StreamSnapshotStore` and its
 * `StagedDeletionCoordinator`.
 */

import { Mutex } from 'async-mutex';

import { createLog } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';

/** Logged under the store's channel: this is one of its internals. */
const log = createLog('StreamSnapshotStore');

/** Bound retries for writes that remain dirty. */
const MAX_DIRTY_WRITE_RETRIES = 3;

export class DirtySidecarWritesError extends Error {}

interface DirtySidecarWrite {
  stream: StreamTabId;
  key: string;
  value: unknown;
}

/**
 * The narrow port back into the snapshot store. Every member is a capability
 * the write-durability lane cannot own itself: the KV handle, the staged
 * deletion's transactional write buffer, and the store's revocable
 * stream-generation guard.
 */
export interface SidecarWriteHost {
  /** Persist one sidecar value through the store's KV handle. */
  kvWrite(stream: StreamTabId, key: string, value: unknown): Promise<void>;
  /**
   * Divert a write into the transactional buffer of an in-progress staging or
   * failed rollback (see `StagedDeletionCoordinator.bufferWrite`). Returns
   * `false` when no deletion owns the stream, leaving the write to the
   * ordinary path.
   */
  bufferWrite(stream: StreamTabId, key: string, value: unknown): boolean;
  /**
   * Hand a cancelled dirty write to whichever deletion owns the stream (see
   * `StagedDeletionCoordinator.captureDirtyWrite`).
   */
  captureDirtyWrite(stream: StreamTabId, key: string, value: unknown): void;
  /** The stream's current revocable generation identity. */
  streamGeneration(stream: StreamTabId): symbol;
  /** Whether `generation` is still the stream's live generation. */
  isCurrentGeneration(stream: StreamTabId, generation: symbol): boolean;
}

export class SidecarWriteCoordinator {
  // -- Per (stream, category) serialized write locks -------------------------
  private readonly writeMutexes = new Map<string, Mutex>();
  /** Latest ordinary sidecar value not yet confirmed durable, by write lock. */
  private readonly dirtyWrites = new Map<string, DirtySidecarWrite>();

  constructor(private readonly host: SidecarWriteHost) {}

  write(stream: StreamTabId, key: string, value: unknown): void {
    // A staged deletion owns the stream's namespace, so it takes the value
    // into its transactional buffer instead of letting it reach disk.
    if (this.host.bufferWrite(stream, key, value)) return;
    const chainKey = `${stream}::${key}`;
    const dirty = { stream, key, value } satisfies DirtySidecarWrite;
    this.dirtyWrites.set(chainKey, dirty);
    void this.persistDirtyWrite(chainKey, dirty).catch((err: unknown) =>
      log.warn(
        `Failed to persist ${key}.json for stream ${stream}; sidecar remains dirty.`,
        { data: err },
      ),
    );
  }

  private async persistDirtyWrite(
    chainKey: string,
    write: DirtySidecarWrite,
  ): Promise<void> {
    // A newer write or staged deletion can revoke this retry before it enters
    // the per-key queue. Only the current dirty owner may recreate that queue.
    if (this.dirtyWrites.get(chainKey) !== write) return;
    await this.queueWrite(write.stream, write.key, write.value);
    if (this.dirtyWrites.get(chainKey) === write) {
      this.dirtyWrites.delete(chainKey);
    }
  }

  /** Queue a sidecar write and expose its completion to transactional callers. */
  queueWrite(stream: StreamTabId, key: string, value: unknown): Promise<void> {
    const chainKey = `${stream}::${key}`;
    const generation = this.host.streamGeneration(stream);
    const mutex = this.writeMutexes.get(chainKey) ?? new Mutex();
    this.writeMutexes.set(chainKey, mutex);
    return mutex.runExclusive(() => {
      // Eviction guard: `evict()`/`deleteStream()` drop this chain key. A
      // write queued before that must NOT fire afterward, or a late `kv()`
      // would re-create the `streamData/{id}/` dir `deleteDir()` just removed.
      if (!this.writeMutexes.has(chainKey)) return;
      if (!this.host.isCurrentGeneration(stream, generation)) return;
      return this.host.kvWrite(stream, key, value);
    });
  }

  private writeBelongsToStream(
    chainKey: string,
    stream?: StreamTabId,
  ): boolean {
    return stream === undefined || chainKey.startsWith(`${stream}::`);
  }

  private async waitForWrites(stream?: StreamTabId): Promise<void> {
    await Promise.all(
      [...this.writeMutexes]
        .filter(([chainKey]) => this.writeBelongsToStream(chainKey, stream))
        .map(([, mutex]) => mutex.waitForUnlock()),
    );
  }

  cancelPendingWritesForStream(stream: StreamTabId): Promise<void>[] {
    const prefix = `${stream}::`;
    const pending: Promise<void>[] = [];
    for (const [key, mutex] of this.writeMutexes) {
      if (!key.startsWith(prefix)) continue;
      const dirty = this.dirtyWrites.get(key);
      // Hand the cancelled value to a staged deletion, which keeps it buffered
      // until the transaction settles. This loop is synchronous, so which
      // deletion (if any) owns the stream cannot change while it runs.
      if (dirty) this.host.captureDirtyWrite(stream, dirty.key, dirty.value);
      this.dirtyWrites.delete(key);
      pending.push(mutex.waitForUnlock());
      this.writeMutexes.delete(key);
    }
    return pending;
  }

  private dirtyWriteEntries(
    stream?: StreamTabId,
  ): [string, DirtySidecarWrite][] {
    return [...this.dirtyWrites].filter(([chainKey]) =>
      this.writeBelongsToStream(chainKey, stream),
    );
  }

  async retryDirtyWrites(stream?: StreamTabId): Promise<void> {
    await this.waitForWrites(stream);

    for (let attempt = 0; attempt < MAX_DIRTY_WRITE_RETRIES; attempt++) {
      const dirty = this.dirtyWriteEntries(stream);
      if (dirty.length === 0) return;
      await Promise.allSettled(
        dirty.map(([chainKey, write]) =>
          this.persistDirtyWrite(chainKey, write),
        ),
      );
    }

    const remaining = this.dirtyWriteEntries(stream).length;
    if (remaining > 0) {
      throw new DirtySidecarWritesError(
        `Sidecar writes remain dirty after ${MAX_DIRTY_WRITE_RETRIES} retries; ` +
          `${remaining} sidecar write(s) remain dirty.`,
      );
    }
  }

  /** Whether any sidecar write for `stream` is still unconfirmed. */
  hasDirtyWrites(stream: StreamTabId): boolean {
    return this.dirtyWriteEntries(stream).length > 0;
  }

  /** Drop a stream's write locks and dirty markers (the store owns its record). */
  dropStreamWrites(stream: StreamTabId): void {
    for (const key of [...this.writeMutexes.keys()]) {
      if (!key.startsWith(`${stream}::`)) continue;
      this.writeMutexes.delete(key);
      this.dirtyWrites.delete(key);
    }
  }
}
