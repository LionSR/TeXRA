/**
 * The payload of a run ledger's `tools.offered` arm (`sessionEvent.ts`):
 * what one step of a run offered the model, each tool's identity, and the
 * continuation the step pinned; and the `context.blob` arm, the one store of
 * the model-facing content those rows and every `attempt` row name by digest.
 */
import { z } from 'zod';

import { JsonValueSchema } from './jsonValue';

/* ---------------------------------------------------------- tools.offered */

/** A content address: the sha256 of a value's canonical JSON. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One offered tool and its identity: a call to it runs only while the tool
 *  the run would dispatch still has this name, digest, plugin and revision. */
const OfferedToolSchema = z.strictObject({
  name: z.string().min(1),
  /** sha256 over the canonical JSON of the name and input schema, every
   *  description left out: the identity a call is checked against. */
  digest: Sha256Schema,
  /** The address of the declaration the step's requests send (name,
   *  description and input schema, annotations included), stored as a
   *  `context.blob`. A change records a new offered set; it is not part of
   *  the identity, so it rejects no call. */
  shown: Sha256Schema,
  /** The contributing plugin; `run` for a tool only this run holds. */
  plugin: z.string().min(1),
  revision: z.string().min(1),
});
export type OfferedTool = z.infer<typeof OfferedToolSchema>;

/**
 * The tools a step offers, in offer order, the plugin whose continuation
 * decides what the run does when it parks (null: it parks), the plugins
 * whose prompt contributions shape its requests' system text, and that
 * text: the whole set, appended at the step whenever it differs from the one
 * the run's previous step recorded. The latest one is what the run was last
 * offered, which a resume and every call are checked against.
 */
export const ToolsOfferedPayloadSchema = z.strictObject({
  tools: z.array(OfferedToolSchema).readonly(),
  continuation: z.string().min(1).nullable(),
  /** The names of the skills the step lists, in listing order. */
  skills: z.array(z.string().min(1)).readonly(),
  /** The address of the system text the run's requests send: its base text
   *  with every section as the step that opened the run's context rendered
   *  them, frozen until a compaction opens it again. Null when it sends
   *  none. */
  system: Sha256Schema.nullable(),
  /** The address of the context the model has been told, its sections by
   *  name and its tools' names (`RunContextSchema`): what a later step
   *  appends to the history as a system message is the change from it. */
  context: Sha256Schema,
  /** The installed plugins' hooks the step pinned, each as
   *  `<plugin>@<trust digest>#<hook>`: a resumed call runs these or none. */
  hooks: z.array(z.string().min(1)).readonly(),
});

/** The context a run's model has been told, as a `tools.offered` row names
 *  it. */
export const RunContextSchema = z.strictObject({
  sections: z.record(z.string(), z.string()),
  tools: z.array(z.string()),
});
export type RunContext = z.infer<typeof RunContextSchema>;

/**
 * One piece of model-facing content: a tool declaration, a system text, a
 * resolved agent definition or a request's recorded context. Stored once
 * per run, before the first row that names its digest, and removed only
 * with the run.
 */
export const ContextBlobSchema = z.strictObject({
  digest: Sha256Schema,
  value: JsonValueSchema,
});

/** Whether two offered tools are the same tool: a call made to one may run
 *  as the other. The shown digest is left out. */
export const sameIdentity = (
  a: Omit<OfferedTool, 'shown'>,
  b: Omit<OfferedTool, 'shown'>,
): boolean =>
  a.name === b.name &&
  a.digest === b.digest &&
  a.plugin === b.plugin &&
  a.revision === b.revision;
