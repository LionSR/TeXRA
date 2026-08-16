import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import pDefer, { type DeferredPromise } from 'p-defer';
import PQueue from 'p-queue';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';

import {
  ensureInstancePresence,
  probeInstance,
  InstanceOwnerSchema,
  type InstanceOwnerRecord,
} from './instancePresence';

const log = createLog('ExecutionLease');

const LeaseExecutionIdSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);

/**
 * Ownership record for one execution. Written once at acquisition, deleted at
 * release — never renewed. Liveness of `owner` is proven by probing its
 * presence socket; no field here is ever compared against a clock.
 */
export const ExecutionLeaseSchema = z.strictObject({
  version: z.literal(2),
  executionId: LeaseExecutionIdSchema,
  ownerToken: z.uuid(),
  acquiredAt: z.int().nonnegative(),
  owner: InstanceOwnerSchema,
});

type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseSchema>;

/**
 * The only surviving recognition of the retired heartbeat protocol: a
 * `{version: 1}` file is a tombstone with no semantics.
 */
const StoredLeaseSchema = z.union([
  ExecutionLeaseSchema,
  z
    .looseObject({ version: z.literal(1) })
    .transform(() => 'tombstone' as const),
]);

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
      readonly owner: InstanceOwnerRecord;
    }
  | {
      readonly status: 'foreign';
      readonly acquiredAt: number;
      readonly owner: InstanceOwnerRecord;
    };

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
    readonly owner: InstanceOwnerRecord,
  ) {
    super(`Execution ${executionId} is active in TeXRA.`);
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

function leasePath(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(
    root,
    WORKSPACE_STORAGE_LAYOUT.executionLeases,
    `${safeExecutionId}.json`,
  );
}

function coordinationPath(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(
    root,
    WORKSPACE_STORAGE_LAYOUT.executionLocks,
    safeExecutionId,
  );
}

async function readStoredLease(
  executionId: ExecutionId,
  root: string,
): Promise<ExecutionLeaseRecord | 'tombstone' | undefined> {
  let stored: ExecutionLeaseRecord | 'tombstone';
  try {
    stored = await StorageFS.readJson(
      leasePath(root, executionId),
      StoredLeaseSchema,
    );
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

/**
 * Locked read that deletes a retired tombstone on contact, so upgrades
 * self-heal. Only lock holders may call this — an unlocked delete could race
 * a concurrent acquisition that just replaced the file — so the unlocked
 * classifier (inspectExecutionLease) reads without healing instead.
 */
async function readLease(
  executionId: ExecutionId,
  root: string,
): Promise<ExecutionLeaseRecord | undefined> {
  const stored = await readStoredLease(executionId, root);
  if (stored !== 'tombstone') return stored;
  log.warn(
    `Deleted retired heartbeat-era lease record for execution ${executionId}`,
  );
  await StorageFS.delete(leasePath(root, executionId));
  return undefined;
}

async function writeLease(
  record: ExecutionLeaseRecord,
  root: string,
): Promise<void> {
  const persisted = ExecutionLeaseSchema.parse(record);
  await StorageFS.writeAtomic(
    leasePath(root, record.executionId),
    `${JSON.stringify(persisted, null, 2)}\n`,
  );
}

async function withLeaseLock<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
  root: string = storageRoot(),
): Promise<T> {
  await StorageFS.ensureDir(
    path.join(root, WORKSPACE_STORAGE_LAYOUT.executionLeases),
  );
  return platform().fileLocks.runExclusive(
    coordinationPath(root, executionId),
    operation,
  );
}

type PersistedExecutionLiveness =
  | {
      readonly status: 'active';
      readonly currentLease: ExecutionLeaseRecord;
    }
  | {
      readonly status: 'inactive';
      readonly currentLease: ExecutionLeaseRecord | undefined;
    };

/** Probe a lease's owner; unprovable verdicts classify as active. */
async function leaseOwnerIsActive(
  executionId: ExecutionId,
  record: ExecutionLeaseRecord,
): Promise<boolean> {
  const liveness = await probeInstance(record.owner);
  if (liveness === 'unprovable') {
    log.warn(
      `Liveness of execution ${executionId}'s owner is unprovable; treating it as active`,
      { data: { owner: record.owner } },
    );
  }
  return liveness !== 'dead';
}

/**
 * Classify a persisted lease by proving its owner's liveness. Reclamation
 * requires a death proof.
 */
async function readPersistedExecutionLiveness(
  executionId: ExecutionId,
  root: string,
): Promise<PersistedExecutionLiveness> {
  const currentLease = await readLease(executionId, root);
  if (!currentLease) {
    return { status: 'inactive', currentLease: undefined };
  }
  return (await leaseOwnerIsActive(executionId, currentLease))
    ? { status: 'active', currentLease }
    : { status: 'inactive', currentLease };
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

async function runWithValidatedOwnership<T>(
  lease: OwnedExecutionLease,
  operation: () => Promise<T>,
): Promise<T> {
  return withLeaseLock(
    lease.executionId,
    async () => {
      const current = await readLease(lease.executionId, lease.storageRoot);
      if (current?.ownerToken !== lease.ownerToken) {
        forgetOwnedLease(lease, { notifyLoss: true });
        throw new ExecutionLeaseLostError(lease.executionId);
      }
      return operation();
    },
    lease.storageRoot,
  );
}

/**
 * Carry this process's exact lease generation through asynchronous run work.
 * A continuation from a displaced owner keeps its original token and cannot
 * borrow a later local owner's lease for the same execution id.
 */
/** Capture the current generation so a delayed lifecycle root cannot borrow its successor. */
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
  return withLeaseLock(
    executionId,
    async () => {
      if (await readLease(executionId, root)) {
        throw new ExecutionLeaseLostError(executionId);
      }
      return operation();
    },
    root,
  );
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
        const validated = await withLeaseLock(
          executionId,
          async () => {
            const current = await readLease(executionId, root);
            if (current?.ownerToken !== existingOwnership.ownerToken) {
              forgetOwnedLease(existingOwnership, { notifyLoss: true });
              return 'lost' as const;
            }
            if ((await canAcquire?.()) === false) return 'cancelled' as const;
            return 'existing' as const;
          },
          root,
        );
        if (validated !== 'lost') return validated;
      }
    }

    return await withLeaseLock(
      executionId,
      async () => {
        const liveness = await readPersistedExecutionLiveness(
          executionId,
          root,
        );
        if (liveness.status === 'active') {
          throw new ExecutionLeaseActiveError(
            executionId,
            liveness.currentLease.owner,
          );
        }
        if ((await canAcquire?.()) === false) return 'cancelled' as const;
        const owner = await ensureInstancePresence();
        const stale = ownedLeases.get(key);
        if (stale) forgetOwnedLease(stale);
        const ownerToken = randomUUID();
        await writeLease(
          {
            version: 2,
            executionId,
            ownerToken,
            acquiredAt: Date.now(),
            owner,
          },
          root,
        );
        rememberOwnership(executionId, ownerToken, root);
        return 'acquired' as const;
      },
      root,
    );
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
    await withLeaseLock(
      executionId,
      async () => {
        const current = await readLease(executionId, root);
        if (current?.ownerToken !== ownership.ownerToken) {
          return;
        }
        await StorageFS.delete(leasePath(root, executionId));
      },
      root,
    );
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
  // Classification runs without the lease lock, so a retired-era tombstone is
  // reported as orphaned here and deleted by the next locked path instead.
  const record = await readStoredLease(executionId, root);
  if (!record) return { status: 'missing' };
  if (record === 'tombstone') return { status: 'orphaned' };
  const local = ownedLeases.get(ownershipKey(root, executionId));
  if (local?.ownerToken === record.ownerToken) {
    return {
      status: 'owned',
      acquiredAt: record.acquiredAt,
      owner: record.owner,
    };
  }
  const liveness = await probeInstance(record.owner);
  if (liveness === 'dead') return { status: 'orphaned' };
  return {
    status: 'foreign',
    acquiredAt: record.acquiredAt,
    owner: record.owner,
  };
}

