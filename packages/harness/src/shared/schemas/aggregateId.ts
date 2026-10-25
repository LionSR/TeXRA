/**
 * The aggregate key every durable session event rides on: the kind and
 * logical id of the lifecycle it belongs to (`run` by run id, `plugin` by a
 * plugin's own key), encoded canonically as JSON so one string names it in
 * the event table, and the process identity that holds a claim on it.
 */
import { Result, Schema } from 'effect';

import { parseJsonWith } from '@common/parsing/safeParseJson';

import { RunIdSchema, isRunId, type RunId } from './identifiers';

/** The complete process identity, encoded canonically without losing null. */
const OwnerIdentitySchema = Schema.Tuple([
  Schema.String.check(Schema.isMinLength(1)),
  Schema.Int.check(Schema.isGreaterThan(0)),
  Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
]);

/**
 * JSON.stringify([hostname.toLowerCase(), pid, processStart]). Host identity
 * is necessary: a missing local pid cannot prove a foreign process dead.
 */
export const OwnerIdSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      Result.match(parseJsonWith(value, OwnerIdentitySchema), {
        onSuccess: (identity) =>
          identity[0] === identity[0].toLowerCase() &&
          JSON.stringify(identity) === value,
        onFailure: () => false,
      }),
    {
      message:
        'Expected a canonical [hostname, pid, processStart] process identity',
    },
  ),
);
export type OwnerId = typeof OwnerIdSchema.Type;

/** Decode an owner already validated at the event or transport boundary. */
export function ownerIdentity(ownerId: OwnerId): {
  hostname: string;
  pid: number;
  processStart: string | null;
} {
  const [hostname, pid, processStart] = JSON.parse(
    ownerId,
  ) as (typeof OwnerIdentitySchema)['Type'];
  return { hostname, pid, processStart };
}

/** The recorded pid shown when another process holds a run. */
export function ownerPid(ownerId: OwnerId): number {
  return ownerIdentity(ownerId).pid;
}

/**
 * A verdict about an owner is a proof or an admission that no proof exists.
 * `unprovable` means "do not touch automatically": every acquire path treats
 * it exactly like `alive`, and the user sees the aggregate as held. The
 * user's explicit deletion of the run is the one path that reaps it.
 */
export type OwnerLiveness = 'alive' | 'dead' | 'unprovable';

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

/** The canonical JSON encoding of an aggregate kind and its logical id. */
export const AggregateIdSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      Result.match(parseJsonWith(value, AggregateKeySchema), {
        onSuccess: (key) => JSON.stringify(key) === value,
        onFailure: () => false,
      }),
    { message: 'Expected a canonical [kind, logicalId] aggregate key' },
    true,
  ),
).pipe(Schema.brand('AggregateId'));
export type AggregateId = typeof AggregateIdSchema.Type;

/** A logical id that is not itself an already-qualified aggregate key: the
 *  brand key `Schema.brand` stamps on an `AggregateId` is refused here. */
export type LogicalId = string & {
  readonly '~effect/Brand'?: { readonly AggregateId?: never };
};

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
export type AggregateTarget =
  | { readonly kind: 'run'; readonly id: RunId }
  | { readonly kind: Exclude<AggregateKind, 'run'>; readonly id: string };

/** Decode a validated aggregate key at a logical-id boundary. */
export function aggregateTarget(key: AggregateId): AggregateTarget {
  const [kind, id] = JSON.parse(key) as typeof AggregateKeySchema.Type;
  return kind === 'run'
    ? { kind, id: Schema.decodeUnknownSync(RunIdSchema)(id) }
    : { kind, id };
}
