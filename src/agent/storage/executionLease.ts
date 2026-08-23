import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import pDefer, { type DeferredPromise } from 'p-defer';
import PQueue from 'p-queue';
import { z } from 'zod';

import { isFileExistsError, isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';

import {
  currentLeaseOwner,
  LeaseOwnerSchema,
  type LeaseOwnerRecord,
  proveOwnerLiveness,
} from './leaseOwnerLiveness';

const log = createLog('ExecutionLease');

const LeaseExecutionIdSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);

/**
 * Ownership record for one execution. Created exclusively at claim time,
 * unlinked at release, never renewed or rewritten. Liveness of `owner` is a
 * kernel fact about its pid; no field here is ever compared against a clock.
 */
export const ExecutionLeaseSchema = z.strictObject({
  version: z.literal(3),
  executionId: LeaseExecutionIdSchema,
  ownerToken: z.uuid(),
  acquiredAt: z.int().nonnegative(),
  owner: LeaseOwnerSchema,
});

type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseSchema>;

/**
 * Records from the retired heartbeat (v1) and presence-socket (v2) protocols
 * are tombstones with no semantics: retired on contact, never reclaimed as
 * live ownership.
 */
const StoredLeaseSchema = z.union([
  ExecutionLeaseSchema,
  z
    .looseObject({ version: z.union([z.literal(1), z.literal(2)]) })
    .transform(() => 'tombstone' as const),
]);

/**
 * A claim loop re-reads after every lost race; each lost round means another
 * process made progress, so this bound is only reached under pathological
 * contention and then fails loudly rather than spinning.
 */
const MAX_CLAIM_ROUNDS = 16;

interface OwnedExecutionLease {
  readonly executionId: ExecutionId;
  readonly ownerToken: string;
  readonly storageRoot: string;
  readonly released: Promise<void>;
  readonly resolveReleased: () => void;
  readonly lossListeners: Set<() => void>;
  releasing: boolean;
  durabilityFailed: boolean;
}

export type ExecutionLeasePresence =
  | { readonly status: 'missing' }
  | { readonly status: 'orphaned' }
  | {
      readonly status: 'owned';
      readonly acquiredAt: number;
      readonly owner: LeaseOwnerRecord;
      readonly provable: true;
    }
  | {
      readonly status: 'foreign';
      readonly acquiredAt: number;
      readonly owner: LeaseOwnerRecord;
      /** False when the owner could not be proven alive or dead. */
      readonly provable: boolean;
    };

/**
 * A record this process may not touch: its owner is alive, or its liveness
 * could not be proven (`provable: false`). The one shape both the claim
 * protocol and the maintenance entry point report a refusal with.
 */
type LeaseHeld = {
  readonly status: 'active';
  readonly owner: LeaseOwnerRecord;
  readonly provable: boolean;
};

export type InactiveExecutionLeaseResult<T> =
  LeaseHeld | { readonly status: 'performed'; readonly value: T };

export type OwnedExecutionLeaseCompletion =
  | { readonly status: 'released' }
  | { readonly status: 'retained'; readonly reason: 'undurable' }
  | {
      readonly status: 'retained';
      readonly reason: 'release-failed';
      readonly error: unknown;
    };

export type OwnedExecutionLeaseScope = <T>(
  operation: () => T | Promise<T>,
) => T | Promise<T>;

export class ExecutionLeaseActiveError extends Error {
  constructor(
    readonly executionId: ExecutionId,
    readonly owner: LeaseOwnerRecord,
    /** False when the owner could not be proven alive or dead. */
    readonly provable: boolean,
  ) {
    super(
      provable
        ? `Execution ${executionId} is active in TeXRA.`
        : `Execution ${executionId} is held by a TeXRA process that cannot be reached (pid ${owner.pid} on ${owner.hostname}).`,
    );
    this.name = 'ExecutionLeaseActiveError';
  }
}

