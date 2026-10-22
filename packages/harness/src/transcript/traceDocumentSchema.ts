import { z } from 'zod';

import {
  DisplaySessionEventSchema,
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
export const TraceDocumentSchema = z.object({
  runId: RunIdSchema,
  events: z.array(DisplaySessionEventSchema),
});

export type TraceDocument = Readonly<z.infer<typeof TraceDocumentSchema>>;

/** A plugin row kind as an imported trace reads it: a `Plugin` arm. */
export interface TraceFactArm {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: z.ZodType;
  readonly upcasters: readonly unknown[];
}

/** Plugin facts a built-in plugin wrote before this build retired them:
 *  a trace that holds one is from an earlier build, rejected, not stripped. */
const RETIRED_FACTS: ReadonlySet<string> = new Set(['goal/state']);

/**
 * A parsed trace with each plugin fact checked as the store checks it,
 * against the app's plugin arms (`appArms`): a fact
 * outside its arm's versions (`pluginFactFloor`), or whose value the arm's
 * schema rejects, throws, naming it, as does a retired built-in fact no
 * current plugin owns;
 * one whose plugin this build lacks is left out. A trace is display data and runs no upcaster, so a version an
 * upcaster would bring forward is rejected by the schema, never misread.
 */
export function readTraceFacts(
  document: TraceDocument,
  appArms: readonly TraceFactArm[],
): TraceDocument {
  const arms = new Map(
    appArms.map((arm): [string, TraceFactArm] => [
      `${arm.plugin}/${arm.kind}`,
      arm,
    ]),
  );
  const events = document.events.filter((event) => {
    if (event.type !== 'plugin.fact') return true;
    const name = `${event.plugin}/${event.kind}`;
    const arm = arms.get(name);
    if (arm === undefined && RETIRED_FACTS.has(name))
      throw new Error(
        `the plugin fact ${name} was written by an earlier build; this build no longer reads it.`,
      );
    if (arm === undefined) return false;
    if (event.version < pluginFactFloor(arm) || event.version > arm.version)
      throw new Error(
        `the plugin fact ${name} is at version ${event.version}; this build reads ${pluginFactFloor(arm)} to ${arm.version}.`,
      );
    const parsed = arm.schema.safeParse(event.value);
    if (!parsed.success)
      throw new Error(
        `the plugin fact ${name} does not match its schema:\n${z.prettifyError(parsed.error)}`,
      );
    return true;
  });
  return { ...document, events };
}
