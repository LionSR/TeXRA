/** Shared canonical configuration schema for runtime and persisted events. */
import { Schema, Struct } from 'effect';
import { decodingDefault } from './schemaDefaults.js';

import { ActivatedSkillsSchema } from './activeSkills';
import { FileFieldsSchema } from './fileFields';

/** A run's sampling temperature; the model's own range is narrower. */
export const TemperatureSchema = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
).check(Schema.isLessThanOrEqualTo(1));

/** What Windows rejects in a file name, besides control characters. */
const UNSAFE_FILE_NAME_CHARACTERS = '<>:"/\\|?*';
/** Windows' device names, which no file may take, with or without an
 *  extension. */
const RESERVED_FILE_NAME =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;
/** The longest segment a label gives, in code points. */
const LABEL_FILE_NAME_MAX = 80;

/**
 * A run's display name as one file-name segment, safe on every platform.
 * A label is free text (a model writes a child's), so a path separator,
 * a character Windows rejects or a control character becomes `_`; leading
 * dots and spaces go (no `..`, no hidden file), and trailing ones, which
 * Windows drops; a device name gets a leading `_`; the result is at most
 * {@link LABEL_FILE_NAME_MAX} code points, and `run` when nothing is left.
 * Every file or folder named for a run takes its label through this alone.
 */
export function labelFileName(label: string): string {
  const replaced = [...label]
    .map((char) =>
      char.charCodeAt(0) < 0x20 ||
      char === '\u007f' ||
      UNSAFE_FILE_NAME_CHARACTERS.includes(char)
        ? '_'
        : char,
    )
    .join('')
    .replace(/^[.\s]+/u, '');
  const segment = [...replaced]
    .slice(0, LABEL_FILE_NAME_MAX)
    .join('')
    .replace(/[.\s]+$/u, '');
  if (segment === '') return 'run';
  return RESERVED_FILE_NAME.test(segment) ? `_${segment}` : segment;
}

/** A run's launch configuration, as its `run.config` row records it. */
const AgentConfigObjectSchema = FileFieldsSchema.mapFields(
  Struct.assign({
    /** The run's display name: what its card, the listings and its run
     *  directory show. The launch names it; nothing resolves it. */
    label: Schema.String,
    /** The run's own system text, before what the harness appends (project
     *  instructions, memories, tool-use instructions, plugin sections). */
    system: decodingDefault(Schema.String, ''),
    /** The tools the run declares, by name; `mcp__<server>__*` is every
     *  tool that server lists. A run that declares none writes text only. */
    tools: decodingDefault(Schema.Array(Schema.NonEmptyString), []),
    temperature: decodingDefault(TemperatureSchema, 1.0),
    /**
     * Which tools join the ones the run declares, decided by its launch.
     * Absent: a top-level run is offered the plugins' injected tools and the
     * installed plugins' tools, a child the injected tools only.
     * `declared`: none join (an installed plugin's agent that names its
     * tools gets exactly those). `topLevel`: both join wherever it runs (a
     * `self()` child, which runs as its caller; an installed plugin's agent
     * that names no tools, which inherits them as a Claude Code subagent
     * does). A script's run and a run that declares no tools are offered no
     * injected tool either way.
     */
    toolScope: Schema.optional(Schema.Literals(['declared', 'topLevel'])),
    model: Schema.String,
    instruction: decodingDefault(Schema.String, ''),
    /** Original user instruction preserved across nested tool-use delegation.
     *  Set or absent, never null: no producer writes one. */
    rootUserInstruction: Schema.optional(Schema.String),
    /** Optional user-facing text for logs when instruction contains hidden context. */
    displayInstruction: Schema.optional(Schema.String),
    /** Memory display paths attached to this delegation (e.g. /memories/conventions.md). */
    memories: decodingDefault(Schema.Array(Schema.String), []),
    /**
     * The skills the user activated for `instruction`, which stays as typed:
     * the run's first message leads with their activation blocks, and its
     * opening records them. A child or a script run takes none.
     */
    skills: Schema.optional(ActivatedSkillsSchema),
    /** Working directory override for subagent tool calls (e.g. a git worktree). */
    workingDirectory: Schema.optional(Schema.String),
    /**
     * What the launching app records about its own launch (where a command
     * line copies the output) and reads back on resume. The harness never
     * reads it, and a child run does not inherit it; each owner decodes its
     * own keys.
     */
    launch: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    /**
     * JSON Schema (a plain object) describing a structured output the agent must
     * submit through the synthetic `submit_output` terminal tool. Serializable by
     * design: a live schema or ITool must never travel through config. Absent
     * for ordinary runs.
     */
    outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /**
     * What a run does instead of asking its model: it opens with one
     * `script` call as its one response and ends when that call does. A
     * script a parent sent to the background, or a plugin's program. Absent
     * for every other run.
     */
    script: Schema.optional(
      Schema.Union([
        /** The parent's model wrote it and sent it to the background; the run
         *  is that script, and its `agent` calls propose themselves. */
        Schema.Struct({
          kind: Schema.Literal('background'),
          code: Schema.NonEmptyString,
          title: Schema.NonEmptyString,
          /** The tools the run offers the script, by name. */
          tools: Schema.Array(Schema.NonEmptyString),
          /** The script's wall-clock limit, when it set one. */
          timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
        }),
        /** A plugin's program, by the name its plugin registers it under
         *  (`Plugin.programs`): the run's script imports that module and
         *  calls its default export with `args` and the run's instruction
         *  and files. The registration lists
         *  its tools, and its `agent` calls were approved with its launch. */
        Schema.Struct({
          kind: Schema.Literal('program'),
          name: Schema.NonEmptyString,
          args: Schema.Record(Schema.String, Schema.Json),
        }),
      ]),
    ),
  }),
);

/** Canonical configuration: at most as many outputs as text/media inputs. */
export const AgentConfigSchema = AgentConfigObjectSchema.check(
  Schema.makeFilter((config) => {
    const issues: Schema.FilterIssue[] = [];
    if (
      config.outputFiles.length >
      config.inputFiles.length + config.mediaFiles.length
    ) {
      issues.push({
        path: ['outputFiles'],
        issue:
          'Number of output files must not exceed the number of text and media input files.',
      });
    }
    return issues;
  }),
);
export type AgentConfigInput = typeof AgentConfigObjectSchema.Encoded;

export type AgentConfig = typeof AgentConfigSchema.Type;

/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'label' | 'model'>;
