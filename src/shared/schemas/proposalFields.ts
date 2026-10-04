import { z } from 'zod';

import { AgentSourceSchema } from './agent';
import { NullableFileFieldsSchema } from './fileFields';
import { ToolConfigSchema } from './toolConfig';

export const BaseProposalFieldsSchema = z.object({
  agent: z.string(),
  /**
   * Resolved source of `agent`, captured when the delegation is validated so
   * launch pins the exact `(source, name)` entry rather than re-resolving an
   * ambiguous bare name. Mirrors `agentSource` on the agent config payload.
   */
  agentSource: AgentSourceSchema.nullish(),
  model: z.string(),
  instruction: z.string(),
  /** Memory file paths (display paths like /memories/foo.md) attached to this delegation. */
  memories: z.array(z.string()).prefault([]),
  /** Working directory override (e.g. a git worktree path). */
  workingDirectory: z.string().nullish(),
  /**
   * The script whose `agent` calls one request approves together: its
   * title, its source, and the calls it had issued when it asked. The
   * proposal's other fields are its first `agent` call's.
   */
  script: z
    .strictObject({
      title: z.string().nullable(),
      source: z.string(),
      calls: z.array(
        z.strictObject({ toolName: z.string(), preview: z.string() }),
      ),
    })
    .nullish(),
});

/** A document task's files and the tool configuration its options give it;
 *  empty on a chat delegation. */
export const TaskProposalFieldsSchema = NullableFileFieldsSchema.omit({
  editedFile: true,
}).extend({ toolConfig: ToolConfigSchema });

/** File fields shape consumed by {@link getProposalFileGroups} — the helper
 *  behind every proposal file list (tool-row model, ProposalRequestPanel,
 *  CLI AgentProposal modal, approval summaries). */
interface FileFields {
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

export function getProposalFileGroups(data: FileFields): ProposalFileGroup[] {
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

/** What a proposal launches, as its approval copy names it. */
export function agentProposalLabel(proposal: {
  readonly task: boolean;
}): string {
  return proposal.task ? 'document task' : 'agent';
}