export class ExecutionLeaseLostError extends Error {
  constructor(readonly executionId: ExecutionId) {
    super(`Execution ${executionId} is no longer owned by this TeXRA process.`);
    this.name = 'ExecutionLeaseLostError';
  }
}

const ownedLeases = new Map<string, OwnedExecutionLease>();
const executionOwnership = new AsyncLocalStorage<ReadonlyMap<string, string>>();
const maintenanceExecutions = new AsyncLocalStorage<ReadonlySet<string>>();

class ExecutionLeaseCoordination {
  private acquisitionsInFlight = 0;
  private readonly acquisitionIdleWaiters = new Set<() => void>();
  private readonly maintenanceQueue = new PQueue({ concurrency: 1 });
  private pendingMaintenanceCount = 0;
  private maintenanceBarrier: DeferredPromise<void> | undefined;

  async enterAcquisition(nested: boolean): Promise<void> {
    if (!nested) {
      while (this.maintenanceBarrier) await this.maintenanceBarrier.promise;
    }
    this.acquisitionsInFlight += 1;
  }

  leaveAcquisition(): void {
    this.acquisitionsInFlight -= 1;
    if (this.acquisitionsInFlight !== 0) return;
    for (const resolve of this.acquisitionIdleWaiters) resolve();
    this.acquisitionIdleWaiters.clear();
  }

  async waitForAcquisitions(): Promise<void> {
    if (this.acquisitionsInFlight === 0) return;
    await new Promise<void>((resolve) =>
      this.acquisitionIdleWaiters.add(resolve),
    );
  }

  runMaintenance<T>(
    waitForQuiescence: () => Promise<void>,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.pendingMaintenanceCount += 1;
    if (!this.maintenanceBarrier) {
      this.maintenanceBarrier = pDefer<void>();
    }
    // `add` widens to `T | void` for abort/timeout options; neither is used.
    const queued = this.maintenanceQueue.add(async () => {
      await waitForQuiescence();
      return operation();
    }) as Promise<T>;
    return queued.finally(() => {
      this.pendingMaintenanceCount -= 1;
      if (this.pendingMaintenanceCount !== 0) return;
      const barrier = this.maintenanceBarrier;
      this.maintenanceBarrier = undefined;
      barrier?.resolve();
    });
  }

  assertIdle(): void {
    if (
      this.acquisitionsInFlight !== 0 ||
      this.pendingMaintenanceCount !== 0 ||
      this.maintenanceQueue.pending !== 0 ||
      this.maintenanceQueue.size !== 0 ||
      this.acquisitionIdleWaiters.size !== 0
    ) {
      throw new Error('Execution lease coordination is still active.');
    }
  }
}

let leaseCoordination = new ExecutionLeaseCoordination();

/** Replace tested coordination state after every isolated test case. */
export function resetExecutionLeaseCoordinationForTests(): void {
  leaseCoordination.assertIdle();
  leaseCoordination = new ExecutionLeaseCoordination();
}

async function waitForOwnedLeaseQuiescence(): Promise<void> {
  for (;;) {
    await leaseCoordination.waitForAcquisitions();
    const releases = [...ownedLeases.values()].map((lease) => lease.released);
    if (releases.length === 0) return;
    await Promise.all(releases);
  }
}

/**
 * Run storage-root maintenance after all execution artifacts are durable.
 *
 * New root executions wait outside the barrier. Nested work already owned by
 * a live execution remains admitted so maintenance cannot deadlock a parent
 * waiting for its child; the loop includes every such acquisition and lease.
 */
export function runWithOwnedExecutionLeaseQuiescence<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  return leaseCoordination.runMaintenance(
    waitForOwnedLeaseQuiescence,
    operation,
  );
}

function storageRoot(): string {
  return platform().storage.getStoragePath();
}

function ownershipKey(root: string, executionId: ExecutionId): string {
  return `${root}\0${executionId}`;
}

