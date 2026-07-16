import { z } from 'zod';

import { AgentCategory, AgentSourceSchema } from './agent';
import { requiredFileListFields } from './fileFields';
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
});

const FileFieldsSchema = z.object(requiredFileListFields);

export const WorkflowSpecificFieldsSchema = FileFieldsSchema.extend({
  toolConfig: ToolConfigSchema,
});

const ProposalFileFieldsSchema = FileFieldsSchema.extend({
  memories: z.array(z.string()),
});

/** File fields shape used by all three rendering sites (toolFormatters, RequestPanels, PermissionCard). */
type FileFields = Partial<z.infer<typeof ProposalFileFieldsSchema>>;

export interface ProposalFileGroup {
  label: string;
  files: string[];
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

export function agentProposalCategoryLabel(
  agentCategory: AgentCategory,
): string {
  return agentCategory === AgentCategory.Workflow
    ? 'workflow agent'
    : 'tool-use agent';
}
