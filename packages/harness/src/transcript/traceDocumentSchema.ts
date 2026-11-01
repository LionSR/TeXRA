import { Result, Schema } from 'effect';

import {
  DisplaySessionEventSchema,
  GOAL_PLAN_KIND,
  pluginFactFloor,
  RunIdSchema,
} from '@shared/schemas';

/**
 * One finished run as a static viewer replays it: the run aggregate's own
 * display events in commit order, the same rows the live plane delivers to a
 * subscriber. Nothing is projected on the way out and nothing is
 * reconstructed on the way in.
 *
 * The export authors four facts rather than copying them (`assembleTrace`):
 * no owner, no parent, no checkpoint and no follow-up support, because an
 * exported file has no producer, no siblings and no writable host.
 */
export const TraceDocumentSchema = Schema.Struct({
  runId: RunIdSchema,
  events: Schema.Array(DisplaySessionEventSchema),
});

export type TraceDocument = Readonly<typeof TraceDocumentSchema.Type>;

/** A plugin row kind as an imported trace reads it: a `Plugin` fact kind. */
export interface TraceFactKind {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
  readonly upcasters: readonly unknown[];
}

/** Plugin facts a built-in plugin wrote before this build retired them:
 *  a trace that holds one is from an earlier build, rejected, not stripped. */
const RETIRED_FACTS: ReadonlySet<string> = new Set(['goal/state']);

/**
 * A parsed trace with each plugin fact checked as the store checks it,
 * against the harness's built-in fact kind (the goal's plan) and the app's
 * plugin fact kinds (`appFactKinds`). A fact outside its kind's versions
 * (`pluginFactFloor`), or whose value the kind's schema rejects, throws, naming it, as does a
 * retired built-in fact no current plugin owns; one whose plugin this build
 * lacks is left out. A trace is display data and runs no upcaster, so a
 * version an upcaster would bring forward is rejected by the schema, never
 * misread.
 */
export function readTraceFacts(
  document: TraceDocument,
  appFactKinds: readonly TraceFactKind[],
): TraceDocument {
  const factKinds = new Map(
    [GOAL_PLAN_KIND, ...appFactKinds].map(
      (factKind): [string, TraceFactKind] => [
        `${factKind.plugin}/${factKind.kind}`,
        factKind,
      ],
    ),
  );
  const events = document.events.filter((event) => {
    if (event.type !== 'plugin.fact') return true;
    const name = `${event.plugin}/${event.kind}`;
    const factKind = factKinds.get(name);
    if (factKind === undefined && RETIRED_FACTS.has(name))
      throw new Error(
        `the plugin fact ${name} was written by an earlier build; this build no longer reads it.`,
      );
    if (factKind === undefined) return false;
    if (
      event.version < pluginFactFloor(factKind) ||
      event.version > factKind.version
    )
      throw new Error(
        `the plugin fact ${name} is at version ${event.version}; this build reads ${pluginFactFloor(factKind)} to ${factKind.version}.`,
      );
    const parsed = Schema.decodeUnknownResult(factKind.schema)(event.value);
    if (Result.isFailure(parsed))
      throw new Error(
        `the plugin fact ${name} does not match its schema:\n${parsed.failure.message}`,
      );
    return true;
  });
  return { ...document, events };
}
