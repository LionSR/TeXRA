import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { z } from 'zod';

import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { platform } from '@platform/platform';
import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'ExecutionLease';
/** A host that misses eight heartbeats is no longer considered live. */
export const EXECUTION_LEASE_STALE_MS = 120_000;
const EXECUTION_LEASE_HEARTBEAT_MS = 15_000;
/** Compatibility horizon used by the heartbeat protocol shipped before leases. */
const LEGACY_HEARTBEAT_STALE_MS = 30_000;
const LEGACY_HEARTBEAT_FILE = 'heartbeat.json';

const LeaseExecutionIdSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);

const ExecutionLeaseSchema = z
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
  durabilityFailed: boolean;
}

export type ExecutionLeasePresence =
  | { readonly status: 'missing' }
  | { readonly status: 'stale'; readonly heartbeatAt: number }
  | { readonly status: 'owned'; readonly heartbeatAt: number }
  | { readonly status: 'foreign'; readonly heartbeatAt: number };

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
const fencedOwnershipKeys = new Set<string>();
const maintenanceExecutions = new AsyncLocalStorage<ReadonlySet<string>>();
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function storageRoot(): string {
  return platform().storage.getStoragePath();
}

function ownershipKey(root: string, executionId: ExecutionId): string {
  return `${root}\0${executionId}`;
}

function leaseRelativePath(executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return `${WORKSPACE_STORAGE_LAYOUT.executionLeases}/${safeExecutionId}.json`;
}

function leasePath(root: string, executionId: ExecutionId): string {
  return path.join(root, leaseRelativePath(executionId));
}

function legacyHeartbeatPath(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(
    root,
    RUNS_STORAGE_DIR,
    safeExecutionId,
    LEGACY_HEARTBEAT_FILE,
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

async function readLegacyHeartbeatAt(
  executionId: ExecutionId,
  root: string,
): Promise<number | undefined> {
  try {
    return (await StorageFS.stat(legacyHeartbeatPath(root, executionId))).mtime;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

function isLegacyHeartbeatFresh(
  heartbeatAt: number | undefined,
  now: number,
): heartbeatAt is number {
  return (
    heartbeatAt !== undefined && now - heartbeatAt < LEGACY_HEARTBEAT_STALE_MS
  );
}

type PersistedExecutionLiveness =
  | {
      readonly status: 'active';
      readonly source: 'lease' | 'legacy-heartbeat';
      readonly heartbeatAt: number;
      readonly currentLease: ExecutionLeaseRecord | undefined;
    }
  | {
      readonly status: 'inactive';
      readonly staleHeartbeatAt: number | undefined;
      readonly currentLease: ExecutionLeaseRecord | undefined;
    };

/** Read both the current lease protocol and its one-release compatibility seam. */
async function readPersistedExecutionLiveness(
  executionId: ExecutionId,
  root: string,
  now: number,
): Promise<PersistedExecutionLiveness> {
  const currentLease = await readLease(executionId, root);
  if (currentLease && isFresh(currentLease, now)) {
    return {
      status: 'active',
      source: 'lease',
      heartbeatAt: currentLease.heartbeatAt,
      currentLease,
    };
  }
  const legacyHeartbeatAt = await readLegacyHeartbeatAt(executionId, root);
  if (isLegacyHeartbeatFresh(legacyHeartbeatAt, now)) {
    return {
      status: 'active',
      source: 'legacy-heartbeat',
      heartbeatAt: legacyHeartbeatAt,
      currentLease,
    };
  }
  return {
    status: 'inactive',
    staleHeartbeatAt: currentLease?.heartbeatAt ?? legacyHeartbeatAt,
    currentLease,
  };
}

function forgetOwnedLease(
  lease: OwnedExecutionLease,
  options: { notifyLoss?: boolean; fenceWrites?: boolean } = {},
): void {
  const key = ownershipKey(lease.storageRoot, lease.executionId);
  if (ownedLeases.get(key) === lease) {
    ownedLeases.delete(key);
    if (options.fenceWrites) fencedOwnershipKeys.add(key);
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

async function heartbeat(lease: OwnedExecutionLease): Promise<void> {
  await withLeaseLock(
    lease.executionId,
    async () => {
      const current = await readLease(lease.executionId, lease.storageRoot);
      if (current?.ownerToken !== lease.ownerToken) {
        forgetOwnedLease(lease, { notifyLoss: true, fenceWrites: true });
        return;
      }
      await writeLease(
        { ...current, heartbeatAt: Date.now() },
        lease.storageRoot,
      );
    },
    lease.storageRoot,
  );
}

function rememberOwnership(
  executionId: ExecutionId,
  ownerToken: string,
  root: string,
): void {
  let resolveReleased: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });
  const lease: OwnedExecutionLease = {
    executionId,
    ownerToken,
    storageRoot: root,
    released,
    resolveReleased,
    lossListeners: new Set(),
    durabilityFailed: false,
  };
  ownedLeases.set(ownershipKey(root, executionId), lease);
  fencedOwnershipKeys.delete(ownershipKey(root, executionId));
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const owned of ownedLeases.values()) {
        void heartbeat(owned).catch((error: unknown) => {
          // A host that cannot renew the lease also cannot prove continued
          // ownership to its peers. Ordinary execution persistence uses the
          // same storage root and will normally fail on the same outage; keep
          // the last lease record intact so peers remain fail-closed until the
          // documented stale horizon rather than deleting it prematurely.
          logger.warn(
            CHANNEL,
            `Failed to heartbeat execution ${owned.executionId}: ${toErrorMessage(error)}`,
            { data: error },
          );
        });
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
  return ownedLeases.has(ownershipKey(storageRoot(), executionId));
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
        forgetOwnedLease(lease, { notifyLoss: true, fenceWrites: true });
        throw new ExecutionLeaseLostError(lease.executionId);
      }
      return operation();
    },
    lease.storageRoot,
  );
}

/** Hold the coordination lock while an owned execution commits artifacts. */
export async function runWithOwnedExecutionLease<T>(
  executionId: ExecutionId,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = ownedLeases.get(ownershipKey(storageRoot(), executionId));
  if (!lease) throw new ExecutionLeaseLostError(executionId);
  return runWithValidatedOwnership(lease, operation);
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
  const key = ownershipKey(storageRoot(), executionId);
  if (maintenanceExecutions.getStore()?.has(key)) return operation();
  const lease = ownedLeases.get(key);
  if (lease) return runWithValidatedOwnership(lease, operation);
  if (fencedOwnershipKeys.has(key)) {
    throw new ExecutionLeaseLostError(executionId);
  }
  return operation();
}

async function acquireExecutionLease(
  executionId: ExecutionId,
  mode: 'fresh' | 'resume',
): Promise<'acquired' | 'existing'> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  const existingOwnership = ownedLeases.get(key);
  if (mode === 'resume' && existingOwnership) {
    await heartbeat(existingOwnership);
    if (ownedLeases.get(key) === existingOwnership) return 'existing';
  }

  return withLeaseLock(
    executionId,
    async () => {
      const now = Date.now();
      const liveness = await readPersistedExecutionLiveness(
        executionId,
        root,
        now,
      );
      if (liveness.status === 'active') {
        throw new ExecutionLeaseActiveError(executionId, liveness.heartbeatAt);
      }
      const ownerToken = randomUUID();
      if (existingOwnership) forgetOwnedLease(existingOwnership);
      await writeLease(
        {
          version: 1,
          executionId,
          ownerToken,
          acquiredAt: now,
          heartbeatAt: now,
        },
        root,
      );
      rememberOwnership(executionId, ownerToken, root);
      return 'acquired' as const;
    },
    root,
  );
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
): Promise<'acquired' | 'existing'> {
  return acquireExecutionLease(executionId, 'resume');
}

