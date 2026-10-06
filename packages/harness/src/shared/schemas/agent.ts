import { z } from 'zod';

import { ToolDefinitionSchema, type ToolDefinition } from './toolDefinition';

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  /** Shipped with TeXRA: the bundled agent directories and those of the
   *  first-party plugins that are on. */
  BUILT_IN: 'builtIn',
  /** An installed Claude Code or Codex plugin's agent, named `<plugin>:<name>`. */
  PLUGIN: 'plugin',
  /** A persona the launch carries (`AgentConfig.persona`): no file, no root. */
  INLINE: 'inline',
} as const;

/** Single source of truth for agent source identifiers. */
export const AgentSourceSchema = z.enum(AGENT_SOURCE);

export type AgentSource = z.infer<typeof AgentSourceSchema>;

/**
 * True for the sources whose definitions are read in place and are not the
 * user's to edit: the bundled one, and an installed
 * plugin's. Every surface that offers to open one presents it read-only and
 * points edits at the custom copy; the extension additionally registers the
 * bundled directories `writable: false` for its file tools.
 */
export function isPackagedAgentSource(source: AgentSource): boolean {
  return source === AGENT_SOURCE.BUILT_IN || source === AGENT_SOURCE.PLUGIN;
}

const AGENT_NAME_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(AGENT_NAME_IDENTIFIER, {
    message:
      'Agent names must be identifiers: letters, numbers, underscores, or hyphens.',
  });

/** An agent's name as the catalog lists it: its own, or `<plugin>:<name>`
 *  for an installed plugin's agent. A definition names itself bare. */
const CatalogAgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?:[a-z0-9][a-z0-9-]*:)?[A-Za-z0-9][A-Za-z0-9_-]*$/u, {
    message:
      'Agent names must be identifiers (letters, numbers, underscores, or hyphens), optionally after a plugin name and a colon.',
  });

/**
 * Base schema for agent identity metadata shared across all agent representations.
 * View-specific schemas (AgentSelectionItemSchema, etc.)
 * should extend this via `.extend()` rather than redefining these fields.
 */
export const AgentMetadataBaseSchema = z.object({
  name: CatalogAgentNameSchema,
  /** Its file has a `task` block: it is also launchable as a document task. */
  hasTask: z.boolean(),
  description: z.string().optional(),
});

/** Canonical key format: disambiguates agents with same name across sources. */
export function agentKey(source: string, name: string): string {
  return `${source}:${name}`;
}

/**
 * Canonical key for an agent-like record. Single source for the "entry → key"
 * mapping so the dozen-plus call sites don't each spell out
 * `agentKey(x.source, x.name)`.
 */
export function agentKeyOf(entry: { source: string; name: string }): string {
  return agentKey(entry.source, entry.name);
}

/**
 * The agent name in an identifier: a source-qualified key's name
 * ("plugin:paper:review" → "paper:review", "custom:x" → "x"), or the
 * identifier itself when it names no source ("paper:review", or a URL).
 */
export function agentName(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 && AgentSourceSchema.safeParse(key.slice(0, idx)).success
    ? key.slice(idx + 1)
    : key;
}

/**
 * The agent name in an identifier as one file-name segment: a plugin
 * agent's `<plugin>:<name>` becomes `<plugin>__<name>`, since `:` is not a
 * file-name character on every platform. Run packs, run directories and
 * copy stems derive their names through this alone.
 */
export function agentFileName(key: string): string {
  return agentName(key).replaceAll(':', '__');
}

/** Match bare names by name and source-qualified keys by exact identity. */
export function agentMatchesIdentifier(
  entry: { source: string; name: string },
  identifier: string,
): boolean {
  const name = agentName(identifier);
  return identifier === name
    ? entry.name === name
    : agentKeyOf(entry) === identifier;
}

/** A custom-agent YAML file the registry found but could not load. */
export const AgentScanIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type AgentScanIssue = z.infer<typeof AgentScanIssueSchema>;

// ------------------------------------------------- the definition format
// An agent definition, the one format a persona is written in: a YAML file
// in an agent directory, or an embedder's inline persona, which a run's
// config records (`AgentConfig.persona`).

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
/** A persona with its defaults applied: what a run is offered and told. */
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
/** A document task with its defaults applied. */
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
/** An agent definition as written, before inheritance and defaults. */
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * A persona an embedder passes inline (`StartInput.agent`) instead of a
 * file: the same definition with nothing a file alone can mean. It has no
 * sibling to inherit from and no bundled original, and a document task is
 * the app's recipe, which the package does not ship; each is refused as an
 * unrecognized key.
 */
export const InlinePersonaSchema = AgentDefinitionSchema.omit({
  inherits: true,
  basedOn: true,
  task: true,
}).extend({
  /** The tools it is offered, by name, as a file names them: what the run
   *  records is plain data, never a runtime tool definition. */
  tools: z.array(z.string().min(1)).optional(),
});
/** An inline persona as an embedder writes it (before defaults). */
export type InlinePersona = z.input<typeof InlinePersonaSchema>;
