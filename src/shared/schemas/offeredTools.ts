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
  /** Sorted plugin ids: the section each built-in one adds, and the skills
   *  each ships in the run's catalog (every installed plugin the step
   *  loads). */
  sections: z.array(z.string().min(1)).readonly(),
  /** The address of the system text the step's requests send, the run's
   *  base text with every section rendered: a section reworded by an update
   *  is a new offered set. Null when the run sends none. */
  system: Sha256Schema.nullable(),
});

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
export const sameIdentity = (a: OfferedTool, b: OfferedTool): boolean =>
  a.name === b.name &&
  a.digest === b.digest &&
  a.plugin === b.plugin &&
  a.revision === b.revision;
