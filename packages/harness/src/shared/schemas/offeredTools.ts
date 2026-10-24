/**
 * The payload of a run history's `tools.offered` arm (`sessionEvent.ts`):
 * what one step of a run offered the model and each tool's identity; and
 * the `context.blob` arm, the one store of the model-facing content those
 * rows and every `attempt` row name by digest.
 */
import { Schema } from 'effect';

import { JsonValueSchema } from './jsonValue';

/* ---------------------------------------------------------- tools.offered */

/** A content address: the sha256 of a value's canonical JSON. */
export const Sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);

/** One offered tool and its identity: a call to it runs only while the tool
 *  the run would dispatch still has this name, digest, plugin and revision. */
const OfferedToolSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  /** sha256 over the canonical JSON of the name and input schema, every
   *  description left out: the identity a call is checked against. */
  digest: Sha256Schema,
  /** The address of the declaration the step's requests send (name,
   *  description and input schema, annotations included), stored as a
   *  `context.blob`. A change records a new offered set; it is not part of
   *  the identity, so it rejects no call. */
  shown: Sha256Schema,
  /** The contributing plugin; `run` for a tool only this run holds. */
  plugin: Schema.String.check(Schema.isMinLength(1)),
  revision: Schema.String.check(Schema.isMinLength(1)),
  /** Whether the step's requests send the model this declaration. False
   *  while script-only tools are on (`GlobalStateKey.SCRIPT_ONLY`) for
   *  every tool but `script` and the run's own: the model reaches it from
   *  inside a script alone. Not part of the identity. */
  sent: Schema.Boolean,
});
export type OfferedTool = typeof OfferedToolSchema.Type;

/**
 * The tools a step offers, in offer order, the plugins whose prompt
 * contributions shape its requests' system text, and that text: the whole
 * set, appended at the step whenever it differs from the one the run's
 * previous step recorded. The latest one is what the run was last offered,
 * which a resume and every call are checked against.
 */
export const ToolsOfferedPayloadSchema = Schema.Struct({
  tools: Schema.Array(OfferedToolSchema),
  /** The names of the skills the step lists, in listing order. */
  skills: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  /** The address of the system text the run's requests send: its base text
   *  with every section as the step that opened the run's context rendered
   *  them, frozen until a compaction opens it again. Null when it sends
   *  none. */
  system: Schema.NullOr(Sha256Schema),
  /** The address of the context the model has been told, its sections by
   *  name and its tools' names (`RunContextSchema`): what a later step
   *  appends to the history as a system message is the change from it. */
  context: Sha256Schema,
  /** The installed plugins' hooks the step pinned, each as
   *  `<plugin>@<trust digest>#<hook>`: a resumed call runs these or none. */
  hooks: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
});

/**
 * What the run's delegation tools can launch: the visible agents, each
 * marked when it is also a task (it holds a plugin's block); the models available for
 * delegation (null when they could not be read); and whether worktrees are
 * on (null when no agent can be launched).
 */
const DelegationTargetsSchema = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1)),
      description: Schema.String,
      tools: Schema.Array(Schema.String),
      task: Schema.Boolean,
    }),
  ),
  models: Schema.NullOr(Schema.Array(Schema.String)),
  worktree: Schema.NullOr(Schema.Boolean),
});
export type DelegationTargets = typeof DelegationTargetsSchema.Type;

/** The context a run's model has been told, as a `tools.offered` row names
 *  it: the sections and the delegation targets its system text renders at
 *  the freeze, and the names of the tools it offers. */
export const RunContextSchema = Schema.Struct({
  sections: Schema.Record(Schema.String, Schema.String),
  tools: Schema.Array(Schema.String),
  delegation: Schema.optional(DelegationTargetsSchema),
});
export type RunContext = typeof RunContextSchema.Type;

/**
 * One piece of model-facing content: a tool declaration, a system text, a
 * resolved agent definition or a request's recorded context. Stored once
 * per run, before the first row that names its digest, and removed only
 * with the run.
 */
export const ContextBlobSchema = Schema.Struct({
  digest: Sha256Schema,
  value: JsonValueSchema,
});

/** Whether two offered tools are the same tool: a call made to one may run
 *  as the other. The shown digest and `sent` are left out. */
export const sameIdentity = (
  a: Omit<OfferedTool, 'shown' | 'sent'>,
  b: Omit<OfferedTool, 'shown' | 'sent'>,
): boolean =>
  a.name === b.name &&
  a.digest === b.digest &&
  a.plugin === b.plugin &&
  a.revision === b.revision;