/** Prevent an execution-owned continuation from acting on a later generation. */
function currentScopeOwnsLease(lease: OwnedExecutionLease): boolean {
  const ownership = executionOwnership.getStore();
  return (
    ownership === undefined ||
    ownership.get(ownershipKey(lease.storageRoot, lease.executionId)) ===
      lease.ownerToken
  );
}

function leaseDir(root: string): string {
  return path.join(root, WORKSPACE_STORAGE_LAYOUT.executionLeases);
}

function leasePath(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(leaseDir(root), `${safeExecutionId}.json`);
}

function tombstonePath(root: string, executionId: ExecutionId, tag: string) {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(leaseDir(root), `${safeExecutionId}.${tag}.tombstone`);
}

async function readStoredLeaseFile(
  file: string,
  executionId: ExecutionId,
): Promise<ExecutionLeaseRecord | 'tombstone' | undefined> {
  let stored: ExecutionLeaseRecord | 'tombstone';
  try {
    stored = await StorageFS.readJson(file, StoredLeaseSchema);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
  if (stored !== 'tombstone' && stored.executionId !== executionId) {
    throw new Error(
      `Execution lease identity mismatch: expected ${executionId}, found ${stored.executionId}.`,
    );
  }
  return stored;
}

function readStoredLease(
  executionId: ExecutionId,
  root: string,
): Promise<ExecutionLeaseRecord | 'tombstone' | undefined> {
  return readStoredLeaseFile(leasePath(root, executionId), executionId);
}

/**
 * Move a record that was classified as reclaimable out of the claim path.
 * `expected` is the owner token that was classified, or the sentinel
 * `'tombstone'` for a retired-protocol record. Exactly one renamer wins;
 * ENOENT means another process got there first and this claim is lost. The
 * moved content is then checked against what was classified: a record that
 * changed in between belongs to a claimant that won meanwhile and is put
 * back. Only the renamer unlinks what it moved.
 */
async function retireLease(
  executionId: ExecutionId,
  root: string,
  expected: string,
): Promise<'retired' | 'lost'> {
  const live = leasePath(root, executionId);
  const tombstone = tombstonePath(
    root,
    executionId,
    expected === 'tombstone' ? `retired-${randomUUID()}` : expected,
  );
  try {
    await StorageFS.rename(live, tombstone);
  } catch (error) {
    if (isFileNotFoundError(error)) return 'lost';
    throw error;
  }
  let moved: ExecutionLeaseRecord | 'tombstone' | undefined;
  try {
    moved = await readStoredLeaseFile(tombstone, executionId);
  } catch (error) {
    // Unparseable content cannot be a live claim; it is retired below.
    log.warn(
      `Retired an unreadable lease record for execution ${executionId}`,
      {
        data: error,
      },
    );
  }
  const movedToken = moved === 'tombstone' ? 'tombstone' : moved?.ownerToken;
  if (moved !== undefined && movedToken !== expected) {
    try {
      await StorageFS.rename(tombstone, live);
      return 'lost';
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      // A third claimant created a record in the same window. The displaced
      // claimant's next fenced write reads that record and aborts; nothing
      // can restore its ownership without unseating a valid claim.
      log.warn(
        `Execution ${executionId}: a lease claimed during reclamation was displaced by a concurrent claim; its owner will abort at the next fenced write`,
        { data: { displaced: moved } },
      );
    }
  }
  try {
    await StorageFS.delete(tombstone);
  } catch (error) {
    log.warn(
      `Execution ${executionId}: could not unlink lease tombstone ${tombstone}`,
      { data: error },
    );
  }
  return 'retired';
}

/**
 * Retire a record from a retired protocol on contact, so upgrades self-heal.
 * Any rename outcome is fine: either this process moved it or another did.
 */
async function retireLegacyLease(
  executionId: ExecutionId,
  root: string,
): Promise<void> {
  log.warn(
    `Retiring a lease record from a retired protocol for execution ${executionId}`,
  );
  await retireLease(executionId, root, 'tombstone');
}

type ClaimOutcome =
  | { readonly status: 'claimed'; readonly record: ExecutionLeaseRecord }
  | { readonly status: 'cancelled' }
  | LeaseHeld;

/**
 * The claim protocol against the current on-disk state, repeated after every
 * lost race: nothing present means create; a dead owner means retire then
 * create; a retired-protocol record means retire and look again. An owner
 * that is alive, or whose liveness cannot be proven, refuses the claim
 * outright. `admit` runs at most once, just before the first create attempt,
 * so an admission that is withdrawn never leaves a record behind — a claim
 * made without one can therefore never be cancelled.
 */
function claimLease(
  executionId: ExecutionId,
  root: string,
): Promise<Exclude<ClaimOutcome, { readonly status: 'cancelled' }>>;
function claimLease(
  executionId: ExecutionId,
  root: string,
  admit: (() => boolean | Promise<boolean>) | undefined,
): Promise<ClaimOutcome>;
async function claimLease(
  executionId: ExecutionId,
  root: string,
  admit?: () => boolean | Promise<boolean>,
): Promise<ClaimOutcome> {
  let admitted = admit === undefined;
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
    const current = await readStoredLease(executionId, root);
    if (current === 'tombstone') {
      await retireLegacyLease(executionId, root);
      continue;
    }
    if (current) {
      const liveness = await proveOwnerLiveness(current.owner);
      if (liveness !== 'dead') {
        return {
          status: 'active',
          owner: current.owner,
          provable: liveness === 'alive',
        };
      }
    }
    if (!admitted) {
      if ((await admit?.()) === false) return { status: 'cancelled' };
      admitted = true;
    }
    if (
      current &&
      (await retireLease(executionId, root, current.ownerToken)) === 'lost'
    ) {
      continue;
    }
    const record: ExecutionLeaseRecord = {
      version: 3,
      executionId,
      ownerToken: randomUUID(),
      acquiredAt: Date.now(),
      owner: await currentLeaseOwner(),
    };
    const persisted = ExecutionLeaseSchema.parse(record);
    await StorageFS.ensureDir(leaseDir(root));
    // The claim itself: create the record with `O_EXCL`. The kernel lets
    // exactly one concurrent creator through, so there is no lock and no
    // read-modify-write anywhere in this module.
    try {
      await StorageFS.writeExclusive(
        leasePath(root, executionId),
        `${JSON.stringify(persisted, null, 2)}\n`,
      );
      return { status: 'claimed', record };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }
  }
  throw new Error(
    `Execution ${executionId}: lost the lease claim race ${MAX_CLAIM_ROUNDS} times in a row.`,
  );
}

