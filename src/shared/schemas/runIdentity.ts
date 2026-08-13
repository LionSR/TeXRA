import { z } from 'zod';

// Local imports
import { getCleanAgentName } from './agent';

/**
 * What kind of thing owns a stream, declared once at the launch site and
 * persisted once by `registerExecution` (`ExecutionMeta.identity`). The struct
 * itself travels — on `run.start`, on `StreamTabInfo`, on roster rows — and
 * hosts add display fields beside it, never re-encodings of it.
 *
 * This is NOT `AgentCategory`: category is the agent's execution-mode fact
 * with its `setting → config` authority chain, and only `kind: 'agent'` runs
 * have one at all.
 */
export const RunIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    /** The run config's agent identifier, possibly source-qualified
     * ("custom:name") — the same value `AgentConfig.agent` carries. */
    agent: z.string().min(1),
    /** External CLI driving this agent ("codex", "claude_code"); absent for native. */
    tool: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('process'), tool: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('multiAgentWorkflow'),
    workflowName: z.string().min(1),
  }),
]);

export type RunIdentity = z.infer<typeof RunIdentitySchema>;

/** Whether an identity denotes a native agent rather than an external CLI. */
export function isPlainAgentIdentity(
  identity: RunIdentity | null | undefined,
): boolean {
  return identity?.kind === 'agent' && identity.tool === undefined;
}

/** The identity's display name — what a listing row or tab label leads with. */
export function runIdentityName(id: RunIdentity): string {
  switch (id.kind) {
    case 'agent':
      return id.agent;
    case 'process':
      return id.tool;
    case 'multiAgentWorkflow':
      return id.workflowName;
  }
}

/** UI label for a run identity — strips a known source prefix from agent ids. */
export function runIdentityDisplayName(id: RunIdentity): string {
  return getCleanAgentName(runIdentityName(id));
}
