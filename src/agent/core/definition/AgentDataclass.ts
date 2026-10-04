import { z } from 'zod';

import {
  AgentNameSchema,
  ToolDefinitionSchema,
  type ToolDefinition,
} from '@shared/schemas';

/**
 * Tool reference: a YAML name, parsed here into the bare `{ name }` entry
 * whose contract (description, parameters) the registry applies once per run
 * in `resolveStepTools`; or, for definitions registered as values rather
 * than YAML, a whole tool definition, which may carry runtime-only fields no
 * YAML can express.
 */
const ToolsSchema = z.array(
  z.union([
    z.string().transform((name): ToolDefinition => ({ name })),
    ToolDefinitionSchema,
  ]),
);

/** A persona's sampling temperature; the model's own range is narrower. */
const TemperatureSchema = z.number().min(0).max(1);

/**
 * A persona: a model agent, its system prompt (Nunjucks) with the tools it
 * is offered. A persona that declares no tools works text-only. The user's
 * task is the user message, so a persona has no request template.
 */
export const PersonaSchema = z.strictObject({
  prompt: z.string().prefault(''),
  tools: ToolsSchema.prefault([]),
  temperature: TemperatureSchema.prefault(1.0),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * A document task: what the documents recipe runs over its persona. Each
 * request (Nunjucks) opens one revision, in order, after the `prefix` that
 * lays out the documents; `outputs` are the files a task writes when the
 * launch names none, and `files` binds template variables to files beside
 * the YAML (`X` renders as `X_FILE` and `X_CONTENT`).
 */
export const DocumentTaskSchema = z.strictObject({
  /** Edits existing documents (diffed against them), rather than writing
   *  new ones. */
  rewrite: z.boolean().prefault(true),
  outputs: z.array(z.string()).prefault([]),
  files: z.record(z.string(), z.string()).prefault({}),
  prefix: z.string().prefault(''),
  requests: z.array(z.string()).min(1, 'a task needs at least one request'),
});
export type DocumentTask = z.infer<typeof DocumentTaskSchema>;

/** A document task as a file writes it, before inheritance and defaults. */
const DocumentTaskInputSchema = z.strictObject({
  rewrite: z.boolean().optional(),
  outputs: z.array(z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  prefix: z.string().optional(),
  requests: z.array(z.string()).optional(),
});

/**
 * An agent file as written: a flat persona, made a document task by its
 * `task` block. Optional fields stay unmaterialized so `inherits` can tell
 * "not written" from "written as the default".
 */
export const AgentDefinitionSchema = z.strictObject({
  name: AgentNameSchema,
  description: z.string().optional(),
  inherits: z.string().optional(),
  /**
   * On a customized copy of a bundled agent: the digest of the bundled file it
   * was copied from, so an app update that changes the bundled agent can say
   * the copy is based on an older version.
   */
  basedOn: z.string().optional(),
  prompt: z.string().optional(),
  tools: ToolsSchema.optional(),
  temperature: TemperatureSchema.optional(),
  task: DocumentTaskInputSchema.optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
