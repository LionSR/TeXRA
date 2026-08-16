import { randomUUID } from 'node:crypto';

import { LRUCache } from 'lru-cache';
import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { KeyedMutex } from '@utils/core/keyedMutex';
import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';
import { FollowUpQueue, type FollowUpQueueInput } from './FollowUpQueue';

const logger = createLog('ToolUseFollowUpQueue');

type QueueLifecycle = 'live' | 'recoverable' | 'recovering';
export type FollowUpConsumerKind = 'flow' | 'child' | 'recovery';

interface QueueEntry {
  readonly queue: FollowUpQueue;
  /** Stable identity of this continuation generation across recovery claims. */
  generationId: string;
  /** True until persisted flow state or a resumed flow confirms the identity. */
  generationProvisional: boolean;
  /**
   * Delivery ids already admitted for this stream (#9531). In-memory,
   * transport-level replay suppression only — NOT crash-safe exactly-once: a
   * restart (or LRU eviction past the cap) forgets admitted ids, so a replay
   * after that is admitted again. An outbox/idempotent parent inbox is
   * deferred until crash/restart tests reproduce duplicate or lost insertion.
   */
  readonly admittedDeliveryIds: BoundedIdSet<string>;
  lifecycle: QueueLifecycle;
  generation: number;
  owner?: FollowUpConsumerLease;
}

/**
 * Exclusive authority to consume one stream's follow-up queue.
 *
 * The manager issues at most one lease per entry. Claims and releases are
 * synchronous, and every lease carries the entry generation it claimed. A
 * release from an older flow/child therefore cannot clear or terminalize a
 * successor recovery generation. Only the lease may wait, drain, or dispose;
 * producers submit through the manager and cannot manufacture a consumer.
 */
export interface FollowUpConsumerLease {
  readonly streamId: StreamTabId;
  readonly generation: number;
  /** Opaque identity of this session-owned queue generation. */
  readonly generationId: string;
  readonly kind: FollowUpConsumerKind;
}

export interface FollowUpRecoveryLease
  extends FollowUpConsumerLease, RecoveryContinuation {
  readonly kind: 'recovery';
}

export type FollowUpSubmission =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not_owned' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'live' }
  | { readonly kind: 'live_flow' }
  | { readonly kind: 'recovering' }
  | { readonly kind: 'recovery'; readonly lease: FollowUpRecoveryLease };

/**
 * Session-owned continuation boundary indexed by stream ID.
 *
 * Lifecycle is explicit: an owned entry is `live` or `recovering`, an unowned
 * persisted cursor is `recoverable`, and terminal stream ids are retained in a
 * bounded tombstone cache. Delivery and ordinary live claims cannot reopen a
 * terminal entry; a newly authorized child run may begin a new generation.
 */
export class ToolUseFollowUpQueue {
  static readonly TERMINAL_CAP = 500;
  static readonly DELIVERY_ID_CAP = 1000;
  private readonly entries = new Map<StreamTabId, QueueEntry>();
  private readonly submissionMutex = new KeyedMutex<StreamTabId>();
  private readonly terminal = new LRUCache<StreamTabId, true>({
    max: ToolUseFollowUpQueue.TERMINAL_CAP,
  });
  private readonly releaseObservers = new Set<
    (streamId: StreamTabId) => void
  >();
  private disposed = false;

