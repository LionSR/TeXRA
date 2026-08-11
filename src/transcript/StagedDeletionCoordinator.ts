/**
 * Crash-safe staged deletion and rollback recovery for a stream's sidecar
 * directory.
 *
 * Deleting `streamData/{id}/` is a two-phase transaction: the live directory
 * is renamed into the deletion namespace (`stageDeleteStream`), and the
 * transcript registry then decides whether that rename commits (delete the
 * staged copy) or rolls back (rename it home again). A crash, a failed rename,
 * or a failed rollback can leave either namespace holding the only copy, so
 * this coordinator owns the whole state machine:
 *
 * - `deletionStates` is the per-stream authority for WHICH namespace currently
 *   holds the data (`phase`) and for the sidecar writes buffered behind the
 *   rename (`writes`). While a stream has a state here, the store's ordinary
 *   write path is diverted into that buffer instead of touching disk, which is
 *   what makes the rename a real transaction boundary: commit discards the
 *   buffer, rollback replays it only after the live namespace is restored.
 * - `reconcile()` is the startup sweep over `streamDataDeletion/` left behind
 *   by a crash, and `recoverPendingRollbacks()` the same repair driven from
 *   `flush()`.
 *
 * It reaches the snapshot store only through {@link StagedDeletionHost} — the
 * store keeps ownership of records, KV handles, write mutexes, and stream
 * versions, and this coordinator never inspects them.
 */

// Third-party imports
import pDefer from 'p-defer';
import pMap from 'p-map';

// Local imports - shared infrastructure
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';

// Local imports - transcript
import {
  canUseStreamDataDir,
  decodeStreamId,
  STREAM_DATA_DELETION_DIR,
  STREAM_DATA_DIR,
  stagedStreamDataDir,
  streamDataDir,
} from './streamDataPaths';

/** Logged under the store's channel: this is one of its internals. */
const CHANNEL = 'StreamSnapshotStore';

/** Bounded fan-out for reconciling many streams' staged directories, so a
 *  crash-recovery sweep does not open a file handle per stream. */
const DELETION_IO_CONCURRENCY = 8;

