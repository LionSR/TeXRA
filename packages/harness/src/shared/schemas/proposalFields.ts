import { Effect, Schema, Struct } from 'effect';

import { AgentSourceSchema, InlinePersonaSchema } from './agent';
import { NullableFileFieldsSchema } from './fileFields';
import { JsonValueSchema } from './jsonValue';

/**
 * What every delegation proposal names, chat or task: the agent (with its
 * resolved source, or an inline persona), the model, the instruction, the
 * memory files it carries, a working directory override, and the script whose
 * calls the request approves together. The delegation tools build it; an agent
 * proposal request and the launched run's config both carry it.
 */
export const BaseProposalFieldsSchema = Schema.Struct({
  agent: Schema.String,
  /**
   * Resolved source of `agent`, captured when the delegation is validated so
   * launch pins the exact `(source, name)` entry rather than re-resolving an
   * ambiguous bare name. Mirrors `agentSource` on the agent config payload.
   */
  agentSource: Schema.optional(Schema.NullOr(AgentSourceSchema)),
  /** An agent the call defines (`agentSource` inline): what it is told and
   *  the tools it asks for, shown to whoever approves it. */
  persona: Schema.optional(Schema.NullOr(InlinePersonaSchema)),
  model: Schema.String,
  instruction: Schema.String,
  /** Memory file paths (display paths like /memories/foo.md) attached to this delegation. */
  memories: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Working directory override (e.g. a git worktree path). */
  workingDirectory: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * The script whose `agent` calls one request approves together: its
   * title, its source, and the calls it had issued when it asked. The
   * proposal's other fields are its first `agent` call's.
   */
  script: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        title: Schema.NullOr(Schema.String),
        source: Schema.String,
        calls: Schema.Array(
          Schema.Struct({ toolName: Schema.String, preview: Schema.String }),
        ),
      }),
    ),
  ),
});

/** A task's files and the options its launching plugin gives it (as the
 *  plugin reads them; the harness reads nothing inside); a chat delegation
 *  has no files and no options. */
export const TaskProposalFieldsSchema = NullableFileFieldsSchema.mapFields(
  Struct.omit(['editedFile']),
).mapFields(
  Struct.assign({
    options: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, JsonValueSchema)),
    ),
  }),
);

/** File fields shape consumed by {@link getProposalFileGroups} — the helper
 *  behind every proposal file list (tool-row model, ProposalRequestPanel,
 *  CLI AgentProposal modal, approval summaries). */
export interface ProposalFileFields {
  readonly inputFiles?: readonly string[];
  readonly contextFiles?: readonly string[];
  readonly mediaFiles?: readonly string[];
  readonly outputFiles?: readonly string[];
  readonly memories?: readonly string[];
}

/**
 * One labelled group of a proposal's files as a file list shows it: input,
 * context, media, output or memory paths.
 */
export interface ProposalFileGroup {
  label: string;
  files: readonly string[];
  /** When false, files are virtual paths that should not be opened via workspace file commands. */
  clickable: boolean;
}

/**
 * Group a proposal's file fields for display, in the fixed order input,
 * context, media, output, memories, leaving out the empty groups. Memory paths
 * are virtual and marked not clickable.
 */
export function getProposalFileGroups(
  data: ProposalFileFields,
): ProposalFileGroup[] {
  return [
    {
      label: 'Input',
      files: data.inputFiles ?? [],
      clickable: true,
    },
    {
      label: 'Context',
      files: data.contextFiles ?? [],
      clickable: true,
    },
    {
      label: 'Media',
      files: data.mediaFiles ?? [],
      clickable: true,
    },
    { label: 'Output', files: data.outputFiles ?? [], clickable: true },
    { label: 'Memories', files: data.memories ?? [], clickable: false },
  ].filter((g) => g.files.length > 0);
}
