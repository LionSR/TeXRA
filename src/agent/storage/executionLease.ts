import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import pDefer from 'p-defer';
import PQueue from 'p-queue';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files/storageFS';

import {
  currentLeaseOwner,
  LeaseOwnerSchema,
  type LeaseOwnerRecord,
  type OwnerHold,
  type OwnerLiveness,
  ownerHold,
  proveOwnerLiveness,
} from './leaseOwnerLiveness';

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
 * and never renamed, rewritten, or reused. Liveness of `owner` is a kernel
 * fact about its pid; no field here is ever compared against a clock.
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
 * The single-file records of the two retired protocols, still found at
 * `executionLeases/<executionId>.json`. A presence-socket record (v2,
 * shipped in 0.40.4) can belong to a process that is live during a rolling
 * upgrade, so it is read as an ordinary claim whose owner is proven by pid
 * alone (no start identity was ever recorded). A heartbeat record (v1)
 * predates 0.40.4 and names no process: it is a tombstone, retired on
 * contact, exactly as 0.40.4 treated it.
 */
const LegacyLeaseSchema = z.union([
  z
    .looseObject({
      version: z.literal(2),
      executionId: LeaseExecutionIdSchema,
      ownerToken: z.uuid(),
      acquiredAt: z.int().nonnegative(),
      owner: z.looseObject({
        pid: z.int().positive(),
        hostname: z.string().min(1),
      }),
    })
    .transform((record) =>
      ExecutionLeaseSchema.parse({
        version: 3,
        executionId: record.executionId,
        ownerToken: record.ownerToken,
        acquiredAt: record.acquiredAt,
        owner: {
          pid: record.owner.pid,
          processStart: null,
          hostname: record.owner.hostname,
        },
      } satisfies ExecutionLeaseRecord),
    ),
  z
    .looseObject({ version: z.literal(1) })
    .transform(() => 'tombstone' as const),
]);

/**
 * COMPATIBILITY SHIM, delete after v0.41 ships: the v2 record a 0.40.4
 * process reads at the single-file path. While this process holds a v3
 * claim it keeps one of these beside it, naming its own token and pid and a
 * socket path that does not exist. A 0.40.4 reader probes that path, gets
 * ENOENT, sees the pid alive, and treats the owner as active, so it backs
 * off instead of claiming beside a v3 owner it cannot see. 0.40.4 validates
 * the record strictly, so every field it expects is present.
 */
