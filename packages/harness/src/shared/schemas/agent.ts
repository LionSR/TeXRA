import { Effect, Result, Schema, SchemaGetter, Struct } from 'effect';

import { ToolDefinitionSchema, type ToolDefinition } from './toolDefinition';

export const AGENT_SOURCE = {
  CUSTOM: 'custom',
  /** Shipped with the host: the bundled agent directories and those of the
   *  first-party plugins that are on. */
  BUILT_IN: 'builtIn',
  /** An installed Claude Code or Codex plugin's agent, named `<plugin>:<name>`. */
  PLUGIN: 'plugin',
  /** A persona the launch carries (`AgentConfig.persona`): no file, no root. */
  INLINE: 'inline',
} as const;

/** Single source of truth for agent source identifiers. */
export const AgentSourceSchema = Schema.Enum(AGENT_SOURCE);

export type AgentSource = typeof AgentSourceSchema.Type;

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

export const AgentNameSchema = Schema.Trim.check(Schema.isMinLength(1)).check(
  Schema.isPattern(AGENT_NAME_IDENTIFIER),
);

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
  return idx >= 0 &&
    Result.isSuccess(
      Schema.decodeUnknownResult(AgentSourceSchema)(key.slice(0, idx)),
    )
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
export const AgentScanIssueSchema = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
export type AgentScanIssue = typeof AgentScanIssueSchema.Type;

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
const ToolsSchema = Schema.Array(
  Schema.Union([
    ToolDefinitionSchema,
    Schema.String.pipe(
      Schema.decodeTo(ToolDefinitionSchema, {
        decode: SchemaGetter.transform((name): ToolDefinition => ({ name })),
        encode: SchemaGetter.transform((tool) => tool.name),
      }),
    ),
  ]),
);

/** A persona's sampling temperature; the model's own range is narrower. */
const TemperatureSchema = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
).check(Schema.isLessThanOrEqualTo(1));

/**
 * A persona: a model agent, its system prompt (Nunjucks) with the tools it
 * is offered. A persona that declares no tools works text-only. The user's
 * task is the user message, so a persona has no request template.
 */
export const PersonaSchema = Schema.Struct({
  prompt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  tools: ToolsSchema.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  temperature: TemperatureSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(1.0)),
  ),
});
/** A persona with its defaults applied: what a run is offered and told. */
export type Persona = typeof PersonaSchema.Type;

/**
 * An agent file as written: a flat persona. A plugin may own one more
 * top-level block (`AgentBlock`), which the catalog scan adds to this
 * schema; an agent carrying one is a task.
 */
export const AgentDefinitionSchema = Schema.Struct({
  name: AgentNameSchema,
  description: Schema.optional(Schema.String),
  /**
   * On a customized copy of a bundled agent: the digest of the bundled file it
   * was copied from, so an app update that changes the bundled agent can say
   * the copy is based on an older version.
   */
  basedOn: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  tools: Schema.optional(ToolsSchema),
  temperature: Schema.optional(TemperatureSchema),
});
/** An agent definition as written, before defaults. */
export type AgentDefinition = typeof AgentDefinitionSchema.Type;

/**
 * A persona an embedder passes inline (`StartInput.agent`) instead of a
 * file: the same definition with nothing a file alone can mean. It has no
 * bundled original and no plugin's block (a task is its plugin's recipe);
 * each is refused as an unrecognized key.
 */
export const InlinePersonaSchema = AgentDefinitionSchema.mapFields(
  Struct.omit(['basedOn']),
).mapFields(
  Struct.assign({
    /** The tools it is offered, by name, as a file names them: what the run
     *  records is plain data, never a runtime tool definition. */
    tools: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMinLength(1))),
    ),
  }),
);
/** An inline persona as an embedder writes it (before defaults). */
export type InlinePersona = typeof InlinePersonaSchema.Encoded;
