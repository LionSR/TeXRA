/**
 * THE canonical round-indexed representation: `{ [round: number]: T[] }`.
 *
 * One shape for every round-scoped collection (output files, missing-output
 * paths, compile failures) across the live stream state, progress events,
 * webview messages, snapshots, and the persisted `streamData/{id}/*.json`
 * sidecars — the record is the JSON wire/disk format itself, so no encode
 * step exists anywhere.
 *
 * Deliberately NOT unified into this shape (different requirements, not
 * history): `RoundOutput[]` (a per-round aggregate carrying `rawOutput`,
 * owned by the reflection flow) and `DiffResult.baseRound` /
 * `revisedRound` (scalar round references, parsed at their own entry in
 * `diffResult.ts`).
 */

import { z } from 'zod';

import { formatZodIssuesMessage } from './toolResult';

/**
 * Round number → items for that round. Runtime keys are strings (JSON), so a
 * `Record<string, T[]>` (e.g. a parsed {@link roundIndexedRecord}) is
 * assignable to this type; index it with a number.
 */
export type RoundIndexed<T> = { [round: number]: T[] };

/**
 * Coerces and validates round keys from string record keys: non-negative
 * safe integers only. Rounds never go negative (round 0 is the first), and
 * every consumer that reads a `RoundIndexed<T>` record via plain
 * `Object.keys()`/`for...in` enumeration (rather than {@link
 * roundIndexedEntries}) relies on the ES2015+ spec guarantee that
 * non-negative-integer-string keys enumerate in ascending numeric order —
 * that guarantee does NOT hold for negative or non-integer keys, so this is
 * a structural invariant, not just a naming convention. Canonical record
 * schemas enforce it through {@link RoundKeyStringSchema}; the persisted-file
 * parser applies this schema directly while salvaging individual keys.
 */
export const RoundKeySchema = z.coerce.number().int().nonnegative();

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
 * A JSON object key that {@link RoundKeySchema} can coerce to a valid round
 * number. It is derived from the same schema that
 * {@link parsePersistedRoundIndexed} applies directly to each salvaged key,
 * so a key like `"1e5"` (scientific notation, which `RoundKeySchema` coerces
 * to round `100000`) is accepted or rejected identically by canonical record
 * schemas and persisted-file parsing instead of drifting between a strict
 * `/^\d+$/`-style regex in one place and looser numeric coercion in another.
 */
export const RoundKeyStringSchema = z
  .string()
  .refine((key) => RoundKeySchema.safeParse(key).success, {
    message: 'Round key must be a non-negative integer',
  });

/**
 * Schema factory for the canonical record: `{ "0": T[], "1": T[], … }`.
 * Trusted-input role (IPC messages, live state, snapshots): callers attach
 * their own field policy (`.prefault({})`, `.optional()`). Untrusted persisted
 * files go through {@link parsePersistedRoundIndexed} instead. Keys are
 * validated against {@link RoundKeyStringSchema} so every consumer of a
 * parsed record can rely on the ascending-iteration-order invariant.
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
  rounds: RoundIndexed<T>,
): [number, T[]][] {
  return Object.entries(rounds)
    .map(([round, items]): [number, T[]] => [Number(round), items])
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
  rounds: RoundIndexed<T> | undefined,
): RoundIndexed<T> {
  const clone: RoundIndexed<T> = {};
  if (!rounds) return clone;
  for (const [round, items] of Object.entries(rounds)) {
    clone[Number(round)] = [...items];
  }
  return clone;
}

// ============================================================================
// Persisted-file parse entry
// ============================================================================

function warnDroppedItem(
  kind: string,
  error: { issues: readonly { path: PropertyKey[]; message: string }[] },
): void {
  console.warn(
    `[roundIndexed] Dropping malformed ${kind} entry: ${formatZodIssuesMessage(error.issues)}`,
  );
}

/**
 * Parse a persisted round-indexed sidecar file (`outputFiles.json`,
 * `missingOutputs.json`, `compileFailures.json`) into the canonical record.
 *
 * Salvage semantics: round keys are coerced integers (anything else is
 * skipped), malformed items are dropped LOUDLY (warned, never silently
 * swallowed), empty rounds are omitted, and a genuinely corrupt top-level
 * value degrades to an empty record with a warning. A missing file
 * (`undefined`) is silently empty. Every failure path returns a FRESH object:
 * consumers (e.g. `StreamSnapshotStore`) hold the result by reference and
 * mutate it, so a shared fallback instance would leak rounds across streams.
 */
export function parsePersistedRoundIndexed<T>(
  kind: string,
  raw: unknown,
  itemSchema: z.ZodType<T>,
): RoundIndexed<T> {
  if (raw === undefined) return {};

  const toRounds = (record: Record<string, unknown>): RoundIndexed<T> => {
    const rounds: RoundIndexed<T> = {};
    for (const [key, value] of Object.entries(record)) {
      const round = RoundKeySchema.safeParse(key);
      if (!round.success) continue;
      if (!Array.isArray(value)) {
        console.warn(
          `[roundIndexed] Dropping non-array round "${key}" in ${kind}.`,
        );
        continue;
      }
      const items = value.flatMap((item) => {
        const parsed = itemSchema.safeParse(item);
        if (parsed.success) return [parsed.data];
        warnDroppedItem(kind, parsed.error);
        return [];
      });
      if (items.length > 0) rounds[round.data] = items;
    }
    return rounds;
  };

  const result = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!result.success) {
    console.warn(
      `[roundIndexed] Ignoring malformed ${kind} (not a round-keyed record); treating as empty.`,
    );
    return {};
  }
  return toRounds(result.data);
}
