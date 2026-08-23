import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import pDefer from 'p-defer';
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
const maintenanceExecutions = new AsyncLocalStorage<ReadonlySet<string>>();

function storageRoot(): string {
  return platform().storage.getStoragePath();
}

function ownershipKey(root: string, executionId: ExecutionId): string {
  return `${root}\0${executionId}`;
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
  | LeaseHeld;

/**
 * The claim protocol against the current on-disk state, repeated after every
 * lost race: nothing present means create; a dead owner means retire then
 * create; a retired-protocol record means retire and look again. An owner
 * that is alive, or whose liveness cannot be proven, refuses the claim
 * outright.
 */
async function claimLease(
  executionId: ExecutionId,
  root: string,
): Promise<ClaimOutcome> {
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

function forgetOwnedLease(lease: OwnedExecutionLease): void {
  const key = ownershipKey(lease.storageRoot, lease.executionId);
  if (ownedLeases.get(key) === lease) {
    ownedLeases.delete(key);
    lease.resolveReleased();
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
    releasing: false,
    durabilityFailed: false,
  });
}

/** Whether this process owns the lease in the active storage root. */
export function ownsExecutionLease(executionId: ExecutionId): boolean {
  const lease = ownedLeases.get(ownershipKey(storageRoot(), executionId));
  return lease !== undefined && !lease.releasing;
}

/**
 * Fail fast when this process does not own `executionId`, or is giving it up.
 * Generations of one execution are serialized by the registry's per-execution
 * lane, so the owned record for an id is always the generation doing the
 * asking; no async-context capture is needed to tell generations apart.
 */
export function assertOwnedExecutionLease(executionId: ExecutionId): void {
  if (!ownsExecutionLease(executionId)) {
    throw new ExecutionLeaseLostError(executionId);
  }
}

/**
 * The write fence: the in-process token is compared against the on-disk
 * record before the operation runs. A record that names anyone else means
 * this process was displaced and must not write. A record removed out of
 * band under a live run is accepted as tampering: the run learns of it here,
 * at its next fenced write, and aborts dirty; nothing watches the file.
 */
async function runWithValidatedOwnership<T>(
  lease: OwnedExecutionLease,
  operation: () => Promise<T>,
): Promise<T> {
  const current = await readStoredLease(lease.executionId, lease.storageRoot);
  if (current === 'tombstone' || current?.ownerToken !== lease.ownerToken) {
    forgetOwnedLease(lease);
    throw new ExecutionLeaseLostError(lease.executionId);
  }
  return operation();
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
  if (!lease || lease.releasing) {
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
  if (lease?.releasing) throw new ExecutionLeaseLostError(executionId);
  if (lease) return runWithValidatedOwnership(lease, operation);
  const current = await readStoredLease(executionId, root);
  if (current === 'tombstone') await retireLegacyLease(executionId, root);
  else if (current) throw new ExecutionLeaseLostError(executionId);
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
        return 'existing';
      }
      forgetOwnedLease(existingOwnership);
    }
  }

  const claim = await claimLease(executionId, root);
  if (claim.status === 'active') {
    throw new ExecutionLeaseActiveError(
      executionId,
      claim.owner,
      claim.provable,
    );
  }
  const stale = ownedLeases.get(key);
  if (stale) forgetOwnedLease(stale);
  rememberOwnership(executionId, claim.record.ownerToken, root);
  return 'acquired';
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
  const ownerships = currentOwnedLeases(executionId);
  await Promise.all(ownerships.map(releaseOwnership));
}

function currentOwnedLeases(executionId: ExecutionId): OwnedExecutionLease[] {
  return [...ownedLeases.values()].filter(
    (lease) => lease.executionId === executionId,
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
    forgetOwnedLease(local);
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