async function storagePathExists(target: string): Promise<boolean> {
  try {
    await StorageFS.stat(target);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

export interface StagedStreamSnapshotDeletion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * The narrow port back into the snapshot store. Every member is a capability
 * the staged-deletion machine cannot own itself: durable writes, the store's
 * per-(stream, category) write locks, its stream-version guard, its cached KV
 * handles, its seeding chain, and its in-memory record.
 */
export interface StagedDeletionHost {
  /** Persist one sidecar through the store's serialized write queue. */
  queueWrite(stream: StreamTabId, key: string, value: unknown): Promise<void>;
  /**
   * Drop the stream's pending write locks, handing any dirty value to
   * {@link StagedDeletionCoordinator.captureDirtyWrite}, and return the
   * promises that settle when the cancelled writes have drained.
   */
  cancelPendingWrites(stream: StreamTabId): Promise<void>[];
  /** Invalidate writes queued against the pre-staging directory. */
  bumpStreamVersion(stream: StreamTabId): void;
  /** The stream's in-flight seed/refresh chain, if one is running. */
  seedChain(stream: StreamTabId): Promise<void> | undefined;
  /** Drop cached KV handles after a rename moved the stream's directory. */
  invalidateKvHandles(stream: StreamTabId): void;
  /** Drop the stream's in-memory record once a deletion commits. */
  evict(stream: StreamTabId): void;
}

type StagedDeletionPhase = 'live' | 'transitioning' | 'staged' | 'unavailable';
type StagedRecoveryOutcome = 'discarded' | 'restored' | 'unchanged';

interface DeletionStateBase {
  writes: Map<string, unknown>;
  /** Namespace authority and whether failed ownership may mirror writes. */
  phase: StagedDeletionPhase;
}

interface StagedDeletionState extends DeletionStateBase {
  kind: 'staging';
  settled: Promise<void>;
  resolveSettled: () => void;
}

interface IdleRollbackState extends DeletionStateBase {
  kind: 'rollback-idle';
}

interface RecoveringRollbackState extends DeletionStateBase {
  kind: 'rollback-recovering';
  /** Owns namespace repair and buffered-write replay. */
  recovery: Promise<StagedRecoveryOutcome>;
}

type RollbackState = IdleRollbackState | RecoveringRollbackState;
type DeletionState = StagedDeletionState | RollbackState;

export class StagedDeletionCoordinator {
  /**
   * Writes arriving while a stream's live directory is reversibly staged.
   * Keeping the latest value per sidecar makes the staging rename a real
   * transaction boundary: commit discards them, rollback replays them only
   * after the live namespace has been restored.
   */
  private readonly deletionStates = new Map<StreamTabId, DeletionState>();

  constructor(private readonly host: StagedDeletionHost) {}

  /**
   * Divert a sidecar write into the buffer of an in-progress staging or failed
   * rollback. Returns `false` when no deletion owns the stream, leaving the
   * write to the store's ordinary path.
   */
  bufferWrite(stream: StreamTabId, key: string, value: unknown): boolean {
    const deletionState = this.deletionStates.get(stream);
    if (!deletionState) return false;

    deletionState.writes.set(key, value);
    if (
      deletionState.kind === 'rollback-idle' &&
      deletionState.phase === 'live'
    ) {
      void this.host
        .queueWrite(stream, key, value)
        .then(() => {
          const current = this.deletionStates.get(stream);
          if (
            current?.writes === deletionState.writes &&
            deletionState.writes.get(key) === value
          ) {
            deletionState.writes.delete(key);
            if (current.kind === 'rollback-idle') {
              this.releaseDeletionOwnership(stream, current);
            }
          }
        })
        .catch((err: unknown) =>
          logger.warn(
            CHANNEL,
            `Failed to persist ${key}.json for stream ${stream}; sidecar remains buffered.`,
            { data: err },
          ),
        );
    }
    return true;
  }

  /**
   * Hand a cancelled dirty write to whichever deletion owns the stream. Writes
   * buffered after staging began are newer than every dirty write sampled by
   * the cancelling sweep, so they retain ownership of the staged value.
   */
  captureDirtyWrite(stream: StreamTabId, key: string, value: unknown): void {
    const deletionState = this.deletionStates.get(stream);
    if (deletionState && !deletionState.writes.has(key)) {
      deletionState.writes.set(key, value);
    }
  }

  /** Drop every deletion state, settling anyone awaiting a staged transaction. */
  reset(): void {
    for (const state of this.deletionStates.values()) {
      if (state.kind === 'staging') state.resolveSettled();
    }
    this.deletionStates.clear();
  }

  /**
   * Repair every stream left in a failed rollback, returning the failures so
   * the store's `flush()` can report them alongside its own.
   */
  async recoverPendingRollbacks(): Promise<unknown[]> {
    const recoveries = await pMap(
      [...this.deletionStates],
      async ([stream, state]) => {
        try {
          if (state.kind !== 'staging') {
            await this.recoverFailedRollback(stream, state);
          }
          return { status: 'fulfilled' } as const;
        } catch (reason) {
          return { status: 'rejected', reason } as const;
        }
      },
      { concurrency: DELETION_IO_CONCURRENCY },
    );
    const failures: unknown[] = [];
    for (const result of recoveries) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    return failures;
  }

  /**
   * Reconcile crash-interrupted deletions against the transcript registry.
   * A live transcript rolls its snapshot directory back. An absent transcript
   * restores the directory only into the orphan-cleanup namespace so the
   * execution directory and goal can be removed with the snapshot.
   */
  async reconcile(liveStreams: ReadonlySet<StreamTabId>): Promise<{
    restored: StreamTabId[];
    pendingCleanup: StreamTabId[];
    discarded: StreamTabId[];
  }> {
    let entries: [string, number][];
    try {
      entries = await StorageFS.readDir(STREAM_DATA_DELETION_DIR);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        entries = [];
      } else {
        throw error;
      }
    }

    const restored: StreamTabId[] = [];
    const pendingCleanup: StreamTabId[] = [];
    const discarded: StreamTabId[] = [];
    await pMap(
      entries.filter(([, type]) => isDirectory(type)),
      async ([encoded]) => {
        const parsedStream = StreamTabIdSchema.safeParse(
          decodeStreamId(encoded),
        );
        if (!parsedStream.success) {
          logger.warn(
            CHANNEL,
            `Ignoring invalid staged snapshot directory ${encoded}`,
            { data: parsedStream.error },
          );
          return;
        }
        const stream = parsedStream.data;
        const deletionState = this.deletionStates.get(stream);
        if (deletionState?.kind === 'staging') return;

        const stagedDir = stagedStreamDataDir(stream);
        const liveDir = streamDataDir(stream);
        if (deletionState) {
          const outcome = await this.recoverFailedRollback(
            stream,
            deletionState,
          );
          if (outcome === 'discarded') discarded.push(stream);
          else if (outcome === 'restored' && liveStreams.has(stream)) {
            restored.push(stream);
          } else if (outcome === 'restored') {
            pendingCleanup.push(stream);
          }
          return;
        }
        const hasLiveData = await storagePathExists(liveDir);
        if (!hasLiveData) {
          await StorageFS.ensureDir(STREAM_DATA_DIR);
          await StorageFS.rename(stagedDir, liveDir);
          this.host.invalidateKvHandles(stream);
          if (liveStreams.has(stream)) restored.push(stream);
          else pendingCleanup.push(stream);
          return;
        }

        await StorageFS.delete(stagedDir, { recursive: true });
        discarded.push(stream);
      },
      { concurrency: DELETION_IO_CONCURRENCY },
    );
    await pMap(
      [...this.deletionStates],
      async ([stream, state]) => {
        if (!liveStreams.has(stream) || state.kind === 'staging') return;
        await this.recoverFailedRollback(stream, state);
      },
      { concurrency: DELETION_IO_CONCURRENCY },
    );
    return { restored, pendingCleanup, discarded };
  }

  /** Restore writes buffered behind a staging attempt after live data returns. */
  private async replayStagedWrites(
    stream: StreamTabId,
    state: DeletionState,
  ): Promise<void> {
    while (state.writes.size > 0) {
      const writes = [...state.writes];
      state.writes.clear();
      try {
        await Promise.all(
          writes.map(([key, value]) =>
            this.host.queueWrite(stream, key, value),
          ),
        );
      } catch (error) {
        for (const [key, value] of writes) {
          if (!state.writes.has(key)) state.writes.set(key, value);
        }
        throw error;
      }
    }
  }

  /** Drain buffered writes and release every owner without an await-sized gap. */
  private async drainStagedWrites(
    stream: StreamTabId,
    state: DeletionState,
  ): Promise<void> {
    do {
      await this.replayStagedWrites(stream, state);
    } while (state.writes.size > 0);
    this.releaseDeletionOwnership(stream, state);
  }

  private releaseDeletionOwnership(
    stream: StreamTabId,
    state: DeletionState,
  ): void {
    if (state.writes.size > 0 || this.deletionStates.get(stream) !== state)
      return;
    this.deletionStates.delete(stream);
    if (state.kind === 'staging') state.resolveSettled();
  }

  private runRollbackRecovery(
    stream: StreamTabId,
    state: RollbackState,
    recover: (
      recovering: RecoveringRollbackState,
    ) => Promise<StagedRecoveryOutcome>,
  ): Promise<StagedRecoveryOutcome> {
    const current = this.deletionStates.get(stream);
    if (current?.kind === 'staging' || current?.writes !== state.writes) {
      return Promise.resolve('unchanged');
    }
    if (current.kind === 'rollback-recovering') return current.recovery;

    const deferred = pDefer<StagedRecoveryOutcome>();
    const recovering: RecoveringRollbackState = {
      kind: 'rollback-recovering',
      writes: current.writes,
      phase: current.phase,
      recovery: deferred.promise.finally(() => {
        if (this.deletionStates.get(stream) === recovering) {
          this.deletionStates.set(stream, {
            kind: 'rollback-idle',
            writes: recovering.writes,
            phase: recovering.phase,
          });
        }
      }),
    };
    this.deletionStates.set(stream, recovering);
    void recover(recovering).then(deferred.resolve, deferred.reject);
    return recovering.recovery;
  }

  private markRollbackFailed(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): IdleRollbackState {
    const failed: IdleRollbackState = {
      kind: 'rollback-idle',
      writes: state.writes,
      phase: state.phase,
    };
    if (this.deletionStates.get(stream) === state) {
      this.deletionStates.set(stream, failed);
    }
    return failed;
  }

  private recoverFailedRollback(
    stream: StreamTabId,
    state: RollbackState,
  ): Promise<StagedRecoveryOutcome> {
    return this.runRollbackRecovery(stream, state, async (recovering) => {
      let outcome: StagedRecoveryOutcome = 'unchanged';
      if (canUseStreamDataDir(stream)) {
        const stagedDir = stagedStreamDataDir(stream);
        const liveDir = streamDataDir(stream);
        const liveWasAuthoritative = recovering.phase === 'live';
        const [hasLiveData, hasStagedData] = await Promise.all([
          storagePathExists(liveDir),
          storagePathExists(stagedDir),
        ]);

        if (liveWasAuthoritative) {
          if (hasStagedData) {
            await StorageFS.delete(stagedDir, { recursive: true });
            outcome = 'discarded';
          }
        } else if (hasStagedData) {
          recovering.phase = 'staged';
          if (hasLiveData) {
            await StorageFS.delete(liveDir, { recursive: true });
          }
          await StorageFS.ensureDir(STREAM_DATA_DIR);
          recovering.phase = 'transitioning';
          await StorageFS.rename(stagedDir, liveDir);
          outcome = 'restored';
          this.host.invalidateKvHandles(stream);
        }
        if (!hasLiveData && (liveWasAuthoritative || !hasStagedData)) {
          await StorageFS.ensureDir(liveDir);
        }
      }

      // If neither namespace remains, buffered values are the only recoverable
      // state; replay recreates the live directory instead of wedging ownership.
      recovering.phase = 'live';
      await this.drainStagedWrites(stream, recovering);
      return outcome;
    });
  }

  /** Release ownership of a stream after its staged transaction finishes. */
  private settleStagedDeletion(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): void {
    if (this.deletionStates.get(stream) === state) {
      this.deletionStates.delete(stream);
    }
    state.resolveSettled();
  }

  /**
   * Atomically move a stream's sidecars out of the live namespace while
   * keeping its in-memory record available until the transcript registry
   * decides whether deletion commits.
   */
  async stage(stream: StreamTabId): Promise<StagedStreamSnapshotDeletion> {
    while (true) {
      const current = this.deletionStates.get(stream);
      if (!current) break;
      if (current.kind === 'staging') await current.settled;
      else await this.recoverFailedRollback(stream, current);
    }
    const settlement = pDefer<void>();
    const state: StagedDeletionState = {
      kind: 'staging',
      writes: new Map(),
      phase: 'live',
      settled: settlement.promise,
      resolveSettled: settlement.resolve,
    };
    this.deletionStates.set(stream, state);
    let writesCancelled = false;
    const cancelWrites = async (): Promise<void> => {
      if (writesCancelled) return;
      writesCancelled = true;
      const pending = this.host.cancelPendingWrites(stream);
      this.host.bumpStreamVersion(stream);
      await Promise.all(pending);
    };
    const waitForSeedChain = async (ignoreFailure = false): Promise<void> => {
      let seedChain = this.host.seedChain(stream);
      while (seedChain) {
        if (ignoreFailure) await seedChain.catch(() => undefined);
        else await seedChain;
        const current = this.host.seedChain(stream);
        if (!current || current === seedChain) return;
        seedChain = current;
      }
    };

    const canStage = canUseStreamDataDir(stream);
    try {
      if (canStage) {
        const hasStagedData = await storagePathExists(
          stagedStreamDataDir(stream),
        );
        if (hasStagedData) {
          state.phase = 'staged';
          throw new Error(
            `Stream ${stream} has an unreconciled snapshot deletion`,
          );
        }
        state.phase = 'live';
      }
      // Let hydration finish before staging. A record with `seeded === false`
      // may already contain sidecars while execution-config hydration is still
      // in flight, so invalidating that seed would make neither disk nor memory
      // authoritative for rollback.
      await waitForSeedChain();

      await cancelWrites();

      const liveDir = canStage ? streamDataDir(stream) : undefined;
      const stagedDir = canStage ? stagedStreamDataDir(stream) : undefined;
      if (liveDir && stagedDir && (await storagePathExists(liveDir))) {
        await StorageFS.ensureDir(STREAM_DATA_DELETION_DIR);
        state.phase = 'transitioning';
        await StorageFS.rename(liveDir, stagedDir);
        state.phase = 'staged';
      }

      let settled = false;
      return {
        commit: async () => {
          if (settled) return;
          settled = true;
          this.host.evict(stream);
          try {
            if (state.phase === 'staged' && stagedDir) {
              try {
                await StorageFS.delete(stagedDir, { recursive: true });
              } catch (error) {
                logger.warn(
                  CHANNEL,
                  `Stream ${stream} was deleted, but staged snapshot cleanup was incomplete.`,
                  { data: error },
                );
              }
            }
          } finally {
            this.settleStagedDeletion(stream, state);
          }
        },
        rollback: async () => {
          if (settled) return;
          settled = true;
          try {
            if (state.phase === 'staged' && stagedDir && liveDir) {
              state.phase = 'transitioning';
              await StorageFS.rename(stagedDir, liveDir);
              state.phase = 'live';
            }
            await this.drainStagedWrites(stream, state);
          } catch (error) {
            const failures: unknown[] = [error];
            if (state.phase !== 'live' && canUseStreamDataDir(stream)) {
              try {
                const [hasLiveData, hasStagedData] = await Promise.all([
                  storagePathExists(streamDataDir(stream)),
                  storagePathExists(stagedStreamDataDir(stream)),
                ]);
                if (hasStagedData) state.phase = 'staged';
                else if (hasLiveData) state.phase = 'live';
                else state.phase = 'unavailable';
              } catch (recoveryError) {
                failures.push(recoveryError);
              }
            }
            this.markRollbackFailed(stream, state);
            if (failures.length > 1) {
              throw new AggregateError(
                failures,
                `Failed to roll back snapshot deletion for ${stream} and inspect its namespace`,
              );
            }
            throw error;
          } finally {
            this.settleStagedDeletion(stream, state);
          }
        },
      };
    } catch (error) {
      const failures: unknown[] = [error];
      // An initial namespace inspection can fail before the normal seed wait.
      // Let any active refresh restore or replace authoritative memory before
      // the version bump invalidates its continuation.
      await waitForSeedChain(true);
      await cancelWrites();
      const failedRollback = this.markRollbackFailed(stream, state);
      try {
        if (state.phase === 'live') {
          await this.runRollbackRecovery(
            stream,
            failedRollback,
            async (owner) => {
              await this.drainStagedWrites(stream, owner);
              return 'unchanged';
            },
          );
        } else if (state.phase === 'transitioning') {
          await this.recoverFailedRollback(stream, failedRollback);
        }
      } catch (recoveryError) {
        failures.push(recoveryError);
      } finally {
        this.settleStagedDeletion(stream, state);
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `Failed to stage snapshot deletion for ${stream} and restore buffered writes`,
        );
      }
      throw error;
    }
  }
}
