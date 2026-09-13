import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import pDefer from 'p-defer';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import { workspaceRoots } from '@platform/workspaceRoots';
import { RunIdSchema, type RunId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';
import { runOnPerKeyQueue } from '@utils/core/perKeyQueue';

import {
  currentLeaseOwner,
  LeaseOwnerSchema,
  type LeaseOwnerRecord,
  type OwnerLiveness,
  proveOwnerLiveness,
} from './leaseOwnerLiveness';

const log = createLog('RunLease');

/**
 * One claim on a run, stored at
 * `runLeases/<runId>/<ownerToken>.json`. The file name is the
 * claim's identity: it is published complete by its owner, unlinked by its
 * owner at release or by a later claimant once the owner is provably dead,
 * and never renamed, rewritten, or reused. Nothing removes the claim of an
 * owner that is alive or unprovable.
 * Liveness of `owner` is a kernel fact about its pid; no field here is ever
 * compared against a clock.
 */
export const RunLeaseSchema = z.strictObject({
  version: z.literal(3),
  runId: RunIdSchema,
  ownerToken: z.uuid(),
  acquiredAt: z.int().nonnegative(),
  owner: LeaseOwnerSchema,
});

type RunLeaseRecord = z.infer<typeof RunLeaseSchema>;

/** How long a claimant waits before re-reading a competitor's claim. */
const CLAIM_RECHECK_MS = 20;

/**
 * A claim loop re-reads after every lost race; each lost round means another
 * process made progress, so this bound is only reached under pathological
 * contention and then fails loudly rather than spinning.
 */
const MAX_CLAIM_ROUNDS = 16;

interface OwnedRunLease {
  readonly runId: RunId;
  readonly ownerToken: string;
  readonly storageRoot: string;
  readonly released: Promise<void>;
  readonly resolveReleased: () => void;
  releasing: boolean;
}

/**
 * Who holds a run, as persisted: nobody alive (`free`), this process
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

/** Why a run refused a claim, in the words the user is shown. */
export function runLeaseHeldMessage(
  runId: RunId,
  owner: LeaseOwnerRecord,
): string {
  return `Run ${runId} is held by another TeXRA process (pid ${owner.pid} on ${owner.hostname}).`;
}

export class RunLeaseActiveError extends Error {
  constructor(
    readonly runId: RunId,
    readonly owner: LeaseOwnerRecord,
  ) {
    super(runLeaseHeldMessage(runId, owner));
    this.name = 'RunLeaseActiveError';
  }
}

export class RunLeaseLostError extends Error {
  constructor(readonly runId: RunId) {
    super(`Run ${runId} is no longer owned by this TeXRA process.`);
    this.name = 'RunLeaseLostError';
  }
}

const ownedLeases = new Map<string, OwnedRunLease>();

function storageRoot(): string {
  return workspaceRoots().storage;
}

function ownershipKey(root: string, runId: RunId): string {
  return `${root}\0${runId}`;
}

function claimDir(root: string, runId: RunId): string {
  // A run id names its claim directory; the brand's hex alphabet admits no
  // path separator.
  const safeRunId = RunIdSchema.parse(runId);
  return path.join(root, WORKSPACE_STORAGE_LAYOUT.runLeases, safeRunId);
}

function claimPath(root: string, runId: RunId, ownerToken: string) {
  return path.join(claimDir(root, runId), `${ownerToken}.json`);
}

/** A current claim and the file that owns its identity. */
interface StoredClaim {
  readonly file: string;
  readonly record: RunLeaseRecord;
}

async function readClaimFile(
  file: string,
  runId: RunId,
): Promise<RunLeaseRecord | undefined> {
  let stored: RunLeaseRecord;
  try {
    stored = await StorageFS.readJson(file, RunLeaseSchema);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
  if (stored.runId !== runId) {
    throw new Error(
      `Run lease identity mismatch: expected ${runId}, found ${stored.runId}.`,
    );
  }
  return stored;
}

/**
 * Every claim currently on disk for a run, in token order. A file
 * that vanishes between the listing and its read belongs to a claimant that
 * backed out or released, and is simply not reported.
 */
async function readClaims(runId: RunId, root: string): Promise<StoredClaim[]> {
  const claims: StoredClaim[] = [];
  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(claimDir(root, runId));
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    entries = [];
  }
  for (const [name] of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claimDir(root, runId), name);
    const record = await readClaimFile(file, runId);
    if (!record) continue;
    if (name !== `${record.ownerToken}.json`) {
      throw new Error(
        `Run lease identity mismatch: ${file} names owner ${record.ownerToken}.`,
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
  runId: RunId,
  root: string,
  ownToken?: string,
): Promise<JudgedClaim[]> {
  const claims = await readClaims(runId, root);
  const local = ownedLeases.get(ownershipKey(root, runId));
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
 * Unlink the claim of every provably dead owner and return the survivors.
 * Safe without any lock: a claim file is named by a token that is never
 * reused, so the file of a dead owner can never become a live claim again,
 * and unlinking it cannot displace anyone.
 */
async function reapClaims(judged: JudgedClaim[]): Promise<JudgedClaim[]> {
  const survivors: JudgedClaim[] = [];
  for (const claim of judged) {
    if (claim.liveness !== 'dead') {
      survivors.push(claim);
      continue;
    }
    log.warn(
      `Run ${claim.record.runId}: removing the lease of dead pid ${claim.record.owner.pid} on ${claim.record.owner.hostname}`,
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
  record: RunLeaseRecord,
): Promise<void> {
  const dir = claimDir(root, record.runId);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  for (;;) {
    await StorageFS.ensureDir(dir);
    try {
      await StorageFS.publish(
        claimPath(root, record.runId, record.ownerToken),
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
  runId: RunId,
  root: string,
  ownerToken: string,
): Promise<void> {
  await deleteClaimFile(claimPath(root, runId, ownerToken));
  try {
    await StorageFS.removeEmptyDir(claimDir(root, runId));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOTEMPTY' || isFileNotFoundError(error)) return;
    log.warn(`Run ${runId}: could not remove its lease directory`, {
      data: error,
    });
  }
}

type ClaimOutcome =
  { readonly status: 'claimed'; readonly record: RunLeaseRecord } | LeaseHeld;

/**
 * The lock-free claim protocol. Nothing on disk is ever renamed or
 * overwritten at a shared path: each claimant publishes its own file, then
 * reads the others and decides.
 *
 * 1. Read the claims present. A dead owner's file is unlinked (ABA-free, see
 *    `reapClaims`); an owner that is alive or unprovable refuses the claim.
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
async function claimLease(runId: RunId, root: string): Promise<ClaimOutcome> {
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
    const present = await reapClaims(await judgeClaims(runId, root));
    if (present.length > 0) return heldBy(present);
    const record = RunLeaseSchema.parse({
      version: 3,
      runId,
      ownerToken: randomUUID(),
      acquiredAt: Date.now(),
      owner: await currentLeaseOwner(),
    } satisfies RunLeaseRecord);
    await publishClaim(root, record);
    let stuck: JudgedClaim[] | undefined;
    try {
      for (let check = 0; check < MAX_CLAIM_ROUNDS; check += 1) {
        const others = await reapClaims(
          await judgeClaims(runId, root, record.ownerToken),
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
      await unlinkOwnClaim(runId, root, record.ownerToken);
      throw error;
    }
    await unlinkOwnClaim(runId, root, record.ownerToken);
    if (stuck) return heldBy(stuck);
  }
  throw new Error(
    `Run ${runId}: lost the lease claim race ${MAX_CLAIM_ROUNDS} times in a row.`,
  );
}

/** Whether this process's claim file is still on disk. */
function ownClaimPresent(lease: OwnedRunLease): Promise<boolean> {
  return StorageFS.exists(
    claimPath(lease.storageRoot, lease.runId, lease.ownerToken),
  );
}

function forgetOwnedLease(lease: OwnedRunLease): void {
  const key = ownershipKey(lease.storageRoot, lease.runId);
  if (ownedLeases.get(key) === lease) {
    ownedLeases.delete(key);
    lease.resolveReleased();
  }
}

function rememberOwnership(
  runId: RunId,
  ownerToken: string,
  root: string,
): void {
  const { promise: released, resolve: resolveReleased } = pDefer<void>();
  ownedLeases.set(ownershipKey(root, runId), {
    runId,
    ownerToken,
    storageRoot: root,
    released,
    resolveReleased,
    releasing: false,
  });
}

/** Whether this process owns the lease in the active storage root. */
export function ownsRunLease(runId: RunId): boolean {
  const lease = ownedLeases.get(ownershipKey(storageRoot(), runId));
  return lease !== undefined && !lease.releasing;
}

/**
 * Fail fast when this process does not own `runId`, or is giving it up.
 * Generations of one run are serialized by the registry's per-run
 * lane, so the owned record for an id is always the generation doing the
 * asking; no async-context capture is needed to tell generations apart.
 */
export function assertOwnedRunLease(runId: RunId): void {
  if (!ownsRunLease(runId)) {
    throw new RunLeaseLostError(runId);
  }
}

/**
 * The write fence: this process's claim file must still exist before the
 * operation runs. No code path removes a live owner's file, so its absence
 * means the user deleted the run and this process must not write.
 */
async function runWithValidatedOwnership<T>(
  lease: OwnedRunLease,
  operation: () => Promise<T>,
): Promise<T> {
  if (!(await ownClaimPresent(lease))) {
    forgetOwnedLease(lease);
    throw new RunLeaseLostError(lease.runId);
  }
  return operation();
}

/**
 * Validate local ownership against the persisted record at a durability
 * boundary. A pure fencing check: nothing is written and no clock is read.
 */
export async function validateOwnedRunLease(runId: RunId): Promise<void> {
  const key = ownershipKey(storageRoot(), runId);
  const lease = ownedLeases.get(key);
  if (!lease || lease.releasing) {
    throw new RunLeaseLostError(runId);
  }
  await runWithValidatedOwnership(lease, async () => undefined);
  // A release that started while the disk check was in flight wins: this
  // boundary must not report ownership the process is already giving up.
  if (lease.releasing || ownedLeases.get(key) !== lease) {
    throw new RunLeaseLostError(runId);
  }
}

async function acquireRunLease(
  runId: RunId,
  mode: 'fresh' | 'resume',
): Promise<'acquired' | 'existing'> {
  const root = storageRoot();
  const key = ownershipKey(root, runId);
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

  const claim = await claimLease(runId, root);
  if (claim.status === 'active') {
    throw new RunLeaseActiveError(runId, claim.owner);
  }
  const stale = ownedLeases.get(key);
  if (stale) forgetOwnedLease(stale);
  rememberOwnership(runId, claim.record.ownerToken, root);
  return 'acquired';
}

/** Acquire a new run before any run-scoped data becomes writable. */
export function acquireFreshRunLease(
  runId: RunId,
): Promise<'acquired' | 'existing'> {
  return acquireRunLease(runId, 'fresh');
}

/** Establish ownership before a persisted run is resumed. */
export function acquireResumedRunLease(
  runId: RunId,
): Promise<'acquired' | 'existing'> {
  return acquireRunLease(runId, 'resume');
}

/** Release this process's lease, but never remove a later owner's record. */
export async function releaseOwnedRunLease(runId: RunId): Promise<void> {
  await Promise.all(
    [...ownedLeases.values()]
      .filter((lease) => lease.runId === runId)
      .map(releaseOwnership),
  );
}

async function releaseOwnership(ownership: OwnedRunLease): Promise<void> {
  const root = ownership.storageRoot;
  const { runId } = ownership;
  ownership.releasing = true;
  if (ownedLeases.get(ownershipKey(root, runId)) !== ownership) {
    return;
  }
  try {
    await unlinkOwnClaim(runId, root, ownership.ownerToken);
  } finally {
    forgetOwnedLease(ownership);
  }
}

/**
 * Who holds `runId` on disk. Reads only: dead claims are reported as
 * absent here and unlinked by the next claim, never by this call.
 */
export async function inspectRunLease(runId: RunId): Promise<RunLeasePresence> {
  const root = storageRoot();
  const judged = await judgeClaims(runId, root);
  const local = ownedLeases.get(ownershipKey(root, runId));
  if (judged.some((c) => c.record.ownerToken === local?.ownerToken)) {
    return { status: 'owned' };
  }
  const survivors = judged.filter((c) => c.liveness !== 'dead');
  if (survivors.length === 0) return { status: 'free' };
  return { status: 'held', owner: shownClaim(survivors).record.owner };
}