/** Unlink this process's own record, leaving any later owner's record alone. */
async function unlinkOwnRecord(
  executionId: ExecutionId,
  root: string,
  ownerToken: string,
): Promise<void> {
  const current = await readStoredLease(executionId, root);
  if (current === 'tombstone' || current?.ownerToken !== ownerToken) return;
  await StorageFS.delete(leasePath(root, executionId));
}

function forgetOwnedLease(
  lease: OwnedExecutionLease,
  options: { notifyLoss?: boolean } = {},
): void {
  const key = ownershipKey(lease.storageRoot, lease.executionId);
  if (ownedLeases.get(key) === lease) {
    ownedLeases.delete(key);
    lease.resolveReleased();
    if (options.notifyLoss) {
      for (const listener of lease.lossListeners) {
        try {
          listener();
        } catch (error) {
          log.warn('Execution lease-loss listener failed', {
            data: { executionId: lease.executionId, error },
          });
        }
      }
    }
    lease.lossListeners.clear();
  }
}

function rememberOwnership(
  executionId: ExecutionId,
  ownerToken: string,
  root: string,
): void {
  const { promise: released, resolve: resolveReleased } = pDefer<void>();
  ownedLeases.set(ownershipKey(root, executionId), {
    executionId,
    ownerToken,
    storageRoot: root,
    released,
    resolveReleased,
    lossListeners: new Set(),
    releasing: false,
    durabilityFailed: false,
  });
}

