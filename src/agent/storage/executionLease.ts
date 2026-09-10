import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import pDefer from 'p-defer';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import { workspaceRoots } from '@platform/workspaceRoots';
import type { RunId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';
import { runOnPerKeyQueue } from '@utils/core/perKeyQueue';

import {
  currentLeaseOwner,
  LeaseOwnerSchema,
  type LeaseOwnerRecord,
  type OwnerLiveness,
  proveOwnerLiveness,
} from './leaseOwnerLiveness';
import type PQueue from 'p-queue';

const log = createLog('ExecutionLease');

const LeaseExecutionIdSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/);

/**
 * One claim on an execution, stored at
 * `executionLeases/<executionId>/<ownerToken>.json`. The file name is the
 * claim's identity: it is published complete by its owner, unlinked by its
 * owner at release or by a later claimant once the owner is provably dead,
 * and never renamed, rewritten, or reused. Nothing automatic removes the
 * claim of an owner that is alive or unprovable; only the user's explicit
 * deletion of the run reaps an unprovable one.
 * Liveness of `owner` is a kernel fact about its pid; no field here is ever
 * compared against a clock.
 */
export const RunLeaseSchema = z.strictObject({
  version: z.literal(3),
  executionId: LeaseExecutionIdSchema,
  ownerToken: z.uuid(),
  acquiredAt: z.int().nonnegative(),
  owner: LeaseOwnerSchema,
});

type ExecutionLeaseRecord = z.infer<typeof RunLeaseSchema>;

/** How long a claimant waits before re-reading a competitor's claim. */
const CLAIM_RECHECK_MS = 20;

/**
 * A claim loop re-reads after every lost race; each lost round means another
 * process made progress, so this bound is only reached under pathological
 * contention and then fails loudly rather than spinning.
 */
const MAX_CLAIM_ROUNDS = 16;

interface OwnedExecutionLease {
  readonly executionId: RunId;
  readonly ownerToken: string;
  readonly storageRoot: string;
  readonly released: Promise<void>;
  readonly resolveReleased: () => void;
  releasing: boolean;
}

/**
 * Who holds an execution, as persisted: nobody alive (`free`), this process
 * (`owned`), or another process whose owner is alive or unprovable (`held`).
 * Malformed present state rejects deliberately.
 */
export type RunLeasePresence =
  | { readonly status: 'free' }
  | { readonly status: 'owned' }
  | { readonly status: 'held'; readonly owner: LeaseOwnerRecord };

/**
 * A record this process may not touch: its owner is alive or unprovable.
 * The one shape both the claim protocol and the maintenance entry point
 * report a refusal with.
 */
interface LeaseHeld {
  readonly status: 'active';
  readonly owner: LeaseOwnerRecord;
}

type InactiveExecutionLeaseResult<T> =
  LeaseHeld | { readonly status: 'performed'; readonly value: T };

/**
 * Which surviving claims a claimant may unlink. Every automatic path reaps
 * only provably `dead` owners. The user's explicit deletion of a run also
 * reaps `unprovable` ones (another host, unreadable identity): the user is
 * the only party who can know that owner is gone, and asked for exactly
 * this.
 */
export type LeaseReapPolicy = 'dead' | 'dead-or-unprovable';

/** Why an execution refused a claim, in the words the user is shown. */
export function executionHeldMessage(
  executionId: RunId,
  owner: LeaseOwnerRecord,
): string {
  return `Execution ${executionId} is held by another TeXRA process (pid ${owner.pid} on ${owner.hostname}).`;
}

export class RunLeaseActiveError extends Error {
  constructor(
    readonly executionId: RunId,
    readonly owner: LeaseOwnerRecord,
  ) {
    super(executionHeldMessage(executionId, owner));
    this.name = 'ExecutionLeaseActiveError';
  }
}

export class RunLeaseLostError extends Error {
  constructor(readonly executionId: RunId) {
    super(`Execution ${executionId} is no longer owned by this TeXRA process.`);
    this.name = 'ExecutionLeaseLostError';
  }
}

