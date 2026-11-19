import { Schema } from 'effect';

/**
 * The one id a run has: minted once at launch, assigned
 * at `run.start`, and the key of every fact about that run. Hex: 12 chars
 * when generated, 24 when derived from a checkpoint identity. Branded so a
 * string that was never minted as a run id cannot be passed for one.
 */
export const RunIdSchema = Schema.String.check(Schema.isMinLength(6))
  .check(Schema.isPattern(/^[0-9a-f][-0-9a-f]*$/i))
  .pipe(Schema.brand('RunId'));
export type RunId = typeof RunIdSchema.Type;
/** Whether a string is a run id, as {@link RunIdSchema} reads it. */
export const isRunId = Schema.is(RunIdSchema);

/** Mint a run id: 12 lowercase hex chars (48 bits of entropy), the first
 *  digits of a random UUID, every one of which is random. One of the two
 *  minting sites (`callChildRunId` is the other), so the brand is applied here
 *  and nowhere downstream. Any other random id is `crypto.randomUUID()`. */
export function generateRunId(): RunId {
  // cast: this is a minting site; the value is 12 hex digits by construction.
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12) as RunId;
}

/**
 * A plugin fact's name, `plugin/kind`: the key of every map of a run's facts
 * (`RunView.facts`, its rows' `facts`, the plugins' fact kinds). Built only
 * by {@link factName}, so no reader spells the grammar; the stored kind of a
 * `plugin.fact` row is `plugin.fact/` and this name.
 */
export const FactNameSchema = Schema.String.pipe(Schema.brand('FactName'));
/** {@link FactNameSchema}'s value. */
export type FactName = typeof FactNameSchema.Type;

/** The name of the fact kind `plugin` declares as `kind`. */
export const factName = (fact: {
  readonly plugin: string;
  readonly kind: string;
}): FactName =>
  Schema.decodeUnknownSync(FactNameSchema)(`${fact.plugin}/${fact.kind}`);

/** A content address: the sha256 of a value's canonical JSON. */
export const Sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);