/** Interrupt a live runtime if its ownership record is found displaced. */
export function onOwnedExecutionLeaseLost(
  executionId: ExecutionId,
  listener: () => void,
): () => void {
  const leases = [...ownedLeases.values()].filter(
    (lease) => lease.executionId === executionId,
  );
  for (const lease of leases) lease.lossListeners.add(listener);
  return () => {
    for (const lease of leases) lease.lossListeners.delete(listener);
  };
}

/** Whether this process still owns the lease in the active storage root. */
export function ownsExecutionLease(executionId: ExecutionId): boolean {
  const key = ownershipKey(storageRoot(), executionId);
  const lease = ownedLeases.get(key);
  return lease !== undefined && currentScopeOwnsLease(lease);
}

/**
 * The write fence: the in-process token is compared against the on-disk
 * record before the operation runs. A record that names anyone else means
 * this process was displaced and must not write.
 */
async function runWithValidatedOwnership<T>(
  lease: OwnedExecutionLease,
  operation: () => Promise<T>,
): Promise<T> {
  const current = await readStoredLease(lease.executionId, lease.storageRoot);
  if (current === 'tombstone' || current?.ownerToken !== lease.ownerToken) {
    forgetOwnedLease(lease, { notifyLoss: true });
    throw new ExecutionLeaseLostError(lease.executionId);
  }
  return operation();
}

/**
 * Carry this process's exact lease generation through asynchronous run work,
 * so a delayed lifecycle root cannot borrow its successor. A continuation from
 * a displaced owner keeps its original token and cannot borrow a later local
 * owner's lease for the same execution id.
 */
export function captureOwnedExecutionLease(
  executionId: ExecutionId,
): OwnedExecutionLeaseScope {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  const lease = ownedLeases.get(key);
  if (!lease || lease.releasing) {
    throw new ExecutionLeaseLostError(executionId);
  }
  const currentOwnership = executionOwnership.getStore();
  const currentOwnerToken = currentOwnership?.get(key);
  if (
    currentOwnerToken !== undefined &&
    currentOwnerToken !== lease.ownerToken
  ) {
    throw new ExecutionLeaseLostError(executionId);
  }
  const ownerToken = lease.ownerToken;
  return <T>(operation: () => T | Promise<T>): T | Promise<T> => {
    const currentLease = ownedLeases.get(key);
    if (currentLease?.ownerToken !== ownerToken || currentLease.releasing) {
      throw new ExecutionLeaseLostError(executionId);
    }
    const ownership = new Map(executionOwnership.getStore());
    ownership.set(key, ownerToken);
    return executionOwnership.run(ownership, operation);
  };
}

/** Return undefined only for an unleased run; stale ambient ownership throws. */
export function captureOwnedExecutionLeaseIfPresent(
  executionId: ExecutionId,
): OwnedExecutionLeaseScope | undefined {
  const key = ownershipKey(storageRoot(), executionId);
  const hasAmbientOwnership = executionOwnership.getStore()?.has(key) ?? false;
  return hasAmbientOwnership || ownsExecutionLease(executionId)
    ? captureOwnedExecutionLease(executionId)
    : undefined;
}

/**
 * Validate local ownership against the persisted record at a durability
 * boundary. A pure fencing check: nothing is written and no clock is read.
 */
