/** Shared canonical configuration schema for runtime and persisted events. */
import { Effect, Schema, Struct } from 'effect';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/defaultModels';
import { AgentSourceSchema, InlinePersonaSchema } from './agent';
import { AgentDelegationScopeSchema } from './workspaceAgents';
import { NullableFileFieldsSchema } from './fileFields';
import { JsonValueSchema } from './jsonValue';

/** Agent selected when launch input names none. */
export const DEFAULT_WORKFLOW_AGENT = 'correct';

/**
 * Fields a command-line launch sets, grouped so their footprint on
 * `AgentConfig` is self-evident at the schema level. Absent for runs a host
 * launches from a view.
 */
const CliOutputFieldsSchema = Schema.Struct({
  /** Workspace file the run's output is copied to, kept for resume. */
  outputFile: Schema.optional(Schema.NullOr(Schema.String)),
  /** Workspace directory the run's output files are copied to. */
  outputDirectory: Schema.optional(Schema.NullOr(Schema.String)),
  /** Relative artifacts expected under {@link CliOutputFieldsSchema.outputDirectory}. */
  expectedOutputFiles: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)),
  ),
  /**
   * Team preset id this run was launched from (a CLI team command, or a
   * view's team launcher, so resume retains team identity). Used so a team
   * run, whose root is an orchestrator agent, is not inferred as the default
   * agent for a plain chat session. Preserved across resume.
   */
  teamId: Schema.optional(Schema.NullOr(Schema.String)),
});

/** What every script a run opens on records: its source, title, the tools
 *  it is offered, and its wall-clock limit. */
const ScriptFieldsSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.String.check(Schema.isMinLength(1)),
  /** The tools the run offers the script, by name. */
  tools: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  /** The script's wall-clock limit, when it set one. */
  timeoutMs: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  ),
});

/** A run's launch configuration, as its `run.config` row records it. */
const AgentConfigObjectSchema = NullableFileFieldsSchema.mapFields(
  Struct.assign({
    agent: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKFLOW_AGENT)),
    ),
    /**
     * Resolved source of `agent`. A boundary that validated the agent pins it;
     * launch (`prepareAgentDefinition`) stamps the entry it resolved, so every
     * run record carries it. Launch, resume, rerun and the remote checks read
     * this instead of re-resolving the ambiguous bare name. Absent only on a
     * payload not yet launched, which launch resolves by name.
     */
    agentSource: Schema.optional(Schema.NullOr(AgentSourceSchema)),
    /**
     * The persona the launch carried instead of naming a file (source
     * `inline`), named `agent`; recorded so a resume runs it with no file.
     */
    persona: Schema.optional(Schema.NullOr(InlinePersonaSchema)),
    /**
     * A `self()` child: it runs as its caller, so it is offered the installed
     * plugins' tools as a top-level run is, still narrowed to what its
     * caller's step offered.
     */
    asCaller: Schema.optional(Schema.NullOr(Schema.Boolean)),
    model: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_MODEL)),
    ),
    instruction: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed('')),
    ),
    /** Original user instruction preserved across nested tool-use delegation. */
    rootUserInstruction: Schema.optional(Schema.NullOr(Schema.String)),
    /** Optional user-facing text for logs when instruction contains hidden context. */
    displayInstruction: Schema.optional(Schema.NullOr(Schema.String)),
    /** Memory display paths attached to this delegation (e.g. /memories/conventions.md). */
    memories: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    /** Working directory override for subagent tool calls (e.g. a git worktree). */
    workingDirectory: Schema.optional(Schema.NullOr(Schema.String)),
    /** CLI-only fields, absent for extension/desktop-launched runs. */
    cli: Schema.optional(Schema.NullOr(CliOutputFieldsSchema)),
    /** Run-scoped delegation agent list used by team runs and their children. */
    delegationAgentScope: Schema.optional(
      Schema.NullOr(AgentDelegationScopeSchema),
    ),
    /**
     * JSON Schema (a plain object) describing a structured output the agent must
     * submit through the synthetic `submit_output` terminal tool. Serializable by
     * design: a live schema or ITool must never travel through config. Absent
     * for ordinary runs.
     */
    outputSchema: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    ),
    /**
     * The `script` call this run makes instead of asking its model: it opens
     * with that call as its one response, offers exactly `tools`, and ends when
     * the call settles. A script a parent sent to the background, or a
     * task's recipe. Absent for every other run.
     */
    script: Schema.optional(
      Schema.NullOr(
        Schema.Union([
          /** The parent's model wrote it and sent it to the background; the run
           *  is that script, and its `agent` calls propose themselves. */
          ScriptFieldsSchema.mapFields(
            Struct.assign({ kind: Schema.Literal('background') }),
          ),
          /** A plugin wrote it: a task's recipe. The run is its agent's, and its
           *  `agent` calls were approved with its launch. */
          ScriptFieldsSchema.mapFields(
            Struct.assign({
              kind: Schema.Literal('recipe'),
              /** The agent-file block (`AgentBlock.key`) whose task it runs. */
              block: Schema.String.check(Schema.isMinLength(1)),
              /** The launch's options for that task, as its plugin reads them
               *  (the switches that plugin defines). */
              options: Schema.Record(Schema.String, JsonValueSchema),
            }),
          ),
        ]),
      ),
    ),
  }),
);

/** Canonical configuration: at most as many outputs as text/media inputs, and
 *  a persona exactly when the agent is inline, named as the agent is. */
export const AgentConfigSchema = AgentConfigObjectSchema.check(
  Schema.makeFilter((config) => {
    const issues: Schema.FilterIssue[] = [];
    if (
      (config.agentSource === 'inline') !== (config.persona != null) ||
      (config.persona != null && config.persona.name !== config.agent)
    ) {
      issues.push({
        path: ['persona'],
        issue:
          'An inline agent carries its persona, named as the agent, and only it does.',
      });
    }
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
