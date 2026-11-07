import { Result, Schema } from 'effect';

import {
  DisplayRowSchema,
  GOAL_PLAN_KIND,
  RETIRED_PLUGIN_FACTS,
  RunIdSchema,
  unavailableFactReason,
  factName,
  type FactName,
} from '@shared/schemas';

/**
 * One finished run as a static viewer replays it: the run aggregate's own
 * display events in commit order, the same rows the live plane delivers to a
 * subscriber. Nothing is projected on the way out and nothing is
 * reconstructed on the way in.
 *
 * The export authors four facts rather than copying them (`assembleTrace`):
 * no owner, no parent, no checkpoint and no follow-ups taken, because an
 * exported file has no producer, no siblings and no writable host.
 */
export const TraceDocumentSchema = Schema.Struct({
  runId: RunIdSchema,
  events: Schema.Array(DisplayRowSchema),
});

export type TraceDocument = Readonly<typeof TraceDocumentSchema.Type>;

/** A plugin row kind as an imported trace reads it: a `Plugin` fact kind. */
export interface TraceFactKind {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
}

/**
 * A parsed trace with each plugin fact checked as the store checks it,
 * against the harness's built-in fact kind (the goal's plan) and the app's
 * plugin fact kinds (`appFactKinds`). A fact at another version than its
 * kind's, or whose value the kind's schema rejects, throws, naming it, as
 * does a retired built-in fact no current plugin owns; one whose plugin
 * this build lacks is kept as written, marked `unavailable`, as the store
 * reads it.
 */
export function readTraceFacts(
  document: TraceDocument,
  appFactKinds: readonly TraceFactKind[],
): TraceDocument {
  const factKinds = new Map(
    [GOAL_PLAN_KIND, ...appFactKinds].map(
      (factKind): [FactName, TraceFactKind] => [factName(factKind), factKind],
    ),
  );
  const events = document.events.map((event) => {
    if (event.type !== 'plugin.fact') return event;
    // The exporting build's reason is not this build's.
    const { unavailable: _unavailable, ...fact } = event;
    const name = factName(fact);
    const factKind = factKinds.get(name);
    if (factKind === undefined && RETIRED_PLUGIN_FACTS.has(name))
      throw new Error(
        `the plugin fact ${name} was written by an earlier build; this build no longer reads it.`,
      );
    if (factKind === undefined)
      return { ...fact, unavailable: unavailableFactReason(fact) };
    if (fact.version !== factKind.version)
      throw new Error(
        `the plugin fact ${name} is at version ${fact.version}; this build reads ${factKind.version}.`,
      );
    const parsed = Schema.decodeUnknownResult(factKind.schema)(fact.value);
    if (Result.isFailure(parsed))
      throw new Error(
        `the plugin fact ${name} does not match its schema:\n${parsed.failure.message}`,
      );
    return fact;
  });
  return { ...document, events };
}
