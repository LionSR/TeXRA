import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { z } from 'zod';

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

const ownedLeases = new Map<string, OwnedExecutionLease>();
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

function coordinationPath(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(root, 'execution-locks', safeExecutionId);
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

function forgetOwnedLease(lease: OwnedExecutionLease): void {
  const key = ownershipKey(lease.storageRoot, lease.executionId);
  if (ownedLeases.get(key) === lease) ownedLeases.delete(key);
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
        forgetOwnedLease(lease);
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
  const lease: OwnedExecutionLease = {
    executionId,
    ownerToken,
    storageRoot: root,
  };
  ownedLeases.set(ownershipKey(root, executionId), lease);
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const owned of ownedLeases.values()) {
        void heartbeat(owned).catch((error: unknown) => {
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
      const current = await readLease(executionId, root);
      if (current && isFresh(current, now)) {
        throw new ExecutionLeaseActiveError(executionId, current.heartbeatAt);
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

/** Release at a completed owner boundary without replacing its primary result. */
export async function releaseOwnedExecutionLeaseBestEffort(
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
  try {
    await withLeaseLock(
      executionId,
      async () => {
        const current = await readLease(executionId, root);
        if (current?.ownerToken !== ownership.ownerToken) return;
        await StorageFS.delete(leasePath(root, executionId));
      },
      root,
    );
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
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
  const current = await readLease(executionId, root);
  if (!current) return { status: 'missing' };
  if (!isFresh(current, now)) {
    return { status: 'stale', heartbeatAt: current.heartbeatAt };
  }
  const local = ownedLeases.get(ownershipKey(root, executionId));
  return {
    status: local?.ownerToken === current.ownerToken ? 'owned' : 'foreign',
    heartbeatAt: current.heartbeatAt,
  };
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
      const current = await readLease(executionId, root);
      if (current && isFresh(current, Date.now())) {
        return { status: 'active', heartbeatAt: current.heartbeatAt };
      }
      const value = await operation();
      if (current) await StorageFS.delete(leasePath(root, executionId));
      return { status: 'performed', value };
    },
    root,
  );
}
