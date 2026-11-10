import { Result, Schema } from 'effect';

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
 *  minting sites (`deriveRunId` is the other), so the brand is applied here
 *  and nowhere downstream. Any other random id is `crypto.randomUUID()`. */
export function generateRunId(): RunId {
  // cast: this is a minting site; the value is 12 hex digits by construction.
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12) as RunId;
}

// The aggregate key every durable session event rides on: the kind and
// logical id of the lifecycle it belongs to (`run` by run id, `plugin` by a
// plugin's own key), encoded canonically as JSON so one string names it in
// the event table.

const AggregateKindSchema = Schema.Literals(['run', 'plugin']);
/** The kind separates lifecycles even when their logical ids coincide:
 *  `run` is keyed by the run id, `plugin` (one a plugin owns) `<plugin>:<key>`. */
export type AggregateKind = typeof AggregateKindSchema.Type;
const AggregateKeySchema = Schema.Tuple([
  AggregateKindSchema,
  Schema.String.check(Schema.isMinLength(1)),
]).check(
  Schema.makeFilter(([kind, id]) => kind !== 'run' || isRunId(id), {
    message: 'A run aggregate is keyed by a run id',
  }),
);
const AggregateKeyJsonSchema = Schema.fromJsonString(AggregateKeySchema);
const decodeAggregateKeyJson = Schema.decodeUnknownResult(
  AggregateKeyJsonSchema,
);

/** The canonical JSON encoding of an aggregate kind and its logical id. */
export const AggregateIdSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      Result.match(decodeAggregateKeyJson(value), {
        onSuccess: (key) => JSON.stringify(key) === value,
        onFailure: () => false,
      }),
    { message: 'Expected a canonical [kind, logicalId] aggregate key' },
    true,
  ),
).pipe(Schema.brand('AggregateId'));
/** The key one lifecycle's events ride on in the event table. */
export type AggregateId = typeof AggregateIdSchema.Type;

/** A logical id that is not itself an already-qualified aggregate key: the
 *  brand key `Schema.brand` stamps on an `AggregateId` is refused here. */
export type LogicalId = string & {
  readonly '~effect/Brand'?: { readonly AggregateId?: never };
};

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

/** Qualify a logical id once. An already-qualified key is not an input. */
export function qualifyAggregateId(kind: 'run', logicalId: RunId): AggregateId;
export function qualifyAggregateId(
  kind: Exclude<AggregateKind, 'run'>,
  logicalId: LogicalId,
): AggregateId;
export function qualifyAggregateId(
  kind: AggregateKind,
  logicalId: string,
): AggregateId {
  return Schema.decodeUnknownSync(AggregateIdSchema)(
    JSON.stringify([kind, logicalId]),
  );
}

/** A decoded aggregate key: the `run` arm carries its logical id as a `RunId`. */
type AggregateTarget =
  | { readonly kind: 'run'; readonly id: RunId }
  | { readonly kind: Exclude<AggregateKind, 'run'>; readonly id: string };

/** Decode a validated aggregate key at a logical-id boundary. */
export function aggregateTarget(key: AggregateId): AggregateTarget {
  const [kind, id] = Schema.decodeUnknownSync(AggregateKeyJsonSchema)(key);
  return kind === 'run'
    ? { kind, id: Schema.decodeUnknownSync(RunIdSchema)(id) }
    : { kind, id };
}

/** A content address: the sha256 of a value's canonical JSON. */
export const Sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);