  onRelease(observer: (streamId: StreamTabId) => void): () => void {
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  /** Serialize routing and admission for one stream within this session. */
  runSubmissionExclusive<Result>(
    streamId: StreamTabId,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.submissionMutex.runExclusive(streamId, operation);
  }

  /** Claim a live flow/child consumer. A competing owner is rejected. */
  claimLive(
    streamId: StreamTabId,
    kind: Exclude<FollowUpConsumerKind, 'recovery'>,
    generationId?: string,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    if (this.terminal.has(streamId)) return undefined;
    const entry =
      this.entries.get(streamId) ?? this.createEntry(streamId, generationId);
    if (generationId !== undefined && entry.generationId !== generationId) {
      return undefined;
    }
    return this.claim(entry, streamId, kind);
  }

  /**
   * Restore a generation read from the stream's authoritative flow record.
   * Distinguishes session dispose from terminal/mismatch rejection so callers
   * can label diagnostics accurately.
   */
  restorePersistedGeneration(
    streamId: StreamTabId,
    generationId: string,
  ): 'restored' | 'disposed' | 'unavailable' {
    if (this.disposed) return 'disposed';
    if (this.terminal.has(streamId)) return 'unavailable';
    const entry = this.entries.get(streamId);
    if (entry) {
      if (entry.generationId === generationId) {
        entry.generationProvisional = false;
        return 'restored';
      }
      if (!entry.generationProvisional) return 'unavailable';
      entry.generationId = generationId;
      entry.generationProvisional = false;
      return 'restored';
    }
    this.createEntry(streamId, generationId);
    return 'restored';
  }

  /**
   * Begin a separately authorized child run, replacing a terminal generation
   * when the deterministic child stream ID is reused. The caller must already
   * own the execution lease; producers and ordinary live flows cannot cross
   * this boundary, so late delivery remains rejected.
   */
  claimChildRun(
    streamId: StreamTabId,
    executionId: ExecutionId,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    if (!streamId.endsWith(`#${executionId}`)) {
      throw new Error(
        `Child stream ${streamId} does not belong to execution ${executionId}.`,
      );
    }
    const retained = this.entries.get(streamId);
    if (retained) return this.claim(retained, streamId, 'child');

    this.terminal.delete(streamId);
    return this.claim(this.createEntry(streamId), streamId, 'child');
  }

  /** Claim persisted recovery before any asynchronous resume preparation. */
  claimRecovery(
    streamId: StreamTabId,
    createIfMissing = false,
  ): FollowUpRecoveryLease | undefined {
    if (this.disposed) return undefined;
    if (this.terminal.has(streamId)) return undefined;
    const entry =
      this.entries.get(streamId) ??
      (createIfMissing
        ? this.createEntry(streamId, undefined, true)
        : undefined);
    if (!entry || entry.lifecycle !== 'recoverable' || entry.owner) {
      return undefined;
    }
    return this.claim(entry, streamId, 'recovery') as FollowUpRecoveryLease;
  }

  useRecovery(
    recovery: RecoveryContinuation,
  ): FollowUpRecoveryLease | undefined {
    const entry = this.entries.get(recovery.streamId);
    return entry?.owner === recovery && recovery.kind === 'recovery'
      ? (entry.owner as FollowUpRecoveryLease)
      : undefined;
  }

  /**
   * Submit through the queue's ownership boundary. `live_owner` joins a live
   * flow or child consumer, or enqueues without claiming when the entry has no
   * live owner (so live notifications can reach a WAITING parent queue).
   * `recoverable` admits a registry-approved persisted cursor and creates its
   * queue when needed. `existing_recoverable` admits only an already-retained
   * recoverable queue, which lets a final child result survive child untracking
   * without reopening an otherwise terminal parent.
   */
  submit(
    streamId: StreamTabId,
    followUp: FollowUpQueueInput,
    admission: 'live_owner' | 'recoverable' | 'existing_recoverable',
    expectedGenerationId?: string,
  ): FollowUpSubmission {
    if (this.disposed) return { kind: 'unavailable' };
    if (this.terminal.has(streamId)) return { kind: 'unavailable' };

    let entry = this.entries.get(streamId);
    if (
      expectedGenerationId !== undefined &&
      entry?.generationId !== expectedGenerationId
    ) {
      return { kind: 'unavailable' };
    }
    if (admission === 'live_owner') {
      if (!entry) return { kind: 'not_owned' };
    } else {
      if (!entry && admission === 'existing_recoverable') {
        return { kind: 'unavailable' };
      }
      entry ??= this.createEntry(streamId, undefined, true);
      if (!entry.owner) entry.lifecycle = 'recoverable';
    }

    // Replay suppression is synchronous check-and-add: concurrent submissions
    // of one delivery id admit at most once (#9531). Ids are minted by the
    // child-run loop per accepted turn; identical text under a distinct id is
    // a distinct delivery.
    const deliveryId = followUp.deliveryId;
    if (deliveryId !== undefined) {
      if (entry.admittedDeliveryIds.has(deliveryId)) {
        return { kind: 'duplicate' };
      }
      entry.admittedDeliveryIds.add(deliveryId);
    }

    entry.queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    const owner = entry.owner;
    if (owner?.kind === 'flow') return { kind: 'live_flow' };
    if (owner?.kind === 'child') return { kind: 'live' };
    if (owner?.kind === 'recovery') return { kind: 'recovering' };

    if (admission === 'live_owner') {
      // Live notifications use this path to reach WAITING parents whose
      // retained queue will be consumed when the stream resumes.
      return { kind: 'queued' };
    }

    const lease = this.claim(entry, streamId, 'recovery');
    if (!lease) return { kind: 'recovering' };
    return { kind: 'recovery', lease: lease as FollowUpRecoveryLease };
  }

  /** Read-only lifecycle probe used by diagnostics and teardown assertions. */
  hasLiveOwner(streamId: StreamTabId): boolean {
    const owner = this.entries.get(streamId)?.owner;
    return owner?.kind === 'flow' || owner?.kind === 'child';
  }

  /**
   * Inner child/recovery flows borrow the queue their outer owner consumes.
   * A recovery created before persisted state was read has a provisional
   * generation; the resumed flow is the authority that rebinds it. Child
   * ownership is already authoritative and must match exactly.
   */
  externallyOwnedQueue(
    streamId: StreamTabId,
    generationId: string,
  ): FollowUpQueue | undefined {
    const entry = this.entries.get(streamId);
    const owner = entry?.owner;
    if (!entry || (owner?.kind !== 'child' && owner?.kind !== 'recovery')) {
      return undefined;
    }
    if (entry.generationId !== generationId) {
      if (owner.kind !== 'recovery' || !entry.generationProvisional) {
        return undefined;
      }
      entry.generationId = generationId;
    }
    entry.generationProvisional = false;
    return entry.queue;
  }

  queue(lease: FollowUpConsumerLease): FollowUpQueue {
    return this.requireOwner(lease).queue;
  }

  /**
   * Release only the generation represented by `lease`. `recoverable` keeps
   * queued data for a successor claim; `terminal` disposes it permanently.
   */
  release(
    lease: FollowUpConsumerLease,
    next: 'recoverable' | 'terminal',
  ): boolean {
    const entry = this.entries.get(lease.streamId);
    if (
      !entry ||
      entry.owner !== lease ||
      entry.generation !== lease.generation
    ) {
      return false;
    }
    entry.owner = undefined;
    if (next === 'recoverable') {
      entry.lifecycle = 'recoverable';
      return true;
    }
    entry.queue.dispose();
    this.entries.delete(lease.streamId);
    this.terminal.set(lease.streamId, true);
    logger.debug(`Terminalized follow-up queue for stream ${lease.streamId}.`);
    this.notifyReleaseObservers(lease.streamId);
    return true;
  }

  /** Terminalize a stream; any outstanding lease becomes stale immediately. */
  terminalize(streamId: StreamTabId): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(streamId);
    entry?.queue.dispose();
    this.entries.delete(streamId);
    this.terminal.set(streamId, true);
    this.notifyReleaseObservers(streamId);
    return true;
  }

