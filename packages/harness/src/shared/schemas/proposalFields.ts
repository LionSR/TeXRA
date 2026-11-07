import { Schema, Struct } from 'effect';

import { AgentConfigSchema } from './agentConfig';
import { NullableFileFieldsSchema } from './fileFields';
import { JsonValueSchema } from './jsonValue';

export const BaseProposalFieldsSchema = Schema.Struct({
  // The agent's resolved source and inline persona, its memories and its
  // working directory, as the run they propose will record them.
  ...Struct.pick(AgentConfigSchema.fields, [
    'agentSource',
    'persona',
    'memories',
    'workingDirectory',
  ]),
  // Named in full by every proposal: no launch default applies.
  agent: Schema.String,
  model: Schema.String,
  instruction: Schema.String,
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

export interface ProposalFileGroup {
  label: string;
  files: readonly string[];
  /** When false, files are virtual paths that should not be opened via workspace file commands. */
  clickable: boolean;
}

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
