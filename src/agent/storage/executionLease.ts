import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import pDefer, { type DeferredPromise } from 'p-defer';
import PQueue from 'p-queue';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'ExecutionLease';
/** A host that misses eight heartbeats is no longer considered live. */
export const EXECUTION_LEASE_STALE_MS = 120_000;
const EXECUTION_LEASE_HEARTBEAT_MS = 15_000;

const LeaseExecutionIdSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);

export const ExecutionLeaseSchema = z
  .strictObject({
    version: z.literal(1),
    executionId: LeaseExecutionIdSchema,
    ownerToken: z.uuid(),
    acquiredAt: z.int().nonnegative(),
    heartbeatAt: z.int().nonnegative(),
  })
  .refine((lease) => lease.heartbeatAt >= lease.acquiredAt, {
    message: 'Execution lease heartbeat precedes acquisition.',
    path: ['heartbeatAt'],
  });

type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseSchema>;

interface OwnedExecutionLease {
  readonly executionId: ExecutionId;
  readonly ownerToken: string;
  readonly storageRoot: string;
  readonly released: Promise<void>;
  readonly resolveReleased: () => void;
  readonly lossListeners: Set<() => void>;
  heartbeatInFlight: Promise<void> | undefined;
  lastConfirmedHeartbeatAt: number;
  releasing: boolean;
  durabilityFailed: boolean;
}

export type ExecutionLeasePresence =
  | { readonly status: 'missing' }
  | { readonly status: 'stale'; readonly heartbeatAt: number }
  | { readonly status: 'owned'; readonly heartbeatAt: number }
  | { readonly status: 'foreign'; readonly heartbeatAt: number };

export type OwnedExecutionLeaseScope = <T>(
  operation: () => T | Promise<T>,
) => T | Promise<T>;