/**
 * Run maintenance only while the owner is provably absent. Inspection and
 * mutation share the same cross-process lock, so a host cannot acquire
 * between them, and an unprovable owner refuses maintenance outright.
 */
export async function runWithInactiveExecutionLease<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<
  | { readonly status: 'active'; readonly owner: InstanceOwnerRecord }
  | { readonly status: 'performed'; readonly value: T }
> {
  const root = storageRoot();
  return withLeaseLock(
    executionId,
    async () => {
      const currentLease = await readLease(executionId, root);
      const local = ownedLeases.get(ownershipKey(root, executionId));
      if (local && currentLease?.ownerToken === local.ownerToken) {
        // The record names this live process; no probe is needed. A local
        // owner is protected by its own existence, never by any clock.
        // Report our own presence identity, not the record's copy: a record
        // whose owner field was tampered to name a dead instance must not
        // seed an exit watch that fires while this live owner still runs.
        return { status: 'active', owner: await ensureInstancePresence() };
      }
      if (local) {
        forgetOwnedLease(local, { notifyLoss: true });
      }
      if (
        currentLease &&
        (await leaseOwnerIsActive(executionId, currentLease))
      ) {
        return { status: 'active', owner: currentLease.owner };
      }
      const maintenanceKeys = new Set(maintenanceExecutions.getStore());
      maintenanceKeys.add(ownershipKey(root, executionId));
      const value = await maintenanceExecutions.run(maintenanceKeys, operation);
      if (currentLease) {
        await StorageFS.delete(leasePath(root, executionId));
      }
      return { status: 'performed', value };
    },
    root,
  );
}