export async function validateOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  const key = ownershipKey(storageRoot(), executionId);
  const lease = ownedLeases.get(key);
  if (!lease || lease.releasing || !currentScopeOwnsLease(lease)) {
    throw new ExecutionLeaseLostError(executionId);
  }
  await runWithValidatedOwnership(lease, async () => undefined);
  // A release that started while the disk check was in flight wins: this
  // boundary must not report ownership the process is already giving up.
  if (lease.releasing || ownedLeases.get(key) !== lease) {
    throw new ExecutionLeaseLostError(executionId);
  }
}

/**
 * Fence an execution-store mutation when this process claims ownership.
 * Maintenance callers without local ownership already run under
 * `runWithInactiveExecutionLease` and continue directly.
 */
export async function runWithExecutionLeaseWriteFence<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<T> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  if (maintenanceExecutions.getStore()?.has(key)) return operation();
  const lease = ownedLeases.get(key);
  const ownerToken = executionOwnership.getStore()?.get(key);
  if (lease && ownerToken === undefined) {
    throw new ExecutionLeaseLostError(executionId);
  }
  if (
    ownerToken !== undefined &&
    (lease?.ownerToken !== ownerToken || lease.releasing)
  ) {
    throw new ExecutionLeaseLostError(executionId);
  }
  if (lease) return runWithValidatedOwnership(lease, operation);
  const current = await readStoredLease(executionId, root);
  if (current === 'tombstone') await retireLegacyLease(executionId, root);
  else if (current) throw new ExecutionLeaseLostError(executionId);
  return operation();
}

function acquireExecutionLease(
  executionId: ExecutionId,
  mode: 'fresh',
): Promise<'acquired' | 'existing'>;
function acquireExecutionLease(
  executionId: ExecutionId,
  mode: 'resume',
  canAcquire?: () => boolean | Promise<boolean>,
): Promise<'acquired' | 'existing' | 'cancelled'>;
async function acquireExecutionLease(
  executionId: ExecutionId,
  mode: 'fresh' | 'resume',
  canAcquire?: () => boolean | Promise<boolean>,
): Promise<'acquired' | 'existing' | 'cancelled'> {
  // An existing owned run may need to launch a child before it can settle.
  // Root launches wait; nested launches remain admitted and are included in
  // the dynamic quiescence check in waitForOwnedLeaseQuiescence.
  await leaseCoordination.enterAcquisition(
    (executionOwnership.getStore()?.size ?? 0) > 0,
  );
  try {
    const root = storageRoot();
    const key = ownershipKey(root, executionId);
    const existingOwnership = ownedLeases.get(key);
    if (mode === 'resume' && existingOwnership) {
      if (existingOwnership.releasing) {
        // A release in flight settles the record either way; re-acquire from
        // persisted state below instead of resurrecting the closing lease.
        await existingOwnership.released;
      } else {
        const current = await readStoredLease(executionId, root);
        if (
          current !== 'tombstone' &&
          current?.ownerToken === existingOwnership.ownerToken
        ) {
          if ((await canAcquire?.()) === false) return 'cancelled';
          return 'existing';
        }
        forgetOwnedLease(existingOwnership, { notifyLoss: true });
      }
    }

    const claim = await claimLease(executionId, root, canAcquire);
    switch (claim.status) {
      case 'cancelled':
        return 'cancelled';
      case 'active':
        throw new ExecutionLeaseActiveError(
          executionId,
          claim.owner,
          claim.provable,
        );
      case 'claimed': {
        const stale = ownedLeases.get(key);
        if (stale) forgetOwnedLease(stale);
        rememberOwnership(executionId, claim.record.ownerToken, root);
        return 'acquired';
      }
    }
  } finally {
    leaseCoordination.leaveAcquisition();
  }
}

/** Acquire a new execution before any execution-scoped data becomes writable. */
export function acquireFreshExecutionLease(
  executionId: ExecutionId,
): Promise<'acquired' | 'existing'> {
  return acquireExecutionLease(executionId, 'fresh');
}