export class ExecutionLeaseActiveError extends Error {
  constructor(
    readonly executionId: ExecutionId,
    readonly heartbeatAt: number,
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
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

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

async function readLease(
  executionId: ExecutionId,
  root: string,
): Promise<ExecutionLeaseRecord | undefined> {
  try {
    const record = await StorageFS.readJson(
      leasePath(root, executionId),
      ExecutionLeaseSchema,
    );
    if (record.executionId !== executionId) {
      throw new Error(
        `Execution lease identity mismatch: expected ${executionId}, found ${record.executionId}.`,
      );
    }
    return record;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
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

function isFresh(record: ExecutionLeaseRecord, now: number): boolean {
  return now - record.heartbeatAt <= EXECUTION_LEASE_STALE_MS;
}

type PersistedExecutionLiveness =
  | {
      readonly status: 'active';
      readonly heartbeatAt: number;
      readonly currentLease: ExecutionLeaseRecord;
    }
  | {
      readonly status: 'inactive';
      readonly staleHeartbeatAt: number | undefined;
      readonly currentLease: ExecutionLeaseRecord | undefined;
    };

async function readPersistedExecutionLiveness(
  executionId: ExecutionId,
  root: string,
  now: number,
): Promise<PersistedExecutionLiveness> {
  const currentLease = await readLease(executionId, root);
  if (currentLease && isFresh(currentLease, now)) {
    return {
      status: 'active',
      heartbeatAt: currentLease.heartbeatAt,
      currentLease,
    };
  }
  return {
    status: 'inactive',
    staleHeartbeatAt: currentLease?.heartbeatAt,
    currentLease,
  };
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
          logger.warn(CHANNEL, 'Execution lease-loss listener failed', {
            data: { executionId: lease.executionId, error },
          });
        }
      }
    }
    lease.lossListeners.clear();
  }
  if (ownedLeases.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

async function heartbeat(
  lease: OwnedExecutionLease,
  canContinue?: () => boolean | Promise<boolean>,
): Promise<'owned' | 'lost' | 'cancelled'> {
  return withLeaseLock(
    lease.executionId,
    async () => {
      const current = await readLease(lease.executionId, lease.storageRoot);
      if (current?.ownerToken !== lease.ownerToken) {
        forgetOwnedLease(lease, { notifyLoss: true });
        return 'lost';
      }
      if ((await canContinue?.()) === false) return 'cancelled';
      await writeLease(
        { ...current, heartbeatAt: Date.now() },
        lease.storageRoot,
      );
      lease.lastConfirmedHeartbeatAt = Date.now();
      return 'owned';
    },
    lease.storageRoot,
  );
}

function renewHeartbeat(lease: OwnedExecutionLease): Promise<void> {
  if (lease.releasing) return Promise.resolve();
  if (lease.heartbeatInFlight) return lease.heartbeatInFlight;

  const work = heartbeat(lease)
    .then(() => undefined)
    .catch((error: unknown) => {
      if (handleHeartbeatFailure(lease, error)) throw error;
    })
    .finally(() => {
      if (lease.heartbeatInFlight === work) {
        lease.heartbeatInFlight = undefined;
      }
    });
  lease.heartbeatInFlight = work;
  return work;
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (error && typeof error === 'object') {
    if ('code' in error && error.code === code) return true;
    if (error instanceof AggregateError) {
      return error.errors.some((nested) => hasErrorCode(nested, code));
    }
  }
  return false;
}

function handleHeartbeatFailure(
  lease: OwnedExecutionLease,
  error: unknown,
): boolean {
  const ownershipUnprovable =
    hasErrorCode(error, 'ECOMPROMISED') ||
    Date.now() - lease.lastConfirmedHeartbeatAt > EXECUTION_LEASE_STALE_MS;
  if (ownershipUnprovable) {
    forgetOwnedLease(lease, { notifyLoss: true });
  }
  logger.warn(
    CHANNEL,
    `Failed to heartbeat execution ${lease.executionId}: ${toErrorMessage(error)}`,
    {
      data: {
        error,
        ownershipLost: ownershipUnprovable,
      },
    },
  );
  return ownershipUnprovable;
}

function rememberOwnership(
  executionId: ExecutionId,
  ownerToken: string,
  root: string,
): void {
  const { promise: released, resolve: resolveReleased } = pDefer<void>();
  const lease: OwnedExecutionLease = {
    executionId,
    ownerToken,
    storageRoot: root,
    released,
    resolveReleased,
    lossListeners: new Set(),
    heartbeatInFlight: undefined,
    lastConfirmedHeartbeatAt: Date.now(),
    releasing: false,
    durabilityFailed: false,
  };
  ownedLeases.set(ownershipKey(root, executionId), lease);
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const owned of ownedLeases.values()) {
        // heartbeat() records and classifies its own failure before rejecting;
        // the interval consumes that rejection because it has no caller.
        void renewHeartbeat(owned).catch(() => undefined);
      }
    }, EXECUTION_LEASE_HEARTBEAT_MS);
    heartbeatTimer.unref();
  }
}

/** Interrupt a live runtime if another process takes over this owned lease. */
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
export function runWithOwnedExecutionLease<T>(
  executionId: ExecutionId,
  operation: () => T | Promise<T>,
): T | Promise<T> {
  return captureOwnedExecutionLease(executionId)(operation);
}

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

