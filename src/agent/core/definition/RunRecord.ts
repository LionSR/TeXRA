import { z } from 'zod';

import { NonAgentRunRecordSchema } from '@shared/schemas';
import { AgentConfigSchema, type AgentConfig } from './AgentConfig';

/**
 * The canonical run configuration: a real
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
