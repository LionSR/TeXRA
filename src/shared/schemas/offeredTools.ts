/**
 * The payload of a run ledger's `tools.offered` arm (`sessionEvent.ts`):
 * what one step of a run offered the model, and each tool's identity.
 */
import { z } from 'zod';

/* ---------------------------------------------------------- tools.offered */

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One offered tool and its identity: a call to it runs only while the tool
 *  the run would dispatch still has this name, digest, plugin and revision. */
const OfferedToolSchema = z.strictObject({
  name: z.string().min(1),
  /** sha256 over the canonical JSON of the name and input schema, every
   *  description left out: the identity a call is checked against. */
  digest: Sha256Schema,
  /** sha256 over the definition as the catalog shows it, descriptions
   *  included, before per-run annotation. A change records a new offered
   *  set; it is not part of the identity, so it rejects no call. */
  shown: Sha256Schema,
  /** The contributing plugin; `run` for a tool only this run holds. */
  plugin: z.string().min(1),
  revision: z.string().min(1),
});
export type OfferedTool = z.infer<typeof OfferedToolSchema>;

/**
 * The tools a step offers, in offer order: the whole set, appended before
 * the step's model request whenever it differs from the set the run's
 * previous request was offered. The latest one is what the run was last
 * offered, which a resume and every call are checked against.
 */
export const ToolsOfferedPayloadSchema = z.strictObject({
  tools: z.array(OfferedToolSchema).readonly(),
});

/** Whether two offered tools are the same tool: a call made to one may run
 *  as the other. The shown digest is left out. */
export const sameIdentity = (a: OfferedTool, b: OfferedTool): boolean =>
  a.name === b.name &&
  a.digest === b.digest &&
  a.plugin === b.plugin &&
  a.revision === b.revision;