const ownedLeases = new Map<string, OwnedExecutionLease>();
const maintenanceExecutions = new AsyncLocalStorage<ReadonlySet<string>>();

function storageRoot(): string {
  return workspaceRoots().storage;
}

function ownershipKey(root: string, executionId: RunId): string {
  return `${root}\0${executionId}`;
}

function claimDir(root: string, executionId: RunId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(
    root,
    WORKSPACE_STORAGE_LAYOUT.executionLeases,
    safeExecutionId,
  );
}

function claimPath(root: string, executionId: RunId, ownerToken: string) {
  return path.join(claimDir(root, executionId), `${ownerToken}.json`);
}

/** A current claim and the file that owns its identity. */
interface StoredClaim {
  readonly file: string;
  readonly record: ExecutionLeaseRecord;
}

async function readClaimFile(
  file: string,
  executionId: RunId,
): Promise<ExecutionLeaseRecord | undefined> {
  let stored: ExecutionLeaseRecord;
  try {
    stored = await StorageFS.readJson(file, RunLeaseSchema);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
  if (stored.executionId !== executionId) {
    throw new Error(
      `Execution lease identity mismatch: expected ${executionId}, found ${stored.executionId}.`,
    );
  }
  return stored;
}

/**
 * Every claim currently on disk for an execution, in token order. A file
 * that vanishes between the listing and its read belongs to a claimant that
 * backed out or released, and is simply not reported.
 */
async function readClaims(
  executionId: RunId,
  root: string,
): Promise<StoredClaim[]> {
  const claims: StoredClaim[] = [];
  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(claimDir(root, executionId));
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    entries = [];
  }
  for (const [name] of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claimDir(root, executionId), name);
    const record = await readClaimFile(file, executionId);
    if (!record) continue;
    if (name !== `${record.ownerToken}.json`) {
      throw new Error(
        `Execution lease identity mismatch: ${file} names owner ${record.ownerToken}.`,
      );
    }
    claims.push({ file, record });
  }
  // Plain code-unit order: every process must agree on it, unlike a locale.
  claims.sort((a, b) => (a.record.ownerToken < b.record.ownerToken ? -1 : 1));
  return claims;
}

interface JudgedClaim extends StoredClaim {
  readonly liveness: OwnerLiveness;
}

/**
 * Liveness of every claim other than `ownToken`. A token this process holds
 * is alive by identity, without a probe, so a tampered owner field can never
 * make a live local owner look dead.
 */
async function judgeClaims(
  executionId: RunId,
  root: string,
  ownToken?: string,
): Promise<JudgedClaim[]> {
  const claims = await readClaims(executionId, root);
  const local = ownedLeases.get(ownershipKey(root, executionId));
  const judged: JudgedClaim[] = [];
  for (const claim of claims) {
    const token = claim.record.ownerToken;
    if (token === ownToken) continue;
    const liveness =
      local?.ownerToken === token
        ? 'alive'
        : await proveOwnerLiveness(claim.record.owner);
    judged.push({ ...claim, liveness });
  }
  return judged;
}

/**
 * Unlink every claim `reap` allows and return the survivors. Safe without
 * any lock: a claim file is named by a token that is never reused, so the
 * file of a dead owner can never become a live claim again, and unlinking
 * it cannot displace anyone.
 */
async function reapClaims(
  judged: JudgedClaim[],
  reap: LeaseReapPolicy,
): Promise<JudgedClaim[]> {
  const survivors: JudgedClaim[] = [];
  for (const claim of judged) {
    const reapable =
      claim.liveness === 'dead' ||
      (claim.liveness === 'unprovable' && reap === 'dead-or-unprovable');
    if (!reapable) {
      survivors.push(claim);
      continue;
    }
    log.warn(
      `Execution ${claim.record.executionId}: removing the lease of ${claim.liveness} pid ${claim.record.owner.pid} on ${claim.record.owner.hostname}`,
    );
    await deleteClaimFile(claim.file);
  }
  return survivors;
}

