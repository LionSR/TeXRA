/**
 * The facts a run's rows carry beside its messages: its input (system text,
 * instruction, activated skills) and what it is bound to.
 * Host-neutral so the run history (`runHistoryEvent.ts`) composes them without reaching the agent
 * layer; the agent modules import them back. The facts read back from those
 * rows are `session/runFacts.ts`.
 */
import { Schema } from 'effect';

import { ACTIVATED_SKILLS_MAX } from './activeSkills';
import { Sha256Schema } from './identifiers';
import { QualifiedSkillNameSchema } from './skillName';
import { DeclinableUsageRouteSchema } from './usage';

// ------------------------------------------------------------ launch facts

/** An attached memory the opening could not read, and why. */
const AttachedMemoryMissSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
});
/** An attached memory the opening could not read ({@link AttachedMemoryMissSchema}). */
export type AttachedMemoryMiss = typeof AttachedMemoryMissSchema.Type;

// ---------------------------------------------------------- model backend

/**
 * The model providers as stored rows name them: a run's backend and the
 * API-key provider a retry offer names (with the coding plans) both read
 * this one list, so a new provider is added once.
 */
export const MODEL_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
  'meta',
] as const;

/**
 * Who serves a run's conversation: the model's own provider, whose plugin
 * names the protocol, or the internal validation model. A run keeps its
 * backend: a resume or a model switch rebinds it, whatever the subscription
 * preferences say now.
 */
export const ModelBackendSchema = Schema.Literals([
  'validation',
  ...MODEL_PROVIDERS,
]);
/** Who serves a run's conversation ({@link ModelBackendSchema}). */
export type ModelBackend = typeof ModelBackendSchema.Type;

// ------------------------------------------------------------ run input

/**
 * What a run's turns answer besides their messages, recorded on the row that
 * changes it: a fresh run's opening `append`, a delivery's `append`, or a
 * fork's seeding `context.edit`. The fold keeps the latest value of each
 * field (`RunState.input`); a row names only what it changes.
 */
export const RunInputSchema = Schema.Struct({
  /** The address of the run's system text, before what each step adds
   *  (`stepInstructions`): a `context.blob` of the run. */
  system: Schema.optional(Sha256Schema),
  /** The address of the instruction the run's latest turn answers, a
   *  `context.blob`; `null` returns to the launch's instruction. */
  instruction: Schema.optional(Schema.NullOr(Sha256Schema)),
  /** The names of the skills the run's user activated: each step resolves
   *  them against its own catalog, and grants one while its plugin, if any,
   *  still contributes. */
  activated: Schema.optional(
    Schema.Array(QualifiedSkillNameSchema).check(
      Schema.isMaxLength(ACTIVATED_SKILLS_MAX),
    ),
  ),
  /** The attached memories the opening could not read. */
  memoryMisses: Schema.optional(Schema.Array(AttachedMemoryMissSchema)),
});
/** What a run's turns answer besides their messages ({@link RunInputSchema}). */
export type RunInput = typeof RunInputSchema.Type;

/**
 * What a run is bound to beyond its model id, recorded on its `run.config`
 * once it binds: the backend a resume or a switch rebinds on, whatever the
 * provider preferences say by then, and the subscription routes it
 * declined. Routes declined by a retry are folded from that retry's
 * decision.
 *
 * `backend` reads as written: a row naming a provider this build no longer
 * has still decodes, so its run stays readable, and the run's next bind
 * refuses it by name (`decideRoute`). What a bind writes is a
 * {@link ModelBackend}, so the stored names only grow with this list.
 */
export const RunBindingSchema = Schema.Struct({
  backend: Schema.String.check(Schema.isMinLength(1)),
  declinedRoutes: Schema.Array(DeclinableUsageRouteSchema),
});
/** What a run is bound to beyond its model id ({@link RunBindingSchema}). */
export type RunBinding = typeof RunBindingSchema.Type;