/** Release this process's lease, but never remove a later owner's record. */
export async function releaseOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  const ownerships = [...ownedLeases.values()].filter(
    (lease) => lease.executionId === executionId,
  );
  await Promise.all(ownerships.map(releaseOwnership));
}

/**
 * Stop renewing ownership without deleting its persisted lease. Used when
 * terminal artifacts are not durable: peers remain blocked until the stale
 * horizon, but a long-lived host cannot keep the failed lease fresh forever.
 */
export function abandonOwnedExecutionLease(executionId: ExecutionId): void {
  const root = storageRoot();
  const lease = ownedLeases.get(ownershipKey(root, executionId));
  if (lease) forgetOwnedLease(lease, { fenceWrites: true });
}

/** Prevent release after a required execution artifact failed to persist. */
export function markOwnedExecutionLeaseUndurable(
  executionId: ExecutionId,
): void {
  const lease = ownedLeases.get(ownershipKey(storageRoot(), executionId));
  if (lease) lease.durabilityFailed = true;
}

/** Release a durable execution; otherwise stop renewal and retain its record. */
export async function completeOwnedExecutionLease(
  executionId: ExecutionId,
): Promise<void> {
  const lease = ownedLeases.get(ownershipKey(storageRoot(), executionId));
  if (lease?.durabilityFailed) {
    abandonOwnedExecutionLease(executionId);
    return;
  }
  await releaseOwnedExecutionLeaseBestEffort(executionId);
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

/** Release at a completed owner boundary without replacing its primary result. */
async function releaseOwnedExecutionLeaseBestEffort(
  executionId: ExecutionId,
): Promise<void> {
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

async function releaseOwnership(ownership: OwnedExecutionLease): Promise<void> {
  const root = ownership.storageRoot;
  const { executionId } = ownership;
  let ownershipLost = false;
  try {
    await withLeaseLock(
      executionId,
      async () => {
        const current = await readLease(executionId, root);
        if (current?.ownerToken !== ownership.ownerToken) {
          ownershipLost = true;
          return;
        }
        await StorageFS.delete(leasePath(root, executionId));
      },
      root,
    );
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  } finally {
    forgetOwnedLease(ownership, { fenceWrites: ownershipLost });
  }
}

/** Classify persisted liveness. Malformed present state rejects deliberately. */
export async function inspectExecutionLease(
  executionId: ExecutionId,
  now: number = Date.now(),
): Promise<ExecutionLeasePresence> {
  const root = storageRoot();
  const liveness = await readPersistedExecutionLiveness(executionId, root, now);
  if (liveness.status === 'active' && liveness.source === 'lease') {
    const local = ownedLeases.get(ownershipKey(root, executionId));
    return {
      status:
        local?.ownerToken === liveness.currentLease?.ownerToken
          ? 'owned'
          : 'foreign',
      heartbeatAt: liveness.heartbeatAt,
    };
  }
  if (liveness.status === 'active') {
    return { status: 'foreign', heartbeatAt: liveness.heartbeatAt };
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
        forgetOwnedLease(local, { notifyLoss: true, fenceWrites: true });
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
