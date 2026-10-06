/** Shared canonical configuration schema for runtime and persisted events. */
import { z } from 'zod';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/defaultModels';
import { AgentSourceSchema, InlinePersonaSchema } from './agent';
import { AgentDelegationScopeSchema } from './workspaceAgents';
import { NullableFileFieldsSchema } from './fileFields';
import { ToolConfigSchema } from './toolConfig';

/** Agent selected when launch input names none. */
export const DEFAULT_WORKFLOW_AGENT = 'correct';

/**
 * CLI-only fields, grouped so the CLI-specific footprint of `AgentConfig`
 * is self-evident at the schema level. Absent for extension/desktop-launched
 * runs.
 */
const CliOutputFieldsSchema = z.object({
  /** Workspace copy target for `texra run --output`, preserved for resume. */
  outputFile: z.string().nullish(),
  /** Workspace copy directory for `texra run --output-dir`. */
  outputDirectory: z.string().nullish(),
  /** Relative artifacts expected under {@link CliOutputFieldsSchema.outputDirectory}. */
  expectedOutputFiles: z.array(z.string()).nullish(),
  /**
   * Team preset id this run was launched from (`texra team run
   * <preset>` in the CLI; the main-view launcher also sets it for team runs so
   * resume retains team identity). Used so a team run — whose root is an
   * orchestrator agent — is not inferred as the default agent for a plain
   * `texra chat` session. Preserved across resume.
   */
  teamId: z.string().nullish(),
});

/** A run's launch configuration, as its `run.config` row records it. */
const AgentConfigObjectSchema = NullableFileFieldsSchema.extend({
  agent: z.string().prefault(DEFAULT_WORKFLOW_AGENT),
  /**
   * Resolved source of `agent`. A boundary that validated the agent pins it;
   * launch (`prepareAgentDefinition`) stamps the entry it resolved, so every
   * run record carries it. Launch, resume, rerun and the remote checks read
   * this instead of re-resolving the ambiguous bare name. Absent only on a
   * payload not yet launched, which launch resolves by name.
   */
  agentSource: AgentSourceSchema.nullish(),
  /**
   * The persona the launch carried instead of naming a file (source
   * `inline`), named `agent`; recorded so a resume runs it with no file.
   */
  persona: InlinePersonaSchema.nullish(),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  instruction: z.string().prefault(''),
  /** Original user instruction preserved across nested tool-use delegation. */
  rootUserInstruction: z.string().nullish(),
  /** Optional user-facing text for logs when instruction contains hidden context. */
  displayInstruction: z.string().nullish(),
  editedFiles: z.array(z.string()).prefault([]),
  toolConfig: ToolConfigSchema,
  /** Memory display paths attached to this delegation (e.g. /memories/conventions.md). */
  memories: z.array(z.string()).prefault([]),
  /** Working directory override for subagent tool calls (e.g. a git worktree). */
  workingDirectory: z.string().nullish(),
  /** CLI-only fields, absent for extension/desktop-launched runs. */
  cli: CliOutputFieldsSchema.nullish(),
  /** Run-scoped delegation agent list used by team runs and their children. */
  delegationAgentScope: AgentDelegationScopeSchema.nullish(),
  /**
   * JSON Schema (a plain object) describing a structured output the agent must
   * submit through the synthetic `submit_output` terminal tool. Serializable by
   * design: a live Zod schema or ITool must never travel through config. Absent
   * for ordinary runs.
   */
  outputSchema: z.record(z.string(), z.unknown()).nullish(),
  /**
   * The `script` call this run makes instead of asking its model: it opens
   * with that call as its one response, offers exactly `tools`, and ends when
   * the call settles. A script a parent sent to the background, or a
   * document task's recipe. Absent for every other run.
   */
  script: z
    .strictObject({
      code: z.string().min(1),
      title: z.string().min(1),
      /** The tools the run offers the script, by name. */
      tools: z.array(z.string().min(1)),
      /** The script's wall-clock limit, when it set one. */
      timeoutMs: z.int().positive().nullish(),
      /** Who wrote it. `background`: the parent's model, sent to the
       *  background; the run is that script, and its `agent` calls propose
       *  themselves. `recipe`: the app (a document task's recipe); the run
       *  is its agent's, and its `agent` calls were approved with its
       *  launch. */
      kind: z.enum(['background', 'recipe']),
    })
    .nullish(),
});

/** Canonical current configuration: at most as many outputs as inputs, and
 *  a persona exactly when the agent is inline, named as the agent is. */
export const AgentConfigFieldsSchema = AgentConfigObjectSchema.superRefine(
  (config, ctx) => {
    if (
      (config.agentSource === 'inline') !== (config.persona != null) ||
      (config.persona != null && config.persona.name !== config.agent)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['persona'],
        message:
          'An inline agent carries its persona, named as the agent, and only it does.',
      });
    }
    if (config.outputFiles.length > config.inputFiles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputFiles'],
        message:
          'Number of output files must not be greater than the number of input files.',
      });
    }
  },
);
export type AgentConfigInput = z.input<typeof AgentConfigObjectSchema>;
