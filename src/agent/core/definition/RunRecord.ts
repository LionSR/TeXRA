import { z } from 'zod';

import { AgentConfigSchema, type AgentConfig } from './AgentConfig';

/**
 * Honest persisted record for a non-agent run (`identity.kind` 'process' or
 * 'multiAgentWorkflow'): only the facts such a run actually has. No
 * `agentCategory` (a shell command has no execution mode), no fabricated
 * default model, no tool-permission object.
 */
const NonAgentRunRecordSchema = z.strictObject({
  /** What launched: the command's tool name or the workflow's name. */
  name: z.string().min(1),
  /** The command line (process) or a human-readable launch summary. */
  instruction: z.string(),
  workingDirectory: z.string().optional(),
  /** Real model backing the run's agent steps, when one exists. */
  model: z.string().optional(),
});

/**
 * The one persisted shape of `executions/{id}/config.json`: a real
 * `AgentConfig` for agent runs, the honest minimal record for everything
 * else. The strict non-agent arm parses first — `AgentConfigSchema`'s
 * prefaults would otherwise fabricate an agent config out of any object.
 * Pre-consolidation non-agent rows persisted a fabricated `AgentConfig`;
 * they keep parsing on the agent arm, and their fabricated fields stay
 * suppressed by identity-keyed display code.
 */
export const RunRecordSchema = z.union([
  NonAgentRunRecordSchema,
  AgentConfigSchema,
]);

export type RunRecord = z.infer<typeof RunRecordSchema>;

export function isAgentRunRecord(record: RunRecord): record is AgentConfig {
  return 'agentCategory' in record;
}