/** Establish ownership before a persisted execution is resumed. */
export function acquireResumedExecutionLease(
  executionId: ExecutionId,
  canAcquire?: () => boolean | Promise<boolean>,
): Promise<'acquired' | 'existing' | 'cancelled'> {
  return acquireExecutionLease(executionId, 'resume', canAcquire);
}

/** Release this process's lease, but never remove a later owner's record. */
export async function releaseOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  const ownerships = currentOwnedLeases(executionId);
  await Promise.all(ownerships.map(releaseOwnership));
}

function currentOwnedLeases(executionId: ExecutionId): OwnedExecutionLease[] {
  return [...ownedLeases.values()].filter(
    (lease) =>
      lease.executionId === executionId && currentScopeOwnsLease(lease),
  );
}

/**
 * Stop claiming ownership without deleting the persisted record. Used when
 * terminal artifacts are not durable: peers keep refusing the execution while
 * this process lives, and reclaim it the moment this process exits.
 */
export function abandonOwnedExecutionLease(executionId: ExecutionId): void {
  for (const lease of currentOwnedLeases(executionId)) forgetOwnedLease(lease);
}

/** Prevent release after a required execution artifact failed to persist. */
export function markOwnedExecutionLeaseUndurable(
  executionId: ExecutionId,
): void {
  for (const lease of currentOwnedLeases(executionId)) {
    lease.durabilityFailed = true;
  }
}

/** Whether the current owned generation may publish post-drain durable state. */
export function isOwnedExecutionLeaseDurable(
  executionId: ExecutionId,
): boolean {
  const leases = currentOwnedLeases(executionId);
  if (leases.length === 0) throw new ExecutionLeaseLostError(executionId);
  return leases.every((lease) => !lease.durabilityFailed);
}

/** Release a durable execution; otherwise stop claiming and retain its record. */
export async function completeOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<OwnedExecutionLeaseCompletion> {
  if (currentOwnedLeases(executionId).some((lease) => lease.durabilityFailed)) {
    abandonOwnedExecutionLease(executionId);
    return { status: 'retained', reason: 'undurable' };
  }
  try {
    await releaseOwnedExecutionLease(executionId);
    return { status: 'released' };
  } catch (error) {
    log.warn(
      `Failed to release execution ${executionId}; peers reclaim its record once this process exits`,
      { data: error },
    );
    return { status: 'retained', reason: 'release-failed', error };
  }
}

/** Release during rollback without allowing cleanup failure to mask the cause. */
export async function releaseOwnedExecutionLeaseAfterFailure(
  executionId: ExecutionId,
  primaryError: unknown,
): Promise<unknown> {
  try {
    await releaseOwnedExecutionLease(executionId);
    return primaryError;
  } catch (releaseError) {
    return new AggregateError(
      [primaryError, releaseError],
      `Execution ${executionId} failed and its lease could not be released`,
    );
  }
}

/**
 * Run pre-handoff launch work under one failure policy: if the operation
 * throws before the child run loop has taken over the execution, release the
 * fresh lease before the error propagates — a failed launch must not leave a
 * record that refuses a prompt relaunch for this process's whole lifetime.
 * Post-handoff work must stay outside this guard: once the run loop owns the
 * lease, releasing it would yank ownership from a live child.
 */
export async function runWithOwnedExecutionLeaseLaunchGuard<T>(
  executionId: ExecutionId,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw await releaseOwnedExecutionLeaseAfterFailure(executionId, error);
  }
}

/**
 * Wait until this process has released every lease it owns for an execution.
 * Foreign ownership never blocks this local lifecycle boundary.
 */
export async function waitForOwnedExecutionLeaseRelease(
  executionId: ExecutionId,
): Promise<void> {
  const releases = [...ownedLeases.values()]
    .filter((lease) => lease.executionId === executionId)
    .map((lease) => lease.released);
  await Promise.all(releases);
}