async function deleteClaimFile(file: string): Promise<void> {
  try {
    await StorageFS.delete(file);
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
}

/** The claim to report when several refuse: a proven-alive owner first. */
function shownClaim(survivors: readonly JudgedClaim[]): JudgedClaim {
  return survivors.find((c) => c.liveness === 'alive') ?? survivors[0]!;
}

function heldBy(survivors: readonly JudgedClaim[]): LeaseHeld {
  return { status: 'active', owner: shownClaim(survivors).record.owner };
}

/** Publish this process's claim file, complete and durable, under its token. */
async function publishClaim(
  root: string,
  record: ExecutionLeaseRecord,
): Promise<void> {
  const dir = claimDir(root, record.executionId);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  for (;;) {
    await StorageFS.ensureDir(dir);
    try {
      await StorageFS.publish(
        claimPath(root, record.executionId, record.ownerToken),
        content,
      );
      return;
    } catch (error) {
      // A releasing owner removed the directory between the mkdir and the
      // publish; recreate it and publish again.
      if (!isFileNotFoundError(error)) throw error;
    }
  }
}

/**
 * Unlink this process's own claim file, then the
 * directory if it is empty. A file already gone is fine: the user may have
 * deleted the run from under this process, and a release must still settle.
 */
async function unlinkOwnClaim(
  executionId: RunId,
  root: string,
  ownerToken: string,
): Promise<void> {
  await deleteClaimFile(claimPath(root, executionId, ownerToken));
  try {
    await StorageFS.removeEmptyDir(claimDir(root, executionId));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOTEMPTY' || isFileNotFoundError(error)) return;
    log.warn(`Execution ${executionId}: could not remove its lease directory`, {
      data: error,
    });
  }
}

type ClaimOutcome =
  | { readonly status: 'claimed'; readonly record: ExecutionLeaseRecord }
  | LeaseHeld;

/**
 * The lock-free claim protocol. Nothing on disk is ever renamed or
 * overwritten at a shared path: each claimant publishes its own file, then
 * reads the others and decides.
 *
 * 1. Read the claims present. A dead owner's file is unlinked (ABA-free, see
 *    `reapClaims`); an owner that is alive refuses the claim outright, and
 *    so does an unprovable one unless `reap` says otherwise.
 * 2. Publish this process's claim file.
 * 3. Read again. No other live claim means this claim stands alone and has
 *    won: any claimant publishing later will see this file and back out.
 *    Two claimants that each see the other resolve by token order: the
 *    lexically larger backs out (unlinks its own file) and looks again from
 *    step 1, which reports whoever is still there; the smaller keeps
 *    re-reading until every larger file is gone and wins. A claimant never
 *    yields to a larger token, so the set of competitors above it only
 *    shrinks and the smallest always wins. A larger competitor that is alive
 *    but stuck exhausts the re-read bound, at which point reporting it as
 *    active is honest: that process really is alive.
 */
async function claimLease(
  executionId: RunId,
  root: string,
  reap: LeaseReapPolicy,
): Promise<ClaimOutcome> {
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
    const present = await reapClaims(
      await judgeClaims(executionId, root),
      reap,
    );
    if (present.length > 0) return heldBy(present);
    const record = RunLeaseSchema.parse({
      version: 3,
      executionId,
      ownerToken: randomUUID(),
      acquiredAt: Date.now(),
      owner: await currentLeaseOwner(),
    } satisfies ExecutionLeaseRecord);
    await publishClaim(root, record);
    let stuck: JudgedClaim[] | undefined;
    try {
      for (let check = 0; check < MAX_CLAIM_ROUNDS; check += 1) {
        const others = await reapClaims(
          await judgeClaims(executionId, root, record.ownerToken),
          reap,
        );
        if (others.length === 0) {
          return { status: 'claimed', record };
        }
        if (others[0]!.record.ownerToken < record.ownerToken) {
          stuck = undefined;
          break;
        }
        stuck = others;
        await delay(CLAIM_RECHECK_MS);
      }
    } catch (error) {
      await unlinkOwnClaim(executionId, root, record.ownerToken);
      throw error;
    }
    await unlinkOwnClaim(executionId, root, record.ownerToken);
    if (stuck) return heldBy(stuck);
  }
  throw new Error(
    `Execution ${executionId}: lost the lease claim race ${MAX_CLAIM_ROUNDS} times in a row.`,
  );
}

