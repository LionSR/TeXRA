/**
 * THE canonical round-indexed representation: `{ [round: number]: T[] }`.
 *
 * One shape for every round-scoped collection (output files, missing-output
 * paths, compile failures) across the live stream state, progress events,
 * webview messages, snapshots, and the persisted `streamData/{id}/*.json`
 * sidecars — the record is the JSON wire/disk format itself, so no encode
 * step exists anywhere. Legacy persisted shapes are absorbed ONCE, here, at
 * {@link parsePersistedRoundIndexed}; downstream code only ever sees the
 * canonical record.
 *
 * Deliberately NOT unified into this shape (different requirements, not
 * history): `RoundOutput[]` (a per-round aggregate carrying `rawOutput` and
 * `xmlSummary`, owned by the reflection flow) and `DiffResult.baseRound` /
 * `revisedRound` (scalar round references, already legacy-normalized at their
 * own parse entry in `diffResult.ts`).
 */

import { z } from 'zod';

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
 * a structural invariant, not just a naming convention. Enforced once, here,
 * at parse time (see {@link RoundKeyStringSchema}, used by both
 * {@link roundIndexedRecord} and {@link parsePersistedRoundIndexed}'s flat
 * arm), so downstream code never re-checks it.
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
 * number. The SAME predicate — not a parallel regex — backs both
 * {@link roundIndexedRecord}'s key schema and {@link
 * parsePersistedRoundIndexed}'s flat-arm key schema, so a key like `"1e5"`
 * (scientific notation, which `RoundKeySchema` coerces to round `100000`) is
 * accepted or rejected identically by every round-indexed record schema in
 * the codebase instead of drifting between a strict `/^\d+$/`-style regex in
 * one place and the looser numeric coercion in another.
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
// Persisted-file parse entry (single legacy-absorbing entry point)
// ============================================================================

function warnDroppedItem(
  kind: string,
  error: { issues: readonly { path: PropertyKey[]; message: string }[] },
): void {
  console.warn(
    `[roundIndexed] Dropping malformed ${kind} entry: ${error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')}`,
  );
}

/**
 * Pick one run's round-keyed record out of the legacy nested shape. Prefers
 * `preferredRunId` when that entry exists (legacy tabs persisted `activeRunId`
 * in meta.json to mark the selected run); otherwise falls back to JS insertion
 * order and picks the last-written run.
 */
function pickLegacyRun(
  raw: Record<string, unknown>,
  preferredRunId?: string | null,
): Record<string, unknown> {
  if (preferredRunId) {
    const picked = raw[preferredRunId];
    if (picked && typeof picked === 'object' && !Array.isArray(picked)) {
      return picked as Record<string, unknown>;
    }
  }
  const latest = Object.values(raw).findLast(
    (value) =>
      value != null && typeof value === 'object' && !Array.isArray(value),
  );
  return (latest as Record<string, unknown> | undefined) ?? {};
}

export interface PersistedRoundIndexed<T> {
  rounds: RoundIndexed<T>;
  /** True when the on-disk file held the legacy nested shape (the caller
   *  rewrites it flat once so the conversion never re-runs). */
  wasLegacy: boolean;
}

/**
 * Parse a persisted round-indexed sidecar file (`outputFiles.json`,
 * `missingOutputs.json`, `compileFailures.json`) into the canonical record.
 *
 * Canonical flat shape first; the legacy nested `{ runId: { round: items[] } }`
 * shape (from before the one-run-per-tab refactor, #3061) transforms into it
 * via the union's legacy arm — handled here ONCE, never at call sites.
 * Ledger: the legacy arm retires with the other #3061-era read shims after
 * 2026-08-04 (D3), tracked in #6981.
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
  preferredRunId?: string | null,
): PersistedRoundIndexed<T> {
  if (raw === undefined) return { rounds: {}, wasLegacy: false };

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

  // Canonical flat shape: every key a valid round (per RoundKeyStringSchema —
  // the SAME predicate RoundKeySchema itself uses, so e.g. "1e5" is accepted
  // or rejected identically here and in `toRounds` below), every value an
  // array. The key/value constraints make this arm REJECT legacy input (a
  // runId key, or a numeric-only runId whose value is a nested object),
  // routing it to the legacy arm — mirroring the old `isLegacyNested`
  // predicate.
  const FlatArmSchema = z
    .record(RoundKeyStringSchema, z.array(z.unknown()))
    .transform((record): PersistedRoundIndexed<T> => ({
      rounds: toRounds(record),
      wasLegacy: false,
    }));

  const LegacyNestedArmSchema = z
    .record(z.string(), z.unknown())
    .transform((record): PersistedRoundIndexed<T> => ({
      rounds: toRounds(pickLegacyRun(record, preferredRunId)),
      wasLegacy: true,
    }));

  const result = z.union([FlatArmSchema, LegacyNestedArmSchema]).safeParse(raw);
  if (!result.success) {
    console.warn(
      `[roundIndexed] Ignoring malformed ${kind} (not a round-keyed record); treating as empty.`,
    );
    return { rounds: {}, wasLegacy: false };
  }
  return result.data;
}