async function releaseOwnership(ownership: OwnedExecutionLease): Promise<void> {
  const root = ownership.storageRoot;
  const { executionId } = ownership;
  ownership.releasing = true;
  if (ownedLeases.get(ownershipKey(root, executionId)) !== ownership) {
    return;
  }
  try {
    await unlinkOwnRecord(executionId, root, ownership.ownerToken);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  } finally {
    forgetOwnedLease(ownership);
  }
}

/** Classify persisted ownership. Malformed present state rejects deliberately. */
export async function inspectExecutionLease(
  executionId: ExecutionId,
): Promise<ExecutionLeasePresence> {
  const root = storageRoot();
  // Classification mutates nothing: a retired-protocol record is reported as
  // orphaned here and retired by the next claim instead.
  const record = await readStoredLease(executionId, root);
  if (!record) return { status: 'missing' };
  if (record === 'tombstone') return { status: 'orphaned' };
  const local = ownedLeases.get(ownershipKey(root, executionId));
  if (local?.ownerToken === record.ownerToken) {
    return {
      status: 'owned',
      acquiredAt: record.acquiredAt,
      owner: record.owner,
      provable: true,
    };
  }
  const liveness = await proveOwnerLiveness(record.owner);
  if (liveness === 'dead') return { status: 'orphaned' };
  return {
    status: 'foreign',
    acquiredAt: record.acquiredAt,
    owner: record.owner,
    provable: liveness === 'alive',
  };
}

/**
 * Remove a record whose owner is not provably alive, so the execution can be
 * claimed again. This is the user's explicit Reclaim action for an owner that
 * cannot be reached; every automatic path keeps refusing such a record.
 */
export async function reclaimExecutionLease(
  executionId: ExecutionId,
): Promise<'reclaimed' | 'missing' | 'alive'> {
  const root = storageRoot();
  const record = await readStoredLease(executionId, root);
  if (!record) return 'missing';
  if (record === 'tombstone') {
    await retireLegacyLease(executionId, root);
    return 'reclaimed';
  }
  const local = ownedLeases.get(ownershipKey(root, executionId));
  if (local?.ownerToken === record.ownerToken) return 'alive';
  if ((await proveOwnerLiveness(record.owner)) === 'alive') return 'alive';
  await retireLease(executionId, root, record.ownerToken);
  return 'reclaimed';
}

/**
 * Run maintenance on an execution nobody alive owns. The maintenance is
 * itself a claim: the record is created exclusively for its duration and
 * unlinked afterwards, so a concurrent acquisition sees a live local owner
 * and refuses, and a crash mid-maintenance leaves a record whose dead pid
 * the next claimant reclaims. An owner that is alive or unprovable refuses
 * maintenance outright.
 */
export async function runWithInactiveExecutionLease<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<InactiveExecutionLeaseResult<T>> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  const local = ownedLeases.get(key);
  if (local) {
    const current = await readStoredLease(executionId, root);
    if (current !== 'tombstone' && current?.ownerToken === local.ownerToken) {
      // The record names this live process. Report our own identity, not
      // the record's copy, so a tampered owner field cannot misdescribe a
      // live local owner.
      return {
        status: 'active',
        owner: await currentLeaseOwner(),
        provable: true,
      };
    }
    forgetOwnedLease(local, { notifyLoss: true });
  }
  const claim = await claimLease(executionId, root);
  if (claim.status === 'active') return claim;
  const maintenanceKeys = new Set(maintenanceExecutions.getStore());
  maintenanceKeys.add(key);
  let value: T;
  try {
    value = await maintenanceExecutions.run(maintenanceKeys, operation);
  } catch (error) {
    try {
      await unlinkOwnRecord(executionId, root, claim.record.ownerToken);
    } catch (releaseError) {
      log.warn(
        `Execution ${executionId}: maintenance failed and its lease could not be released`,
        { data: releaseError },
      );
    }
    throw error;
  }
  await unlinkOwnRecord(executionId, root, claim.record.ownerToken);
  return { status: 'performed', value };
}