/** Whether this process's claim file is still on disk. */
function ownClaimPresent(lease: OwnedExecutionLease): Promise<boolean> {
  return StorageFS.exists(
    claimPath(lease.storageRoot, lease.executionId, lease.ownerToken),
  );
}

function forgetOwnedLease(lease: OwnedExecutionLease): void {
  const key = ownershipKey(lease.storageRoot, lease.executionId);
  if (ownedLeases.get(key) === lease) {
    ownedLeases.delete(key);
    lease.resolveReleased();
  }
}

function rememberOwnership(
  executionId: RunId,
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
  });
}

/** Whether this process owns the lease in the active storage root. */
export function ownsRunLease(executionId: RunId): boolean {
  const lease = ownedLeases.get(ownershipKey(storageRoot(), executionId));
  return lease !== undefined && !lease.releasing;
}

/**
 * Fail fast when this process does not own `executionId`, or is giving it up.
 * Generations of one execution are serialized by the registry's per-execution
 * lane, so the owned record for an id is always the generation doing the
 * asking; no async-context capture is needed to tell generations apart.
 */
export function assertOwnedRunLease(executionId: RunId): void {
  if (!ownsRunLease(executionId)) {
    throw new RunLeaseLostError(executionId);
  }
}

/**
 * The write fence: this process's claim file must still exist before the
 * operation runs. No code path removes a live owner's file, so its absence
 * means the user deleted the run and this process must not write.
 */
async function runWithValidatedOwnership<T>(
  lease: OwnedExecutionLease,
  operation: () => Promise<T>,
): Promise<T> {
  if (!(await ownClaimPresent(lease))) {
    forgetOwnedLease(lease);
    throw new RunLeaseLostError(lease.executionId);
  }
  return operation();
}

/**
 * Validate local ownership against the persisted record at a durability
 * boundary. A pure fencing check: nothing is written and no clock is read.
 */
export async function validateOwnedRunLease(executionId: RunId): Promise<void> {
  const key = ownershipKey(storageRoot(), executionId);
  const lease = ownedLeases.get(key);
  if (!lease || lease.releasing) {
    throw new RunLeaseLostError(executionId);
  }
  await runWithValidatedOwnership(lease, async () => undefined);
  // A release that started while the disk check was in flight wins: this
  // boundary must not report ownership the process is already giving up.
  if (lease.releasing || ownedLeases.get(key) !== lease) {
    throw new RunLeaseLostError(executionId);
  }
}

/**
 * Fence an execution-store mutation when this process claims ownership.
 * Maintenance callers without local ownership already run under
 * `runWithInactiveExecutionLease` and continue directly. A mutation with
 * neither (no production path has one; test fixtures write metadata this
 * way) claims the execution for its own duration, so it is never an
 * unsynchronized check-then-write beside another process.
 */
export async function runWithRunLeaseWriteFence<T>(
  executionId: RunId,
  operation: () => Promise<T>,
): Promise<T> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  if (maintenanceExecutions.getStore()?.has(key)) return operation();
  const lease = ownedLeases.get(key);
  if (lease) {
    if (lease.releasing) throw new RunLeaseLostError(executionId);
    return runWithValidatedOwnership(lease, operation);
  }
  // Unleased writers in this process take turns, so that two of them never
  // refuse each other over the maintenance claim the first one holds.
  // `runOnPerKeyQueue` also drops the idle queue when the operation throws,
  // which the previous inline epilogue skipped (a small leak on failure).
  const claimed = await runOnPerKeyQueue(unleasedWriteQueues, key, () =>
    runWithInactiveRunLease(executionId, operation),
  );
  if (claimed.status === 'active') {
    throw new RunLeaseLostError(executionId);
  }
  return claimed.value;
}

const unleasedWriteQueues = new Map<string, PQueue>();

