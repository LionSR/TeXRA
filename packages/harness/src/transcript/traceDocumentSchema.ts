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

/**
 * A parsed trace with each plugin fact checked as the store checks it,
 * against the app's plugin arms (`appArms`): a fact
 * outside its arm's versions (`pluginFactFloor`), or whose value the arm's
 * schema refuses, throws, naming it; one whose plugin this build lacks is
 * left out. A trace is display data and runs no upcaster, so a version an
 * upcaster would bring forward is refused by the schema, never misread.
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