  /**
   * Dispose the session-owned boundary: every live entry queue, then the
   * entry map, terminal tombstones, and release observers. The state clears
   * in a `finally` so one queue's disposal failure cannot leave the map,
   * tombstones, or observers behind. Entry-creating paths refuse to rebuild
   * afterwards, so a late detached producer cannot leak a queue nobody will
   * drain.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      for (const entry of this.entries.values()) {
        entry.queue.dispose();
      }
    } finally {
      this.entries.clear();
      this.terminal.clear();
      this.releaseObservers.clear();
    }
  }

  private notifyReleaseObservers(streamId: StreamTabId): void {
    for (const observer of this.releaseObservers) {
      try {
        observer(streamId);
      } catch (err) {
        logger.warn(`Release observer threw for stream ${streamId}`, {
          data: err,
        });
      }
    }
  }

  /** Presentation-only snapshot; does not grant consumption rights. */
  getAll(streamId: StreamTabId): string[] {
    return this.entries.get(streamId)?.queue.getAll() ?? [];
  }

  /** Generation fence for detached producers bound to the current stream. */
  currentGenerationId(streamId: StreamTabId): string | undefined {
    return this.entries.get(streamId)?.generationId;
  }

  /** Generation authority supplied by an outer child loop to its inner flow. */
  currentChildGenerationId(streamId: StreamTabId): string | undefined {
    const entry = this.entries.get(streamId);
    return entry?.owner?.kind === 'child' ? entry.generationId : undefined;
  }

  private createEntry(
    streamId: StreamTabId,
    generationId: string = randomUUID(),
    generationProvisional = false,
  ): QueueEntry {
    const entry: QueueEntry = {
      queue: new FollowUpQueue(),
      generationId,
      generationProvisional,
      admittedDeliveryIds: createBoundedIdSet(
        ToolUseFollowUpQueue.DELIVERY_ID_CAP,
      ),
      lifecycle: 'recoverable',
      generation: 0,
    };
    this.entries.set(streamId, entry);
    return entry;
  }

  private claim(
    entry: QueueEntry,
    streamId: StreamTabId,
    kind: FollowUpConsumerKind,
  ): FollowUpConsumerLease | undefined {
    if (entry.owner) return undefined;
    entry.generation += 1;
    const lease: FollowUpConsumerLease = {
      streamId,
      generation: entry.generation,
      get generationId() {
        return entry.generationId;
      },
      kind,
    };
    entry.owner = lease;
    entry.lifecycle = kind === 'recovery' ? 'recovering' : 'live';
    return lease;
  }

  private requireOwner(lease: FollowUpConsumerLease): QueueEntry {
    const entry = this.entries.get(lease.streamId);
    if (
      !entry ||
      entry.owner !== lease ||
      entry.generation !== lease.generation
    ) {
      throw new Error(
        `Follow-up consumer lease is stale for stream ${lease.streamId}.`,
      );
    }
    return entry;
  }
}