async function acquireExecutionLease(
  executionId: RunId,
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
      if (await ownClaimPresent(existingOwnership)) return 'existing';
      forgetOwnedLease(existingOwnership);
    }
  }

  const claim = await claimLease(executionId, root, 'dead');
  if (claim.status === 'active') {
    throw new RunLeaseActiveError(executionId, claim.owner);
  }
  const stale = ownedLeases.get(key);
  if (stale) forgetOwnedLease(stale);
  rememberOwnership(executionId, claim.record.ownerToken, root);
  return 'acquired';
}

/** Acquire a new execution before any execution-scoped data becomes writable. */
export function acquireFreshRunLease(
  executionId: RunId,
): Promise<'acquired' | 'existing'> {
  return acquireExecutionLease(executionId, 'fresh');
}

/** Establish ownership before a persisted execution is resumed. */
export function acquireResumedRunLease(
  executionId: RunId,
): Promise<'acquired' | 'existing'> {
  return acquireExecutionLease(executionId, 'resume');
}

/** Release this process's lease, but never remove a later owner's record. */
export async function releaseOwnedRunLease(executionId: RunId): Promise<void> {
  await Promise.all(
    [...ownedLeases.values()]
      .filter((lease) => lease.executionId === executionId)
      .map(releaseOwnership),
  );
}

async function releaseOwnership(ownership: OwnedExecutionLease): Promise<void> {
  const root = ownership.storageRoot;
  const { executionId } = ownership;
  ownership.releasing = true;
  if (ownedLeases.get(ownershipKey(root, executionId)) !== ownership) {
    return;
  }
  try {
    await unlinkOwnClaim(executionId, root, ownership.ownerToken);
  } finally {
    forgetOwnedLease(ownership);
  }
}

/**
 * Who holds `executionId` on disk. Reads only: dead claims are reported as
 * absent here and unlinked by the next claim, never by this call.
 */
export async function inspectRunLease(
  executionId: RunId,
): Promise<RunLeasePresence> {
  const root = storageRoot();
  const judged = await judgeClaims(executionId, root);
  const local = ownedLeases.get(ownershipKey(root, executionId));
  if (judged.some((c) => c.record.ownerToken === local?.ownerToken)) {
    return { status: 'owned' };
  }
  const survivors = judged.filter((c) => c.liveness !== 'dead');
  if (survivors.length === 0) return { status: 'free' };
  return { status: 'held', owner: shownClaim(survivors).record.owner };
}

/**
 * Run maintenance on an execution nobody alive owns. The maintenance is
 * itself a claim: the record is published for its duration and unlinked
 * afterwards, so a concurrent acquisition sees a live local owner and
 * refuses, and a crash mid-maintenance leaves a record whose dead pid the
 * next claimant unlinks. An owner that is alive refuses maintenance
 * outright; an unprovable one refuses it unless `reap` says otherwise.
 */
export async function runWithInactiveRunLease<T>(
  executionId: RunId,
  operation: () => Promise<T>,
  reap: LeaseReapPolicy = 'dead',
): Promise<InactiveExecutionLeaseResult<T>> {
  const root = storageRoot();
  const key = ownershipKey(root, executionId);
  const local = ownedLeases.get(key);
  if (local) {
    if (await ownClaimPresent(local)) {
      // The record names this live process. Report our own identity, not
      // the record's copy, so a tampered owner field cannot misdescribe a
      // live local owner.
      return { status: 'active', owner: await currentLeaseOwner() };
    }
    forgetOwnedLease(local);
  }
  const claim = await claimLease(executionId, root, reap);
  if (claim.status === 'active') return claim;
  const maintenanceKeys = new Set(maintenanceExecutions.getStore());
  maintenanceKeys.add(key);
  let value: T;
  try {
    value = await maintenanceExecutions.run(maintenanceKeys, operation);
  } catch (error) {
    try {
      await unlinkOwnClaim(executionId, root, claim.record.ownerToken);
    } catch (releaseError) {
      log.warn(
        `Execution ${executionId}: maintenance failed and its lease could not be released`,
        { data: releaseError },
      );
    }
    throw error;
  }
  await unlinkOwnClaim(executionId, root, claim.record.ownerToken);
  return { status: 'performed', value };
}
