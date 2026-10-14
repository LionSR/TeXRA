/**
 * Runtime validation for trace data loaded from `trace.json` or
 * `window.__TEXRA_TRACE__`. `TraceDocumentSchema` owns the format: a document
 * written by an older export fails the parse loudly below rather than being
 * normalized, and so does a plugin fact at a version this build does not
 * read (`pluginFactFloor`, the store's own rule). A fact whose plugin this
 * build lacks is left out, as the store leaves it out.
 */
import { z } from 'zod';

import { pluginFactFloor } from '@shared/schemas';
import { APP_PLUGIN_ARMS } from '@texra/shared/plugins/appArms';
import {
  TraceDocumentSchema,
  type TraceDocument,
} from '@transcript/traceDocumentSchema';

const INCOMPATIBLE =
  'Trace data does not match the expected schema — this trace file may ' +
  'have been exported by an incompatible TeXRA version:\n';

const ARMS = new Map(
  Object.values(APP_PLUGIN_ARMS)
    .flat()
    .map((arm) => [`${arm.plugin}/${arm.kind}`, arm]),
);

/** Parse an exported trace before replaying it through the trusted UI path. */
export function parseTraceData(raw: unknown): TraceDocument {
  const result = TraceDocumentSchema.safeParse(raw);
  if (!result.success)
    throw new Error(INCOMPATIBLE + z.prettifyError(result.error));
  const events = result.data.events.filter((event) => {
    if (event.type !== 'plugin.fact') return true;
    const name = `${event.plugin}/${event.kind}`;
    const arm = ARMS.get(name);
    if (arm === undefined) return false;
    if (event.version < pluginFactFloor(arm) || event.version > arm.version)
      throw new Error(
        `${INCOMPATIBLE}the plugin fact ${name} is at version ${event.version}; this build reads ${pluginFactFloor(arm)} to ${arm.version}.`,
      );
    return true;
  });
  return { ...result.data, events };
}
