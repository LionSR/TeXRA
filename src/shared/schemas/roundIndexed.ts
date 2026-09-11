/**
 * THE canonical round-indexed representation: `{ [round: number]: T[] }`.
 *
 * One shape for every round-scoped collection (output files, missing-output
 * paths, compile failures) across the live stream state, progress events,
 * webview messages, and snapshots — the record is the JSON wire/disk format
 * itself, so no encode step exists anywhere.
 *
 * Deliberately NOT unified into this shape (different requirements, not
 * history): `RoundOutput[]` (a per-round aggregate carrying `rawOutput`,
 * owned by the reflection flow) and `DiffResult.baseRound` /
 * `revisedRound` (scalar round references, parsed at their own entry in
 * `diffResult.ts`).
 */

import { z } from 'zod';

/**
 * Round number → items for that round. Runtime keys are strings (JSON), so a
 * `Record<string, T[]>` (e.g. a parsed {@link roundIndexedRecord}) is
 * assignable to this type; index it with a number.
 */
export type RoundIndexed<T> = { [round: number]: T[] };

/**
 * A caller-visible view of a {@link RoundIndexed} record: the same shape, with
 * mutation closed off at the type level.
 *
 * Store accessors hand this back instead of a defensive copy. Every reader
 * only enumerates, filters, or forwards these records, so the copy bought
 * nothing at runtime while allocating a fresh object and a fresh array per
 * round on every call — on each render pass, for every host. The write path
 * still snapshots with {@link cloneRoundIndexed}, where the isolation is real:
 * writes are queued, so the record must be frozen at call time.
 */
export type ReadonlyRoundIndexed<T> = {
  readonly [round: number]: readonly T[];
};

/**
 * A round number's canonical string spelling, `String(round)`: decimal digits
 * with no sign, whitespace, fraction, exponent, radix prefix or leading zero
 * (except `"0"` itself), whose value is a safe integer. Canonical spelling
 * makes key ↔ round a bijection, and the safe-integer bound keeps it one after
 * `Number(key)`: beyond `Number.MAX_SAFE_INTEGER` distinct keys collapse onto
 * one number, so one round would overwrite another.
 */
const RoundKeyStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'Round key must be a canonical round number')
  .refine((key) => Number.isSafeInteger(Number(key)), {
    message: 'Round key must be a safe integer',
  });

/**
 * Parses a round number out of a string (a filename's `_r{n}` capture): the
 * string must be a canonical round key (see {@link RoundKeyStringSchema}).
 */
export const RoundKeySchema = RoundKeyStringSchema.transform(Number);

/**
 * Scalar round-number schema: the single definition shared by round-indexed
 * collections' own item fields (`OutputFileInfo.round`, `RoundOutput.round`,
 * `CompileResult.round`) and by round-POINTER fields that reference a round
 * without holding a per-round collection (`DiffResult.baseRound` /
 * `revisedRound` in `diffResult.ts`). Those pointer fields are a genuinely
 * different concept from {@link RoundIndexed} — "which round does this diff
 * compare" rather than "items grouped by round" — so they are not folded into
 * the record container, but they still mean the same "this integer is a
 * round number" (non-negative integer, matching {@link RoundKeySchema}) and
 * now share one schema instead of a repeated `z.number()`.
 */
export const RoundNumberSchema = z.int().nonnegative();

/**
 * Schema factory for the canonical record: `{ "0": T[], "1": T[], … }`.
 * Callers attach their own field policy (`.prefault({})`, `.optional()`).
 * Keys must be canonical round keys ({@link RoundKeyStringSchema}, the same
 * definition {@link RoundKeySchema} parses), so a validated record enumerates
 * in ascending round order per the ES2015+ integer-key rule and no two keys
 * name the same round.
 */
export function roundIndexedRecord<T extends z.ZodType>(valueSchema: T) {
  return z.record(RoundKeyStringSchema, z.array(valueSchema));
}

/**
 * Entries with numeric round keys, ascending by round. Prefer plain
 * `Object.entries()`/`Object.values()` when the record is already known to
 * come from a schema-validated {@link RoundIndexed} (its keys already
 * enumerate in ascending order per spec); reach for this when a caller wants
 * `[round, items]` pairs rather than the enumeration order itself, or is
 * handling a record that was not necessarily schema-validated.
 */
export function roundIndexedEntries<T>(
  rounds: ReadonlyRoundIndexed<T>,
): [number, readonly T[]][] {
  return Object.entries(rounds)
    .map(([round, items]): [number, readonly T[]] => [Number(round), items])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Deep-enough copy: a fresh record with a fresh array per round, so a caller
 * that mutates the returned value — including pushing into one of its
 * per-round arrays — can never corrupt an internal accumulator that still
 * holds the original arrays by reference. Item objects themselves are not
 * cloned; they are treated as immutable value objects, same as every other
 * schema-derived type in this codebase.
 */
export function cloneRoundIndexed<T>(
  rounds: ReadonlyRoundIndexed<T> | undefined,
): RoundIndexed<T> {
  const clone: RoundIndexed<T> = {};
  if (!rounds) return clone;
  for (const [round, items] of Object.entries(rounds)) {
    clone[Number(round)] = [...items];
  }
  return clone;
}

/**
 * The rounds that hold something. A producer publishes its whole map, so the
 * fold takes the map as it is; a round with nothing in it is not a round any
 * tab shows, so files and compile failures drop it. Missing outputs keep
 * their empty rounds, which mean "checked, nothing missing".
 */
export function nonEmptyRounds<T>(rounds: RoundIndexed<T>): RoundIndexed<T> {
  const next: RoundIndexed<T> = {};
  for (const key of Object.keys(rounds)) {
    const round = Number(key);
    const items = rounds[round];
    if (items.length > 0) next[round] = items;
  }
  return next;
}