/** Refresh and validate local ownership at a short durability boundary. */
export async function renewOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  const key = ownershipKey(storageRoot(), executionId);
  const lease = ownedLeases.get(key);
  if (!lease || lease.releasing || !currentScopeOwnsLease(lease)) {
    throw new ExecutionLeaseLostError(executionId);
  }
  await renewHeartbeat(lease);
  if (
    lease.releasing ||
    ownedLeases.get(ownershipKey(lease.storageRoot, executionId)) !== lease
  ) {
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
      let heartbeatResult: 'owned' | 'lost' | 'cancelled' | undefined;
      try {
        heartbeatResult = await heartbeat(existingOwnership, canAcquire);
      } catch (error) {
        if (handleHeartbeatFailure(existingOwnership, error)) throw error;
        if (
          ownedLeases.get(key) === existingOwnership &&
          !existingOwnership.releasing
        ) {
          const admitted = await withLeaseLock(
            executionId,
            async () => (await canAcquire?.()) !== false,
            root,
          );
          return admitted ? 'existing' : 'cancelled';
        }
      }
      if (heartbeatResult === 'cancelled') return 'cancelled';
      if (heartbeatResult === 'owned') return 'existing';
    }

    return await withLeaseLock(
      executionId,
      async () => {
        const now = Date.now();
        const liveness = await readPersistedExecutionLiveness(
          executionId,
          root,
          now,
        );
        if (liveness.status === 'active') {
          throw new ExecutionLeaseActiveError(
            executionId,
            liveness.heartbeatAt,
          );
        }
        if ((await canAcquire?.()) === false) return 'cancelled' as const;
        const acquiredAt = Date.now();
        const ownerToken = randomUUID();
        if (existingOwnership) forgetOwnedLease(existingOwnership);
        await writeLease(
          {
            version: 1,
            executionId,
            ownerToken,
            acquiredAt,
            heartbeatAt: acquiredAt,
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
 * Stop renewing ownership without deleting its persisted lease. Used when
 * terminal artifacts are not durable: peers remain blocked until the stale
 * horizon, but a long-lived host cannot keep the failed lease fresh forever.
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

/** Release a durable execution; otherwise stop renewal and retain its record. */
export async function completeOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  if (currentOwnedLeases(executionId).some((lease) => lease.durabilityFailed)) {
    abandonOwnedExecutionLease(executionId);
    return;
  }
  try {
    await releaseOwnedExecutionLease(executionId);
  } catch (error) {
    logger.warn(
      CHANNEL,
      `Failed to release execution ${executionId}; its lease will expire after the stale horizon: ${toErrorMessage(error)}`,
      { data: error },
    );
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
  await ownership.heartbeatInFlight?.catch(() => undefined);
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

/** Classify persisted liveness. Malformed present state rejects deliberately. */
export async function inspectExecutionLease(
  executionId: ExecutionId,
  now: number = Date.now(),
): Promise<ExecutionLeasePresence> {
  const root = storageRoot();
  const liveness = await readPersistedExecutionLiveness(executionId, root, now);
  if (liveness.status === 'active') {
    const local = ownedLeases.get(ownershipKey(root, executionId));
    return {
      status:
        local?.ownerToken === liveness.currentLease.ownerToken
          ? 'owned'
          : 'foreign',
      heartbeatAt: liveness.heartbeatAt,
    };
  }
  return liveness.staleHeartbeatAt === undefined
    ? { status: 'missing' }
    : { status: 'stale', heartbeatAt: liveness.staleHeartbeatAt };
}

/**
 * Run maintenance only while no fresh owner exists. Inspection and mutation
 * share the same cross-process lock, so a host cannot acquire between them.
 */
export async function runWithInactiveExecutionLease<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<
  | { readonly status: 'active'; readonly heartbeatAt: number }
  | { readonly status: 'performed'; readonly value: T }
> {
  const root = storageRoot();
  return withLeaseLock(
    executionId,
    async () => {
      const liveness = await readPersistedExecutionLiveness(
        executionId,
        root,
        Date.now(),
      );
      const current = liveness.currentLease;
      const local = ownedLeases.get(ownershipKey(root, executionId));
      if (local && current?.ownerToken === local.ownerToken) {
        return { status: 'active', heartbeatAt: current.heartbeatAt };
      }
      if (local) {
        forgetOwnedLease(local, { notifyLoss: true });
      }
      if (liveness.status === 'active') {
        return { status: 'active', heartbeatAt: liveness.heartbeatAt };
      }
      const maintenanceKeys = new Set(maintenanceExecutions.getStore());
      maintenanceKeys.add(ownershipKey(root, executionId));
      const value = await maintenanceExecutions.run(maintenanceKeys, operation);
      if (liveness.currentLease) {
        await StorageFS.delete(leasePath(root, executionId));
      }
      return { status: 'performed', value };
    },
    root,
  );
}