function legacyShadowRecord(record: ExecutionLeaseRecord): string {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\texra-${record.ownerToken}`
      : path.join(os.tmpdir(), `texra-${record.ownerToken}.sock`);
  return `${JSON.stringify(
    {
      version: 2,
      executionId: record.executionId,
      ownerToken: record.ownerToken,
      acquiredAt: record.acquiredAt,
      owner: {
        instanceId: record.ownerToken,
        socketPath,
        pid: record.owner.pid,
        hostname: record.owner.hostname,
      },
    },
    null,
    2,
  )}\n`;
}

/** How long a claimant waits before re-reading a competitor's claim. */
const CLAIM_RECHECK_MS = 20;

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
      readonly reclaimable: false;
    }
  | ({ readonly status: 'foreign'; readonly acquiredAt: number } & OwnerHold);

/**
 * A record this process may not touch: its owner is alive, or its liveness
 * could not be proven (`provable: false`). The one shape both the claim
 * protocol and the maintenance entry point report a refusal with.
 */
type LeaseHeld = { readonly status: 'active' } & OwnerHold;

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

/** Why an execution refused a claim, in the words the user is shown. */
export function executionHeldMessage(
  executionId: ExecutionId,
  hold: OwnerHold,
): string {
  if (hold.provable) return `Execution ${executionId} is active in TeXRA.`;
  if (hold.reclaimable) {
    return `Execution ${executionId} is held by a TeXRA process that cannot be reached (pid ${hold.owner.pid} on ${hold.owner.hostname}).`;
  }
  return `Execution ${executionId} is held by pid ${hold.owner.pid} on this machine; its identity could not be read.`;
}

export class ExecutionLeaseActiveError extends Error implements OwnerHold {
  readonly owner: LeaseOwnerRecord;
  /** False when the owner could not be proven alive. */
  readonly provable: boolean;
  /** True when an explicit reclaim would remove the record. */
  readonly reclaimable: boolean;

  constructor(
    readonly executionId: ExecutionId,
    hold: OwnerHold,
  ) {
    super(executionHeldMessage(executionId, hold));
    this.name = 'ExecutionLeaseActiveError';
    this.owner = hold.owner;
    this.provable = hold.provable;
    this.reclaimable = hold.reclaimable;
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

function legacyLeasePath(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(leaseDir(root), `${safeExecutionId}.json`);
}

function claimDir(root: string, executionId: ExecutionId): string {
  const safeExecutionId = LeaseExecutionIdSchema.parse(executionId);
  return path.join(leaseDir(root), safeExecutionId);
}

function claimPath(root: string, executionId: ExecutionId, ownerToken: string) {
  return path.join(claimDir(root, executionId), `${ownerToken}.json`);
}

/**
 * A claim as found on disk. `files` is everything a reap or reclaim unlinks
 * for it: the claim file, plus the legacy shadow record when the claim's
 * owner keeps one (see `legacyShadowRecord`).
 */
interface StoredClaim {
  readonly files: readonly string[];
  readonly record: ExecutionLeaseRecord;
}

async function readClaimFile<T extends ExecutionLeaseRecord | 'tombstone'>(
  file: string,
  executionId: ExecutionId,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  let stored: T;
  try {
    stored = await StorageFS.readJson(file, schema);
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
 * The record at the legacy single-file path, or undefined. A heartbeat
 * tombstone is deleted on contact: no supported version writes one and the
 * protocol it belongs to expired its own records.
 */
async function readLegacyRecord(
  executionId: ExecutionId,
  root: string,
): Promise<ExecutionLeaseRecord | undefined> {
  const legacyFile = legacyLeasePath(root, executionId);
  const legacy = await readClaimFile(
    legacyFile,
    executionId,
    LegacyLeaseSchema,
  );
  if (legacy !== 'tombstone') return legacy;
  log.warn(
    `Deleted retired heartbeat-era lease record for execution ${executionId}`,
  );
  try {
    await StorageFS.delete(legacyFile);
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  return undefined;
}

/**
 * Every claim currently on disk for an execution, in token order. A file
 * that vanishes between the listing and its read belongs to a claimant that
 * backed out or released, and is simply not reported. A legacy record whose
 * token matches a claim file is that claim's shadow, not a second claim: its
 * owner's verdict comes from the claim file, which carries the identity.
 */
async function readClaims(
  executionId: ExecutionId,
  root: string,
): Promise<StoredClaim[]> {
  const claims: StoredClaim[] = [];
  const legacyFile = legacyLeasePath(root, executionId);
  const legacy = await readLegacyRecord(executionId, root);
  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(claimDir(root, executionId));
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    entries = [];
  }
  let shadowed = false;
  for (const [name] of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claimDir(root, executionId), name);
    const record = await readClaimFile(file, executionId, ExecutionLeaseSchema);
    if (!record) continue;
    if (name !== `${record.ownerToken}.json`) {
      throw new Error(
        `Execution lease identity mismatch: ${file} names owner ${record.ownerToken}.`,
      );
    }
    const shadow = legacy?.ownerToken === record.ownerToken;
    shadowed ||= shadow;
    claims.push({ files: shadow ? [file, legacyFile] : [file], record });
  }
  if (legacy && !shadowed) claims.push({ files: [legacyFile], record: legacy });
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
  executionId: ExecutionId,
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
 * Unlink every dead claim and return the survivors. Safe without any lock:
 * a claim file is named by a token that is never reused, so the file of a
 * dead owner can never become a live claim again, and unlinking it cannot
 * displace anyone. (The one exception is a legacy single-file record, whose
 * path a 0.40.4 process could in principle rewrite in the same window; that
 * process's own write fence catches the displacement.)
 */
async function reapDeadClaims(judged: JudgedClaim[]): Promise<JudgedClaim[]> {
  const survivors: JudgedClaim[] = [];
  for (const claim of judged) {
    if (claim.liveness !== 'dead') {
      survivors.push(claim);
      continue;
    }
    log.warn(
      `Execution ${claim.record.executionId}: removing the lease of dead pid ${claim.record.owner.pid}`,
    );
    await deleteFiles(claim.files);
  }
  return survivors;
}

async function deleteFiles(files: readonly string[]): Promise<void> {
  for (const file of files) {
    try {
      await StorageFS.delete(file);
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }
}

/** The claim to report when several refuse: a proven-alive owner first. */
function shownClaim(survivors: readonly JudgedClaim[]): JudgedClaim {
  return survivors.find((c) => c.liveness === 'alive') ?? survivors[0]!;
}

function holdOf(claim: JudgedClaim): OwnerHold {
  if (claim.liveness === 'dead') {
    throw new Error(
      `Execution ${claim.record.executionId}: a dead claim cannot hold it.`,
    );
  }
  return ownerHold(claim.record.owner, claim.liveness);
}

function heldBy(survivors: readonly JudgedClaim[]): LeaseHeld {
  return { status: 'active', ...holdOf(shownClaim(survivors)) };
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
 * Unlink this process's own claim file and its legacy shadow, then the
 * directory if it is empty. A file already gone is fine: the claim may have
 * been reclaimed from under this process, and a release must still settle.
 */
async function unlinkOwnClaim(
  executionId: ExecutionId,
  root: string,
  ownerToken: string,
): Promise<void> {
  // The shadow is only this process's while it names this token; a 0.40.4
  // process could have rewritten the path in the meantime.
  const legacy = await readLegacyRecord(executionId, root).catch((error) => {
    log.warn(`Execution ${executionId}: could not read its legacy record`, {
      data: error,
    });
    return undefined;
  });
  await deleteFiles([
    ...(legacy?.ownerToken === ownerToken
      ? [legacyLeasePath(root, executionId)]
      : []),
    claimPath(root, executionId, ownerToken),
  ]);
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
 *    `reapDeadClaims`); an owner that is alive or unprovable refuses the
 *    claim outright.
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
  executionId: ExecutionId,
  root: string,
): Promise<ClaimOutcome> {
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
    const present = await reapDeadClaims(await judgeClaims(executionId, root));
    if (present.length > 0) return heldBy(present);
    const record = ExecutionLeaseSchema.parse({
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
        const others = await reapDeadClaims(
          await judgeClaims(executionId, root, record.ownerToken),
        );
        if (others.length === 0) {
          // COMPATIBILITY SHIM, delete after v0.41 ships: keep a v2 record a
          // 0.40.4 process can see for as long as this claim is held.
          await StorageFS.writeAtomic(
            legacyLeasePath(root, executionId),
            legacyShadowRecord(record),
          );
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
 * The write fence: this process's claim file must still exist before the
 * operation runs. Only an explicit reclaim ever removes another owner's
 * file, so its absence means this process was displaced and must not write.
 */
async function runWithValidatedOwnership<T>(
  lease: OwnedExecutionLease,
  operation: () => Promise<T>,
): Promise<T> {
  if (!(await ownClaimPresent(lease))) {
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
 * `runWithInactiveExecutionLease` and continue directly. A mutation with
 * neither (no production path has one; test fixtures write metadata this
 * way) claims the execution for its own duration, so it is never an
 * unsynchronized check-then-write beside another process.
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
  // Unleased writers in this process take turns, so that two of them never
  // refuse each other over the maintenance claim the first one holds.
  const queue =
    unleasedWriteQueues.get(key) ??
    unleasedWriteQueues.set(key, new PQueue({ concurrency: 1 })).get(key)!;
  const claimed = (await queue.add(() =>
    runWithInactiveExecutionLease(executionId, operation),
  )) as InactiveExecutionLeaseResult<T>;
  if (queue.size === 0 && queue.pending === 0) unleasedWriteQueues.delete(key);
  if (claimed.status === 'active') {
    throw new ExecutionLeaseLostError(executionId);
  }
  return claimed.value;
}

const unleasedWriteQueues = new Map<string, PQueue>();

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
      if (await ownClaimPresent(existingOwnership)) return 'existing';
      forgetOwnedLease(existingOwnership);
    }
  }

  const claim = await claimLease(executionId, root);
  if (claim.status === 'active') {
    throw new ExecutionLeaseActiveError(executionId, claim);
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
    await unlinkOwnClaim(executionId, root, ownership.ownerToken);
  } finally {
    forgetOwnedLease(ownership);
  }
}

/** Classify persisted ownership. Malformed present state rejects deliberately. */
export async function inspectExecutionLease(
  executionId: ExecutionId,
): Promise<ExecutionLeasePresence> {
  const root = storageRoot();
  // Classification mutates nothing: dead claims are reported as orphaned
  // here and unlinked by the next claim instead.
  const judged = await judgeClaims(executionId, root);
  if (judged.length === 0) return { status: 'missing' };
  const local = ownedLeases.get(ownershipKey(root, executionId));
  const own = judged.find((c) => c.record.ownerToken === local?.ownerToken);
  if (own) {
    return {
      status: 'owned',
      acquiredAt: own.record.acquiredAt,
      owner: own.record.owner,
      provable: true,
      reclaimable: false,
    };
  }
  const survivors = judged.filter((c) => c.liveness !== 'dead');
  if (survivors.length === 0) return { status: 'orphaned' };
  const shown = shownClaim(survivors);
  return {
    status: 'foreign',
    acquiredAt: shown.record.acquiredAt,
    ...holdOf(shown),
  };
}

/**
 * Remove every record whose owner is dead or unprovable, so the execution
 * can be claimed again. This is the user's explicit Reclaim action for an
 * owner that cannot be reached; every automatic path keeps refusing such a
 * record. A pid that exists on this host whose identity cannot be read
 * (`unreadable`) counts as alive here: the destructive path must not guess.
 * Only a dead or foreign-host owner is reclaimable, which is exactly what
 * `OwnerHold.reclaimable` promises the user.
 */
export async function reclaimExecutionLease(
  executionId: ExecutionId,
): Promise<'reclaimed' | 'missing' | 'alive'> {
  const root = storageRoot();
  const judged = await judgeClaims(executionId, root);
  if (judged.some((c) => c.liveness !== 'dead' && !holdOf(c).reclaimable)) {
    return 'alive';
  }
  const files = judged.flatMap((c) => c.files);
  if (files.length === 0) return 'missing';
  for (const file of files) {
    log.warn(`Execution ${executionId}: reclaiming lease record ${file}`);
  }
  await deleteFiles(files);
  try {
    await StorageFS.removeEmptyDir(claimDir(root, executionId));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOTEMPTY' && !isFileNotFoundError(error)) throw error;
  }
  return 'reclaimed';
}

/**
 * Run maintenance on an execution nobody alive owns. The maintenance is
 * itself a claim: the record is published for its duration and unlinked
 * afterwards, so a concurrent acquisition sees a live local owner and
 * refuses, and a crash mid-maintenance leaves a record whose dead pid the
 * next claimant unlinks. An owner that is alive or unprovable refuses
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
    if (await ownClaimPresent(local)) {
      // The record names this live process. Report our own identity, not
      // the record's copy, so a tampered owner field cannot misdescribe a
      // live local owner.
      return {
        status: 'active',
        ...ownerHold(await currentLeaseOwner(), 'alive'),
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
